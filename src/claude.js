// "Ask Claude": runs the designer's own `claude` CLI headless (`claude -p`)
// in the app folder, under their own Claude subscription login.
//
// The run is fenced in:
//   - dontAsk permission mode: anything not explicitly allowed is denied.
//   - Allowed: Read/Edit/Glob/Grep scoped to the app folder (./**). No shell,
//     no new files, no web, no subagents, no MCP servers.
//   - Only project settings load: the user's personal and local settings can
//     grant extra permissions (shell commands, other folders) not meant for
//     this.
//   - A minimal environment: API keys in the editor's environment would take
//     precedence over the subscription login in -p mode, and a parent Claude
//     session's variables would leak into the child.
// Whatever the agent manages to change is found afterwards by comparing the
// folder before and after, so the change log never depends on its own report.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ENV_KEEP = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
const TEXT_EXT = /\.(jsx?|tsx?|css|scss|html|json|md)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const MAX_FILE = 512 * 1024;

export const RULES = `You are making a visual change for a UX designer, through a visual editor on a running React + Mantine app.
- Make the smallest change that does what they asked, in the existing code. Don't refactor, rename, reformat or "improve" anything else.
- Prefer Mantine style props and the theme's tokens (spacing/radius/font sizes xs-xl, theme colours like "blue.6") over raw CSS or pixel values. Use a custom value only when no token fits.
- Change only how things look and read: layout, spacing, size, colour, typography, wording and order. Don't change data fetching, state, routing, permissions or other behaviour.
- Don't touch tests, config, package files, or the theme file, unless the request is explicitly about the app-wide theme.
- You can't create files or run commands.
- If the request is unclear, would need a developer's decision, or can't be done safely this way, change nothing and say why.
- Finish with one or two short sentences for the designer, in plain language and with no code, saying what you changed and where it shows up.`;

export function claudeArgs({ prompt, model }) {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk",
    "--allowedTools", "Read(./**)", "Edit(./**)", "Glob(./**)", "Grep(./**)",
    "--disallowedTools", "Bash", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent",
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--append-system-prompt", RULES,
  ];
  if (model) args.push("--model", model);
  return args;
}

export function childEnv(env = process.env) {
  const out = {};
  for (const k of ENV_KEEP) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

const short = (p, root) => {
  if (typeof p !== "string") return "";
  const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
  return rel.startsWith("..") ? p : rel;
};

/** One stream-json event → a progress line for the designer, or null. */
export function describeEvent(e, root) {
  if (e?.type === "assistant") {
    const lines = [];
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_use") {
        const i = c.input ?? {};
        if (c.name === "Read") lines.push(`Reading ${short(i.file_path, root)}`);
        else if (c.name === "Edit") lines.push(`Editing ${short(i.file_path, root)}`);
        else if (c.name === "Grep") lines.push(`Searching for “${i.pattern}”`);
        else if (c.name === "Glob") lines.push(`Looking for ${i.pattern}`);
        else lines.push(`Using ${c.name}`);
      } else if (c.type === "text" && c.text?.trim()) {
        lines.push(c.text.trim());
      }
    }
    return lines.length ? lines : null;
  }
  return null;
}

/**
 * Spawns one run. onEvent gets progress lines; the promise resolves with
 * { ok, text, denials, cost, error }. cancel() stops it.
 */
export function runClaude({ cwd, prompt, model, bin = "claude", timeoutMs = 5 * 60_000, onEvent = () => {} }) {
  let child;
  let cancelled = false;
  const done = new Promise((resolve) => {
    let final = null;
    let stderr = "";
    let buf = "";
    try {
      child = spawn(bin, claudeArgs({ prompt, model }), { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, error: `Couldn't start ${bin}: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { onEvent([`(unreadable output from claude: ${line.slice(0, 120)})`]); continue; }
        if (e.type === "result") final = e;
        const lines = describeEvent(e, cwd);
        if (lines) onEvent(lines);
      }
    });
    child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-4000); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.code === "ENOENT" ? `The claude command isn't installed (looked for "${bin}").` : e.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (cancelled) return resolve({ ok: false, cancelled: true, error: "Cancelled" });
      if (signal) return resolve({ ok: false, error: `Stopped after ${Math.round(timeoutMs / 60000)} minutes without finishing` });
      if (!final) {
        return resolve({ ok: false, error: explainFailure(stderr) || `claude exited with code ${code} and no result` });
      }
      resolve({
        ok: !final.is_error,
        text: typeof final.result === "string" ? final.result.trim() : "",
        denials: (final.permission_denials ?? []).map((d) => `${d.tool_name} ${short(d.tool_input?.file_path ?? d.tool_input?.path ?? "", cwd)}`.trim()),
        cost: final.total_cost_usd ?? null,
        error: final.is_error ? (final.result || final.subtype || "Claude reported an error") : null,
      });
    });
  });
  return {
    done,
    cancel() { cancelled = true; child?.kill("SIGTERM"); },
  };
}

function explainFailure(stderr) {
  const s = stderr.trim();
  if (!s) return "";
  if (/log ?in|not logged|authenticat|\/login/i.test(s)) {
    return "Claude isn't signed in on this computer. Open Terminal, run `claude`, sign in with your Claude account, then try again.";
  }
  return s.split("\n").slice(-3).join(" ").slice(0, 400);
}

/** `claude --version`, or null when the command isn't available. */
export function claudeVersion(bin = "claude") {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { env: childEnv(), timeout: 10_000 }, (err, out) => {
      resolve(err ? null : String(out).trim());
    });
  });
}

/** Text files under root (rel → content), to find what a run changed. */
export async function snapshot(root) {
  const files = new Map();
  const scan = async (dir) => {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await scan(abs);
      else if (TEXT_EXT.test(ent.name)) {
        const st = await fs.stat(abs);
        if (st.size <= MAX_FILE) files.set(path.relative(root, abs).split(path.sep).join("/"), await fs.readFile(abs, "utf8"));
      }
    }
  };
  await scan(root);
  return files;
}

/** Files whose content differs between two snapshots: [{ rel, before, after }]. */
export function diffSnapshots(before, after) {
  const out = [];
  for (const [rel, a] of after) {
    const b = before.get(rel);
    if (b === undefined) out.push({ rel, before: "", after: a, added: true });
    else if (a !== b) out.push({ rel, before: b, after: a });
  }
  for (const [rel, b] of before) if (!after.has(rel)) out.push({ rel, before: b, after: "", deleted: true });
  return out;
}
