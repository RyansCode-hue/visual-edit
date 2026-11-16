// Dev-server-only Vite plugin behind the visual editor.
//
// - Stamps JSX with source locations (dev transform only; disk never stamped).
// - Serves the editor shell at /__ve/ and injects the canvas script into the
//   app, which the shell loads in an iframe.
// - JSON API that reads and writes source, keeps a session change log, can
//   serve the pre-session version of every touched file ("show original"),
//   and commits the session to a review branch.
//
// The write API can modify any .jsx/.tsx file under the app root, so it is
// only registered for `vite serve`, only accepts JSON POSTs from the dev
// server's own origin, and rejects paths outside the root or in node_modules.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { stampJsx, inspect, applyEdit, applyMove, parseSource, EditError } from "./source.js";
import { readTheme, setThemeValue, isMantineComponent } from "./theme.js";
import { revertChange, slug } from "./changes.js";
import { countUsage } from "./usage.js";
import { buildPageGraph, pagesFor } from "./pages.js";
import { runClaude, claudeVersion, snapshot, diffSnapshots } from "./claude.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CANVAS_URL = "/@visual-edit/canvas.js";
const DATA_URL = "/@visual-edit/data.js";
const STATIC = {
  "": [here("./shell/index.html"), "text/html"],
  "shell.js": [here("./shell/shell.js"), "text/javascript"],
  "shell.css": [here("./shell/shell.css"), "text/css"],
  "tokens.js": [here("./shell/tokens.js"), "text/javascript"],
};
const API = "/__ve/";
const MAX_BODY = 64 * 1024;
const MAX_CHANGES = 200;
const execFileAsync = promisify(execFile);

function log(msg) {
  console.log(`\x1b[35m[visual-edit]\x1b[0m ${msg}`);
}

function parseId(id) {
  const m = /^(.+):(\d+):(\d+)$/.exec(id ?? "");
  if (!m) throw new EditError(`Bad element id: ${id}`);
  return { rel: m[1], line: Number(m[2]), column: Number(m[3]) };
}

function resolveSource(root, rel) {
  const abs = path.resolve(root, rel);
  if (
    !abs.startsWith(root + path.sep) ||
    abs.includes(`${path.sep}node_modules${path.sep}`) ||
    !/\.[jt]sx?$/.test(abs)
  ) {
    throw new EditError(`Refusing to touch ${rel}`, 403);
  }
  return abs;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new EditError("Body too large", 413));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new EditError("Body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function assertSameOrigin(req) {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new EditError("Expected application/json", 415);
  }
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    throw new EditError(`Cross-origin request from ${origin}`, 403);
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const cleanLabel = (label, fallback) =>
  typeof label === "string" && label.trim() ? label.trim().slice(0, 200) : fallback;

/**
 * @param {object} [opts]
 * @param {string} [opts.demoUser]      MFA-exempt login used by "Sign in as demo user"
 * @param {string} [opts.demoPassword]
 * @param {string} [opts.demoStart]     page to open after the demo login (default "/")
 * @param {boolean} [opts.allowPush]    let "Send for review" push and open a PR
 */
export default function visualEdit(opts = {}) {
  let root = "";
  let server = null;
  let apiTarget = null;
  let themeRel = null;

  // Session change log: { n, abs, rel, id, label, before, after, at }.
  const changes = [];
  let seq = 0;
  // Each touched file's content before its first change this session.
  const originals = new Map();
  // Touched files that already differed from git HEAD before this session;
  // "Send for review" commits whole files, so those edits would ride along.
  const dirtyBefore = new Set();
  let showOriginal = false;

  // Call before the first write to a file this session, while the file on
  // disk still holds only what was there before.
  async function noteFirstTouch(abs, rel) {
    if (originals.has(abs)) return;
    try {
      await git(["diff", "--quiet", "HEAD", "--", abs]);
    } catch (e) {
      if (e.code === 1) dirtyBefore.add(abs);
      else log(`couldn't check git status of ${rel}: ${e.message}`);
    }
  }

  // Reverted changes, newest last, for redo. Any new edit clears it.
  const redo = [];
  // Questions for developers, pinned to elements: { n, id, label, route, text, at }.
  const questions = [];
  let questionSeq = 0;

  function record(abs, rel, before, after, { id = null, label, keepRedo = false, pages = null }) {
    if (!originals.has(abs)) originals.set(abs, before);
    if (!keepRedo) redo.length = 0;
    changes.push({ n: ++seq, abs, rel, id, label, before, after, pages, at: Date.now() });
    if (changes.length > MAX_CHANGES) changes.shift();
    log(`#${seq} ${label}  (${rel})`);
  }

  function assertEditable() {
    if (claudeJob?.status === "running") {
      throw new EditError("Claude is still working on the last request. Wait for it to finish, or cancel it.", 409);
    }
    if (showOriginal) {
      throw new EditError("You're viewing the original. Switch back to your version to edit.", 409);
    }
  }

  function reloadTouched() {
    for (const abs of originals.keys()) {
      for (const m of server.moduleGraph.getModulesByFile(abs) ?? []) {
        server.moduleGraph.invalidateModule(m);
      }
    }
    server.ws.send({ type: "full-reload" });
  }

  // The theme lives in whichever source file calls createTheme(); there must
  // be exactly one.
  async function findThemeFile() {
    if (themeRel) return themeRel;
    const hits = [];
    const scan = async (dir) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ["node_modules", "dist", "build", "tests"].includes(ent.name)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) await scan(abs);
        else if (/\.[jt]sx?$/.test(ent.name) && (await fs.readFile(abs, "utf8")).includes("createTheme(")) {
          hits.push(path.relative(root, abs).split(path.sep).join("/"));
        }
      }
    };
    await scan(root);
    if (hits.length !== 1) {
      throw new EditError(`Expected one file calling createTheme(), found: ${hits.join(", ") || "none"}`, 422);
    }
    themeRel = hits[0];
    return themeRel;
  }

  const git = (args) => execFileAsync("git", args, { cwd: root });

  // Source files for usage counts, cached briefly: one panel render asks
  // several questions in a row.
  let sourceCache = null;
  async function listSources() {
    if (sourceCache && Date.now() - sourceCache.at < 5000) return sourceCache.files;
    const files = [];
    const scan = async (dir) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ["node_modules", "dist", "build", "tests"].includes(ent.name)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) await scan(abs);
        else if (/\.[jt]sx?$/.test(ent.name)) {
          files.push({ rel: path.relative(root, abs).split(path.sep).join("/"), code: await fs.readFile(abs, "utf8") });
        }
      }
    };
    await scan(root);
    sourceCache = { at: Date.now(), files };
    return files;
  }

  // ---------- Ask Claude ----------
  // One run at a time; other edits wait, so the before/after comparison only
  // sees the run's own changes.
  let claudeJob = null; // { n, status, prompt, events, result }
  let claudeSeq = 0;
  let claudeInfo = null; // { version } or { version: null }

  async function claudeStatus() {
    if (opts.claude === false) return { enabled: false, reason: "turned off (VE_CLAUDE=0)" };
    claudeInfo ??= { version: await claudeVersion(opts.claudeBin) };
    return claudeInfo.version
      ? { enabled: true, version: claudeInfo.version }
      : { enabled: false, reason: "the claude command isn't installed on this computer" };
  }

  // Files git reports as modified anywhere in the repo, as absolute paths.
  async function gitDirty() {
    try {
      const top = (await git(["rev-parse", "--show-toplevel"])).stdout.trim();
      const out = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
      const set = new Set();
      for (const entry of out.split("\0")) if (entry.length > 3) set.add(path.join(top, entry.slice(3)));
      return set;
    } catch (e) {
      log(`couldn't read git status: ${e.message}`);
      return null;
    }
  }

  async function startClaude({ id, route: page, prompt }) {
    assertEditable();
    const status = await claudeStatus();
    if (!status.enabled) throw new EditError(`Ask Claude isn't available: ${status.reason}`, 409);
    const request = cleanLabel(prompt, null);
    if (!request) throw new EditError("Say what you'd like changed first");

    const context = [`The designer is looking at the page ${cleanLabel(page, "/")}.`];
    let reach = null;
    if (id) {
      const { rel, line, column } = parseId(id);
      const code = await fs.readFile(resolveSource(root, rel), "utf8");
      const info = inspect(code, rel, line, column);
      const text = typeof info.text?.value === "string" ? ` with the text “${info.text.value.slice(0, 80)}”` : "";
      context.push(`They selected the <${info.name}> element${text} whose opening tag is at ${rel}, line ${line}, column ${column + 1}.`);
      reach = await pagesOf(id).catch(() => null);
      if (reach?.pages.length > 1) {
        context.push(`That element is part of ${reach.component}, which appears on ${reach.pages.length} pages ` +
          `(${reach.pages.map((p) => p.path).join(", ")}), so a change there shows on all of them. Say so in your summary.`);
      }
    } else {
      context.push("They haven't selected anything, so the request is about the page as a whole.");
    }
    const themeFile = await findThemeFile().catch(() => null);
    if (themeFile) context.push(`The Mantine theme (design tokens) is in ${themeFile}.`);
    context.push("", "Their request:", String(prompt).trim().slice(0, 4000));

    const job = { n: ++claudeSeq, status: "running", prompt: request, events: [], result: null, startedAt: Date.now() };
    claudeJob = job;
    const before = await snapshot(root);
    const dirtyAtStart = await gitDirty();
    log(`Claude #${job.n}: ${request}`);
    const run = runClaude({
      cwd: root, prompt: context.join("\n"), model: opts.claudeModel, bin: opts.claudeBin,
      onEvent: (lines) => {
        for (const l of lines) job.events.push({ at: Date.now(), text: l.slice(0, 500) });
        if (job.events.length > 300) job.events.splice(0, job.events.length - 300);
      },
    });
    job.cancel = run.cancel;
    run.done.then(async (r) => {
      const after = await snapshot(root);
      const touched = diffSnapshots(before, after);
      const recorded = [];
      const skipped = [];
      for (const f of touched) {
        if (f.added || f.deleted) { skipped.push(f.rel); continue; }
        const abs = path.join(root, f.rel);
        if (!originals.has(abs) && dirtyAtStart?.has(abs)) dirtyBefore.add(abs);
        record(abs, f.rel, f.before, f.after, {
          label: `Claude: “${request.slice(0, 90)}”${touched.length > 1 ? ` · ${f.rel}` : ""}`,
          pages: reach && reach.pages.length > 1 ? { component: reach.component, list: reach.pages } : null,
        });
        recorded.push({ n: seq, rel: f.rel });
      }
      const dirtyNow = await gitDirty();
      const outside = dirtyNow && dirtyAtStart
        ? [...dirtyNow].filter((a) => !dirtyAtStart.has(a) && !a.startsWith(root + path.sep)) : [];
      if (outside.length) log(`Claude #${job.n}: files outside the app changed: ${outside.join(", ")}`);
      if (skipped.length) log(`Claude #${job.n}: files added/removed, not in the change log: ${skipped.join(", ")}`);
      job.result = { ...r, changes: recorded, skipped, outside };
      job.status = r.cancelled ? "cancelled" : r.ok ? "done" : "error";
      log(`Claude #${job.n} ${job.status}: ${recorded.length} file(s) changed${r.error ? ` · ${r.error}` : ""}`);
    }).catch((e) => {
      job.result = { ok: false, error: `Couldn't record what Claude changed: ${e.message}`, changes: [] };
      job.status = "error";
      log(`Claude #${job.n} failed after running: ${e.stack ?? e.message}`);
    });
    return { job: job.n };
  }

  // Route → component graph, rebuilt when the source snapshot changes.
  let pageGraph = null;
  async function pagesOf(id) {
    const { rel, line, column } = parseId(id);
    const files = await listSources();
    if (pageGraph?.files !== files) pageGraph = { files, graph: buildPageGraph(files) };
    return pagesFor(pageGraph.graph, rel, line, column);
  }

  async function sendForReview({ title, notes }) {
    assertEditable();
    if (!changes.length && !questions.length) throw new EditError("Nothing to send yet", 409);
    const t = cleanLabel(title, null);
    if (!t) throw new EditError("Give the change a short title");
    const files = [...new Set(changes.map((c) => c.abs))];
    const prevBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const branch = `design/${slug(t)}-${stamp}`;
    const body = [
      ...(changes.length ? ["Design changes made with the visual editor:", "", ...changes.map((c) => `- ${c.label}`)] : []),
      ...(questions.length ? [
        ...(changes.length ? [""] : []),
        "Questions for developers:", "",
        ...questions.map((q) => `- ${q.label} (${q.id.replace(/:\d+$/, "")}, page ${q.route}): ${q.text}`),
      ] : []),
      ...(cleanLabel(notes, null) ? ["", cleanLabel(notes, "")] : []),
    ].join("\n");

    await git(["switch", "-c", branch]);
    try {
      if (files.length) await git(["add", "--", ...files]);
      // Questions alone still get a branch, so a developer has one place to look.
      await git(["commit", ...(files.length ? [] : ["--allow-empty"]), "-m", `${t}\n\n${body}\n`]);
    } catch (e) {
      // Leave the repo as it was: back to the previous branch, no empty branch.
      log(`commit failed, returning to ${prevBranch}: ${e.stderr?.trim() || e.message}`);
      if (files.length) await git(["reset", "-q", "--", ...files]).catch((r) => log(`reset failed: ${r.message}`));
      await git(["switch", "-q", prevBranch]);
      await git(["branch", "-D", branch]);
      throw e;
    }
    const commit = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
    log(`committed ${changes.length} change(s) to ${branch} @ ${commit}`);

    let pushed = false;
    let prUrl = null;
    if (opts.allowPush) {
      await git(["push", "-u", "origin", branch]);
      pushed = true;
      const pr = await execFileAsync("gh", ["pr", "create", "--title", t, "--body", body, "--head", branch], { cwd: root });
      prUrl = pr.stdout.trim().split("\n").pop();
    }
    const sent = changes.length;
    const asked = questions.length;
    changes.length = 0;
    questions.length = 0;
    redo.length = 0;
    originals.clear();
    dirtyBefore.clear();
    return { branch, commit, files: files.map((f) => path.relative(root, f)), sent, asked, pushed, prUrl };
  }

  async function demoLogin(res) {
    if (!opts.demoUser || !opts.demoPassword) {
      throw new EditError("No demo user configured (VE_DEMO_USER / VE_DEMO_PASSWORD)", 404);
    }
    if (!apiTarget) throw new EditError("No /api proxy target in the app's Vite config", 422);
    const r = await fetch(new URL("auth", apiTarget.endsWith("/") ? apiTarget : `${apiTarget}/`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName: opts.demoUser, password: opts.demoPassword }),
    });
    if (!r.ok) throw new EditError(`Demo login was refused by the API (HTTP ${r.status})`, 502);
    const data = await r.json().catch(() => ({}));
    if (data.user?.tempToken) {
      throw new EditError("The demo user needs MFA; configure an MFA-exempt account", 422);
    }
    const cookies = r.headers.getSetCookie();
    if (!cookies.length) throw new EditError("The API accepted the login but set no session cookie", 502);
    res.setHeader("Set-Cookie", cookies);
    log(`demo login as ${opts.demoUser}`);
    return { ok: true, user: opts.demoUser };
  }

  async function handleApi(req, res, route) {
    const isGet = req.method === "GET";
    if (!isGet) assertSameOrigin(req);

    if (isGet && STATIC[route]) {
      const [file, type] = STATIC[route];
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(await fs.readFile(file, "utf8"));
      return;
    }

    if (isGet && route === "config") {
      return send(res, 200, {
        demoLogin: Boolean(opts.demoUser && opts.demoPassword && apiTarget),
        demoUser: opts.demoUser ?? null,
        demoStart: opts.demoStart ?? "/",
        allowPush: Boolean(opts.allowPush),
        claude: await claudeStatus(),
        showOriginal,
      });
    }

    if (isGet && route === "inspect") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      const { rel, line, column } = parseId(id);
      const code = await fs.readFile(resolveSource(root, rel), "utf8");
      const info = inspect(code, rel, line, column);
      return send(res, 200, { id, ...info, mantine: isMantineComponent(code, rel, info.name) });
    }

    if (isGet && route === "claude") {
      const q = new URL(req.url, "http://x").searchParams;
      const status = await claudeStatus();
      if (!q.get("job")) return send(res, 200, { ...status, job: claudeJob?.status === "running" ? claudeJob.n : null });
      const job = claudeJob?.n === Number(q.get("job")) ? claudeJob : null;
      if (!job) throw new EditError("That Claude request is no longer available", 404);
      const since = Number(q.get("since") ?? 0);
      return send(res, 200, {
        n: job.n, status: job.status, prompt: job.prompt, startedAt: job.startedAt,
        events: job.events.slice(since), next: job.events.length, result: job.result,
      });
    }

    if (route === "claude") {
      return send(res, 200, await startClaude(await readBody(req)));
    }

    if (route === "claude-cancel") {
      if (claudeJob?.status === "running") claudeJob.cancel?.();
      return send(res, 200, { ok: true });
    }

    if (isGet && route === "pages") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      return send(res, 200, await pagesOf(id));
    }

    if (isGet && route === "theme") {
      const rel = await findThemeFile();
      const code = await fs.readFile(path.join(root, rel), "utf8");
      return send(res, 200, { file: rel, leaves: readTheme(code, rel) });
    }

    if (isGet && route === "changes") {
      return send(res, 200, {
        showOriginal,
        changes: changes.map(({ n, rel, label, pages, at }) => ({ n, rel, label, pages, at })),
        dirtyBefore: [...dirtyBefore].filter((a) => originals.has(a))
          .map((a) => path.relative(root, a).split(path.sep).join("/")),
      });
    }

    if (route === "theme") {
      assertEditable();
      const { path: keyPath, value, label } = await readBody(req);
      const rel = await findThemeFile();
      const abs = path.join(root, rel);
      const before = await fs.readFile(abs, "utf8");
      const after = setThemeValue(before, rel, keyPath, value ?? null);
      if (after === before) return send(res, 200, { changed: false });
      await noteFirstTouch(abs, rel);
      await fs.writeFile(abs, after, "utf8");
      record(abs, rel, before, after, {
        label: cleanLabel(label, `Theme: ${keyPath.join(".")} → ${JSON.stringify(value)}`),
      });
      return send(res, 200, { changed: true });
    }

    if (route === "edit") {
      assertEditable();
      const { id, edit, label } = await readBody(req);
      const { rel, line, column } = parseId(id);
      const abs = resolveSource(root, rel);
      const before = await fs.readFile(abs, "utf8");
      let after;
      let newId = id;
      if (edit?.type === "move") {
        ({ code: after, id: newId } = applyMove(before, rel, line, column, edit));
      } else {
        after = applyEdit(before, rel, line, column, edit ?? {});
      }
      if (after === before) return send(res, 200, { id, changed: false });
      // Read before writing: the id points into the pre-edit source.
      const reach = await pagesOf(id).catch((e) => {
        log(`couldn't work out which pages show ${id}: ${e.message}`);
        return null;
      });
      await noteFirstTouch(abs, rel);
      await fs.writeFile(abs, after, "utf8");
      record(abs, rel, before, after, {
        id,
        label: cleanLabel(label, `${rel}:${line} ${edit.type}`),
        pages: reach && reach.pages.length > 1 ? { component: reach.component, list: reach.pages } : null,
      });
      return send(res, 200, { id: newId, changed: true });
    }

    if (route === "revert") {
      assertEditable();
      const { n } = await readBody(req);
      const i = n === undefined ? changes.length - 1 : changes.findIndex((c) => c.n === n);
      if (i < 0) throw new EditError("Nothing to revert", 409);
      const c = changes[i];
      const current = await fs.readFile(c.abs, "utf8");
      const out = revertChange(current, c);
      parseSource(out, c.rel); // refuse to write a file that no longer parses
      await fs.writeFile(c.abs, out, "utf8");
      const newestForFile = !changes.slice(i + 1).some((x) => x.abs === c.abs);
      changes.splice(i, 1);
      redo.push(c);
      if (!changes.some((x) => x.abs === c.abs) && out === originals.get(c.abs)) {
        originals.delete(c.abs);
        dirtyBefore.delete(c.abs);
      }
      log(`reverted #${c.n} ${c.label}`);
      // The pre-edit id is only reliable if nothing later moved lines in that file.
      return send(res, 200, { reverted: c.label, id: newestForFile ? c.id : null });
    }

    if (route === "original") {
      const { on } = await readBody(req);
      if (on && !originals.size) throw new EditError("No changes yet", 409);
      showOriginal = Boolean(on);
      log(showOriginal ? "showing original" : "showing current version");
      reloadTouched();
      return send(res, 200, { showOriginal });
    }

    if (route === "redo") {
      assertEditable();
      const c = redo.pop();
      if (!c) throw new EditError("Nothing to redo", 409);
      const current = await fs.readFile(c.abs, "utf8");
      const out = revertChange(current, { before: c.after, after: c.before });
      parseSource(out, c.rel);
      await fs.writeFile(c.abs, out, "utf8");
      record(c.abs, c.rel, current, out, { id: c.id, label: c.label, keepRedo: true, pages: c.pages });
      return send(res, 200, { redone: c.label });
    }

    if (isGet && route === "usage") {
      const q = new URL(req.url, "http://x").searchParams;
      const themeFile = q.get("kind") === "component" ? null : await findThemeFile().catch(() => null);
      const files = (await listSources()).filter((f) => f.rel !== themeFile);
      const result = countUsage(files, q.get("kind"), q.get("name"));
      if (!result) throw new EditError("Bad usage query");
      return send(res, 200, result);
    }

    if (isGet && route === "questions") {
      return send(res, 200, { questions });
    }

    if (route === "questions") {
      const { id, label, route: page, text } = await readBody(req);
      parseId(id);
      const t = cleanLabel(text, null);
      if (!t) throw new EditError("Write the question first");
      questions.push({
        n: ++questionSeq, id, label: cleanLabel(label, id), route: cleanLabel(page, "/"),
        text: String(text).trim().slice(0, 2000), at: Date.now(),
      });
      log(`question #${questionSeq} on ${id}: ${t}`);
      return send(res, 200, { n: questionSeq });
    }

    if (route === "questions-delete") {
      const { n } = await readBody(req);
      const i = questions.findIndex((q) => q.n === n);
      if (i < 0) throw new EditError("No such question", 404);
      questions.splice(i, 1);
      return send(res, 200, { deleted: n });
    }

    if (route === "review") {
      return send(res, 200, await sendForReview(await readBody(req)));
    }

    if (route === "demo-login") {
      return send(res, 200, await demoLogin(res));
    }

    throw new EditError(`Unknown route ${req.method} ${route}`, 404);
  }

  return {
    name: "visual-edit",
    apply: "serve",
    enforce: "pre",

    configResolved(config) {
      root = path.resolve(config.root);
      const proxy = config.server.proxy?.["/api"];
      apiTarget = typeof proxy === "string" ? proxy : proxy?.target ?? null;
    },

    // Stamping happens at load, before any transform: other plugins (e.g.
    // React's Babel pass) reprint the code, which moves columns away from the
    // file on disk that the ids must point at. With "show original" on, each
    // touched file is served as it was before this session.
    async load(id) {
      if (id.includes("?") || id.includes("/node_modules/")) return;
      const original = showOriginal ? originals.get(id) : undefined;
      if (!/\.[jt]sx$/.test(id)) return original;
      const rel = path.relative(root, id);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return original;
      const code = original ?? await fs.readFile(id, "utf8");
      return stampJsx(code, rel.split(path.sep).join("/")) ?? code;
    },

    transformIndexHtml() {
      return [
        // Classic and first in <head>: wraps fetch before the app's modules run.
        { tag: "script", attrs: { src: DATA_URL }, injectTo: "head-prepend" },
        { tag: "script", attrs: { type: "module", src: CANVAS_URL }, injectTo: "body" },
      ];
    },

    configureServer(s) {
      server = s;
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (url === CANVAS_URL || url === DATA_URL) {
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Cache-Control", "no-store");
          res.end(await fs.readFile(here(url === CANVAS_URL ? "./canvas.js" : "./data.js"), "utf8"));
          return;
        }
        if (url === "/__ve") {
          res.statusCode = 302;
          res.setHeader("Location", API);
          res.end();
          return;
        }
        if (!url.startsWith(API)) return next();
        const route = url.slice(API.length).split("?")[0];
        try {
          await handleApi(req, res, route);
        } catch (err) {
          const status = err instanceof EditError ? err.status : 500;
          const message = err.stderr?.trim() || err.message;
          log(`${req.method} ${route} failed (${status}): ${message}`);
          if (status === 500) console.error(err);
          if (!res.headersSent) send(res, status, { error: message });
        }
      });
      log("editor at /__ve/");
    },
  };
}
