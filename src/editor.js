// The visual editor's core, independent of how the app is served.
//
// - Keeps the session: change log, revert/redo, questions, "show original",
//   Ask Claude runs, review branch.
// - Every operation is a plain function in `ops`, shared by the shell's JSON
//   API (handleApi) and the MCP server, so both see and change the same state.
// - Talks to the app server only through an adapter:
//     { reload(absFiles) }   re-render after files changed or "show original"
//   and serves source through load(), which the Vite adapter calls so JSX is
//   stamped with source locations (dev transform only; disk never stamped).
//
// The write operations can modify any .jsx/.tsx file under the app root, so
// the HTTP API only accepts JSON POSTs from its own origin, and every path is
// checked against the root and node_modules.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { stampJsx, inspect, applyEdit, applyMove, parseSource, EditError } from "./source.js";
import { readTheme, setThemeValue, isMantineComponent } from "./theme.js";
import { revertChange, slug } from "./changes.js";
import { countUsage } from "./usage.js";
import { buildPageGraph, pagesFor } from "./pages.js";
import { runClaude, claudeVersion, snapshot, diffSnapshots } from "./claude.js";
import { handoffMarkdown } from "./handoff.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const CANVAS_URL = "/@visual-edit/canvas.js";
export const DATA_URL = "/@visual-edit/data.js";
export const SHOT_URL = "/@visual-edit/shot.js";
const SCRIPTS = {
  [CANVAS_URL]: here("./canvas.js"),
  [DATA_URL]: here("./data.js"),
  // modern-screenshot's self-contained ESM build, imported by canvas.shot().
  [SHOT_URL]: createRequire(import.meta.url).resolve("modern-screenshot").replace(/index\.c?js$/, "index.mjs"),
};
const STATIC = {
  "": [here("./shell/index.html"), "text/html"],
  "shell.js": [here("./shell/shell.js"), "text/javascript"],
  "shell.css": [here("./shell/shell.css"), "text/css"],
  "tokens.js": [here("./shell/tokens.js"), "text/javascript"],
};
export const API = "/__ve/";
const MAX_BODY = 64 * 1024;
const MAX_CHANGES = 200;
const execFileAsync = promisify(execFile);

export function log(msg) {
  console.log(`\x1b[35m[visual-edit]\x1b[0m ${msg}`);
}

export function parseId(id) {
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

export function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
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

export function send(res, status, body) {
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
 * @param {boolean} [opts.claude]       false turns off Ask Claude
 * @param {string} [opts.claudeModel]
 * @param {string} [opts.claudeBin]
 */
export function createEditor(opts = {}) {
  let root = "";
  let apiTarget = null;
  let adapter = { reload() {} };
  let urlTarget = null; // URL mode: the site being edited
  let themeRel = null;
  // "changed" after anything the change log or selection depends on.
  const events = new EventEmitter();
  events.setMaxListeners(50);

  // Session change log: { n, abs, rel, id, label, before, after, pages, at }.
  const changes = [];
  let seq = 0;
  // Each touched file's content before its first change this session.
  const originals = new Map();
  // Touched files that already differed from git HEAD before this session;
  // "Send for review" commits whole files, so those edits would ride along.
  const dirtyBefore = new Set();
  let showOriginal = false;

  const git = (args) => execFileAsync("git", args, { cwd: root });

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

  // Same, for a file that has already changed on disk (edited outside the
  // editor): compares its previous content with git HEAD instead.
  async function noteFirstTouchFrom(abs, rel, before) {
    if (originals.has(abs)) return;
    try {
      const head = (await execFileAsync("git", ["show", `HEAD:./${rel}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout;
      if (head !== before) dirtyBefore.add(abs);
    } catch (e) {
      // Not in HEAD (new file) or not a git repo: a review commit would add all of it.
      dirtyBefore.add(abs);
      log(`couldn't compare ${rel} with git HEAD: ${e.stderr?.trim() || e.message}`);
    }
  }

  // Reverted changes, newest last, for redo. Any new edit clears it.
  const redo = [];
  // Questions for developers, pinned to elements: { n, id, label, route, text, at }.
  const questions = [];
  let questionSeq = 0;

  function record(abs, rel, before, after, { id = null, label, keepRedo = false, pages = null, source = "editor" }) {
    if (!originals.has(abs)) originals.set(abs, before);
    if (!keepRedo) redo.length = 0;
    changes.push({ n: ++seq, abs, rel, id, label, before, after, pages, source, at: Date.now() });
    if (changes.length > MAX_CHANGES) changes.shift();
    log(`#${seq} ${label}  (${rel})`);
    events.emit("changed", { n: seq });
    return seq;
  }

  // Writes a file and remembers the content, so a file watcher can tell the
  // editor's own writes from everyone else's.
  const ownWrites = new Map(); // abs → content last written by the editor
  async function writeSource(abs, content) {
    ownWrites.set(abs, content);
    await fs.writeFile(abs, content, "utf8");
  }

  function assertRepo() {
    if (!root) throw new EditError("This needs the app's code, and the editor was opened on a URL", 409);
  }

  function assertEditable() {
    assertRepo();
    if (claudeJob?.status === "running") {
      throw new EditError("Claude is still working on the last request. Wait for it to finish, or cancel it.", 409);
    }
    if (showOriginal) {
      throw new EditError("You're viewing the original. Switch back to your version to edit.", 409);
    }
  }

  // The theme lives in whichever source file calls createTheme(); there must
  // be exactly one.
  async function findThemeFile() {
    assertRepo();
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

  // Source files for usage counts, cached briefly: one panel render asks
  // several questions in a row.
  let sourceCache = null;
  async function listSources() {
    assertRepo();
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
    if (!root) return { enabled: false, reason: "the editor was opened on a URL, so there's no code to change" };
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
    events.emit("claude", { n: job.n, status: job.status });
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
        const n = record(abs, f.rel, f.before, f.after, {
          label: `Claude: “${request.slice(0, 90)}”${touched.length > 1 ? ` · ${f.rel}` : ""}`,
          pages: reach && reach.pages.length > 1 ? { component: reach.component, list: reach.pages } : null,
          source: "ask-claude",
        });
        recorded.push({ n, rel: f.rel });
      }
      const dirtyNow = await gitDirty();
      const outside = dirtyNow && dirtyAtStart
        ? [...dirtyNow].filter((a) => !dirtyAtStart.has(a) && !a.startsWith(root + path.sep)) : [];
      if (outside.length) log(`Claude #${job.n}: files outside the app changed: ${outside.join(", ")}`);
      if (skipped.length) log(`Claude #${job.n}: files added/removed, not in the change log: ${skipped.join(", ")}`);
      job.result = { ...r, changes: recorded, skipped, outside };
      job.status = r.cancelled ? "cancelled" : r.ok ? "done" : "error";
      log(`Claude #${job.n} ${job.status}: ${recorded.length} file(s) changed${r.error ? ` · ${r.error}` : ""}`);
      events.emit("claude", { n: job.n, status: job.status });
    }).catch((e) => {
      job.result = { ok: false, error: `Couldn't record what Claude changed: ${e.message}`, changes: [] };
      job.status = "error";
      log(`Claude #${job.n} failed after running: ${e.stack ?? e.message}`);
      events.emit("claude", { n: job.n, status: job.status });
    });
    return { job: job.n };
  }

  function claudeJobState(n, since = 0) {
    const job = claudeJob?.n === n ? claudeJob : null;
    if (!job) throw new EditError("That Claude request is no longer available", 404);
    return {
      n: job.n, status: job.status, prompt: job.prompt, startedAt: job.startedAt,
      events: job.events.slice(since), next: job.events.length, result: job.result,
    };
  }

  // Route → component graph, rebuilt when the source snapshot changes.
  let pageGraph = null;
  async function pagesOf(id) {
    const { rel, line, column } = parseId(id);
    const files = await listSources();
    if (pageGraph?.files !== files) pageGraph = { files, graph: buildPageGraph(files) };
    return pagesFor(pageGraph.graph, rel, line, column);
  }

  async function allPages() {
    const files = await listSources();
    if (pageGraph?.files !== files) pageGraph = { files, graph: buildPageGraph(files) };
    return pageGraph.graph.pages.map((p) => ({ path: p.path, page: p.page.split("#")[1], file: p.page.split("#")[0] }));
  }

  async function inspectElement(id) {
    assertRepo();
    const { rel, line, column } = parseId(id);
    const code = await fs.readFile(resolveSource(root, rel), "utf8");
    const info = inspect(code, rel, line, column);
    return { id, ...info, mantine: isMantineComponent(code, rel, info.name) };
  }

  async function readThemeLeaves() {
    const rel = await findThemeFile();
    const code = await fs.readFile(path.join(root, rel), "utf8");
    return { file: rel, leaves: readTheme(code, rel) };
  }

  async function setTheme({ path: keyPath, value, label, source }) {
    assertEditable();
    if (!Array.isArray(keyPath) || !keyPath.length) throw new EditError("Theme path must be a non-empty array");
    const rel = await findThemeFile();
    const abs = path.join(root, rel);
    const before = await fs.readFile(abs, "utf8");
    const after = setThemeValue(before, rel, keyPath, value ?? null);
    if (after === before) return { changed: false };
    await noteFirstTouch(abs, rel);
    await writeSource(abs, after);
    const n = record(abs, rel, before, after, {
      label: cleanLabel(label, `Theme: ${keyPath.join(".")} → ${JSON.stringify(value)}`),
      source,
    });
    return { changed: true, n };
  }

  async function edit({ id, edit: change, label, source }) {
    assertEditable();
    const { rel, line, column } = parseId(id);
    const abs = resolveSource(root, rel);
    const before = await fs.readFile(abs, "utf8");
    let after;
    let newId = id;
    if (change?.type === "move") {
      ({ code: after, id: newId } = applyMove(before, rel, line, column, change));
    } else {
      after = applyEdit(before, rel, line, column, change ?? {});
    }
    if (after === before) return { id, changed: false };
    // Read before writing: the id points into the pre-edit source.
    const reach = await pagesOf(id).catch((e) => {
      log(`couldn't work out which pages show ${id}: ${e.message}`);
      return null;
    });
    await noteFirstTouch(abs, rel);
    await writeSource(abs, after);
    const n = record(abs, rel, before, after, {
      id,
      label: cleanLabel(label, `${rel}:${line} ${change.type}`),
      pages: reach && reach.pages.length > 1 ? { component: reach.component, list: reach.pages } : null,
      source,
    });
    return { id: newId, changed: true, n };
  }

  async function revert({ n } = {}) {
    if (!root) {
      if (showOriginal) throw new EditError("You're viewing the original. Switch back to your version to edit.", 409);
      const i = n === undefined ? changes.length - 1 : changes.findIndex((c) => c.n === n);
      if (i < 0) throw new EditError("Nothing to revert", 409);
      const [c] = changes.splice(i, 1);
      redo.push(c);
      log(`reverted #${c.n} ${c.label}`);
      events.emit("changed", { reverted: c.n });
      return { reverted: c.label, id: c.id };
    }
    assertEditable();
    const i = n === undefined ? changes.length - 1 : changes.findIndex((c) => c.n === n);
    if (i < 0) throw new EditError("Nothing to revert", 409);
    const c = changes[i];
    const current = await fs.readFile(c.abs, "utf8");
    const out = revertChange(current, c);
    if (/\.[jt]sx?$/.test(c.rel)) parseSource(out, c.rel); // refuse to write a file that no longer parses
    await writeSource(c.abs, out);
    const newestForFile = !changes.slice(i + 1).some((x) => x.abs === c.abs);
    changes.splice(i, 1);
    redo.push(c);
    if (!changes.some((x) => x.abs === c.abs) && out === originals.get(c.abs)) {
      originals.delete(c.abs);
      dirtyBefore.delete(c.abs);
    }
    log(`reverted #${c.n} ${c.label}`);
    events.emit("changed", { reverted: c.n });
    // The pre-edit id is only reliable if nothing later moved lines in that file.
    return { reverted: c.label, id: newestForFile ? c.id : null };
  }

  async function redoLast() {
    if (!root) {
      const c = redo.pop();
      if (!c) throw new EditError("Nothing to redo", 409);
      changes.push({ ...c, n: ++seq, at: Date.now() });
      events.emit("changed", { n: seq });
      return { redone: c.label };
    }
    assertEditable();
    const c = redo.pop();
    if (!c) throw new EditError("Nothing to redo", 409);
    const current = await fs.readFile(c.abs, "utf8");
    const out = revertChange(current, { before: c.after, after: c.before });
    if (/\.[jt]sx?$/.test(c.rel)) parseSource(out, c.rel);
    await writeSource(c.abs, out);
    record(c.abs, c.rel, current, out, { id: c.id, label: c.label, keepRedo: true, pages: c.pages, source: c.source });
    return { redone: c.label };
  }

  function setOriginal({ on }) {
    if (on && !(root ? originals.size : changes.length)) throw new EditError("No changes yet", 409);
    showOriginal = Boolean(on);
    log(showOriginal ? "showing original" : "showing current version");
    if (root) adapter.reload([...originals.keys()]);
    else events.emit("changed", { showOriginal });
    return { showOriginal };
  }

  function listChanges() {
    return {
      showOriginal,
      changes: changes.map(({ n, rel, page, label, pages, source, at }) => ({ n, rel: rel ?? page, label, pages, source, at })),
      dirtyBefore: [...dirtyBefore].filter((a) => originals.has(a))
        .map((a) => path.relative(root, a).split(path.sep).join("/")),
    };
  }

  /** The change log with each change's before/after text, for agents. */
  function changeDetails() {
    return changes.map(({ n, rel, label, pages, source, at, before, after }) => ({ n, rel, label, pages, source, at, before, after }));
  }

  function addQuestion({ id, label, route: page, text }) {
    if (typeof id !== "string" || !id) throw new EditError("Pin the question to an element");
    const t = cleanLabel(text, null);
    if (!t) throw new EditError("Write the question first");
    questions.push({
      n: ++questionSeq, id, label: cleanLabel(label, id), route: cleanLabel(page, "/"),
      text: String(text).trim().slice(0, 2000), at: Date.now(),
    });
    log(`question #${questionSeq} on ${id}: ${t}`);
    events.emit("changed", { question: questionSeq });
    return { n: questionSeq };
  }

  function deleteQuestion({ n }) {
    const i = questions.findIndex((q) => q.n === n);
    if (i < 0) throw new EditError("No such question", 404);
    questions.splice(i, 1);
    events.emit("changed", { question: n });
    return { deleted: n };
  }

  async function usage(kind, name) {
    const themeFile = kind === "component" ? null : await findThemeFile().catch(() => null);
    const files = (await listSources()).filter((f) => f.rel !== themeFile);
    const result = countUsage(files, kind, name);
    if (!result) throw new EditError("Bad usage query");
    return result;
  }

  async function sendForReview({ title, notes, screenshots }) {
    if (!root) return saveHandoff({ title, notes, screenshots });
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
    events.emit("changed", { review: branch });
    return { branch, commit, files: files.map((f) => path.relative(root, f)), sent, asked, pushed, prUrl };
  }

  async function demoLogin(res) {
    if (!opts.demoUser || !opts.demoPassword) {
      throw new EditError("No demo user configured (VE_DEMO_USER / VE_DEMO_PASSWORD)", 404);
    }
    if (!apiTarget) throw new EditError("No /api target to sign in against", 422);
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

  async function config() {
    return {
      mode: root ? "repo" : "url",
      // URL mode signs in through the site's own login page.
      demoLogin: Boolean(root && opts.demoUser && opts.demoPassword && apiTarget),
      demoUser: opts.demoUser ?? null,
      demoStart: opts.demoStart ?? "/",
      allowPush: Boolean(opts.allowPush),
      claude: await claudeStatus(),
      showOriginal,
    };
  }

  // ---------- URL mode: overrides ----------
  // Each style or text change on the live site is one change-log entry:
  // { n, kind: "override", page, id, element: { description, selector },
  //   name ("text" or a CSS property), before, after, label, source, at }.
  // What the page shows is the fold of those entries, newest winning.

  const CSS_PROP = /^-?[a-z][a-z-]*$/;
  function override({ id, page, edit: change, label, element, before, source = "editor" }) {
    if (root) throw new EditError("Overrides are for URL mode; edit the code instead", 409);
    if (showOriginal) throw new EditError("You're viewing the original. Switch back to your version to edit.", 409);
    if (typeof id !== "string" || !id.startsWith("dom:")) throw new EditError(`Bad element id: ${id}`);
    const pg = cleanLabel(page, null);
    if (!pg || !pg.startsWith("/")) throw new EditError("Say which page the element is on");
    let name;
    let value;
    if (change?.type === "text") {
      if (typeof change.value !== "string") throw new EditError("Text must be a string");
      name = "text";
      value = change.value.slice(0, 2000);
    } else if (change?.type === "style") {
      if (typeof change.name !== "string" || !CSS_PROP.test(change.name)) throw new EditError(`Not a CSS property: ${change?.name}`);
      name = change.name;
      value = change.value === null || change.value === "" ? null : String(change.value).slice(0, 200);
      if (value && /[;{}<>]/.test(value)) throw new EditError(`Not a plain CSS value: ${value}`);
    } else {
      throw new EditError(`URL mode can change text and styles, not "${change?.type}"`);
    }
    // The first change to this property keeps the site's own value as "before".
    const earlier = changes.find((c) => c.kind === "override" && c.page === pg && c.id === id && c.name === name);
    const entry = {
      n: ++seq, kind: "override", page: pg, id, name, after: value,
      before: earlier ? earlier.before : (before ?? null),
      element: {
        description: cleanLabel(element?.description, id),
        selector: id.slice(4),
      },
      label: cleanLabel(label, `${cleanLabel(element?.description, id)}: ${name} → ${value ?? "default"}`),
      source, at: Date.now(),
    };
    redo.length = 0;
    changes.push(entry);
    if (changes.length > MAX_CHANGES) changes.shift();
    log(`#${entry.n} ${entry.label}  (${pg})`);
    events.emit("changed", { n: entry.n });
    return { changed: true, n: entry.n, id };
  }

  /** What each element on each page should show: [{ page, selector, styles, text }]. */
  function effectiveOverrides() {
    const byEl = new Map();
    for (const c of changes) {
      if (c.kind !== "override") continue;
      const k = `${c.page}\n${c.id}`;
      const o = byEl.get(k) ?? { page: c.page, selector: c.element.selector, styles: {}, text: undefined };
      if (c.name === "text") o.text = c.after;
      else if (c.after === null) delete o.styles[c.name];
      else o.styles[c.name] = c.after;
      byEl.set(k, o);
    }
    return [...byEl.values()];
  }

  /** Overrides grouped per element, for the handoff and MCP. */
  function overrideDetails() {
    const byEl = new Map();
    for (const c of changes) {
      if (c.kind !== "override") continue;
      const k = `${c.page}\n${c.id}`;
      const o = byEl.get(k) ?? { ns: [], label: c.element.description, page: c.page, element: { ...c.element, path: c.element.selector }, props: {}, text: null };
      o.ns.push(c.n);
      if (c.name === "text") o.text = { before: c.before, after: c.after };
      else o.props[c.name] = { before: c.before, after: c.after };
      byEl.set(k, o);
    }
    return [...byEl.values()].map((o) => ({ ...o, label: `${o.element.description} on ${o.page}` }));
  }

  /** URL mode's "send for review": the handoff saved as a folder. */
  async function saveHandoff({ title, notes, screenshots = {} }) {
    if (!changes.length && !questions.length) throw new EditError("Nothing to hand off yet", 409);
    const t = cleanLabel(title, null);
    if (!t) throw new EditError("Give the change a short title");
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const dir = path.join(os.homedir(), ".visual-edit", "handoffs", `${slug(t)}-${stamp}`);
    await fs.mkdir(dir, { recursive: true });
    const files = [];
    for (const [name, dataUrl] of Object.entries(screenshots)) {
      if (!/^(before|after)$/.test(name)) continue;
      const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl ?? "");
      if (!m) throw new EditError(`Screenshot "${name}" isn't a PNG`);
      await fs.writeFile(path.join(dir, `${name}.png`), Buffer.from(m[1], "base64"));
      files.push(`${name}.png`);
    }
    const markdown = handoffMarkdown({
      mode: "url", target: urlTarget, changes: overrideDetails(), questions,
      notes: [t, cleanLabel(notes, "")].filter(Boolean).join("\n\n"),
      screenshots: files.map((f) => `${f}: the page ${f === "before.png" ? "without" : "with"} these changes`),
    });
    await fs.writeFile(path.join(dir, "prompt.md"), markdown, "utf8");
    log(`handoff saved to ${dir}`);
    return { dir, files: ["prompt.md", ...files], sent: changes.length, asked: questions.length };
  }

  /** The session written up as a prompt for a coding agent. */
  async function handoff({ notes, target } = {}) {
    return handoffMarkdown({
      mode: root ? "repo" : "url",
      target: root || target,
      changes: root ? changeDetails() : overrideDetails(),
      questions,
      notes: typeof notes === "string" ? notes.slice(0, 4000) : "",
    });
  }

  const ops = {
    handoff,
    override,
    effectiveOverrides,
    overrideDetails,
    config, inspectElement, pagesOf, allPages, readThemeLeaves, setTheme, edit, revert, redoLast,
    setOriginal, listChanges, changeDetails, usage, sendForReview, startClaude, claudeStatus,
    claudeJobState, addQuestion, deleteQuestion,
    listQuestions: () => ({ questions }),
    cancelClaude() {
      if (claudeJob?.status === "running") claudeJob.cancel?.();
      return { ok: true };
    },
    runningClaudeJob: () => (claudeJob?.status === "running" ? claudeJob.n : null),
  };

  // Extra routes (MCP, live channel) registered by other modules:
  // route → async (req, res) => void.
  const extraRoutes = new Map();

  async function handleApi(req, res, route) {
    const isGet = req.method === "GET";
    const extra = extraRoutes.get(route);
    if (extra) return extra(req, res);
    if (!isGet) assertSameOrigin(req);
    const q = () => new URL(req.url, "http://x").searchParams;

    if (isGet && STATIC[route]) {
      const [file, type] = STATIC[route];
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(await fs.readFile(file, "utf8"));
      return;
    }

    if (isGet) {
      switch (route) {
        case "config": return send(res, 200, await config());
        case "inspect": return send(res, 200, await inspectElement(q().get("id")));
        case "claude": {
          const job = q().get("job");
          if (!job) return send(res, 200, { ...(await claudeStatus()), job: ops.runningClaudeJob() });
          return send(res, 200, claudeJobState(Number(job), Number(q().get("since") ?? 0)));
        }
        case "pages": return send(res, 200, await pagesOf(q().get("id")));
        case "theme": return send(res, 200, await readThemeLeaves());
        case "changes": return send(res, 200, listChanges());
        case "usage": return send(res, 200, await usage(q().get("kind"), q().get("name")));
        case "questions": return send(res, 200, ops.listQuestions());
        case "handoff": return send(res, 200, { markdown: await handoff({ target: urlTarget }) });
        case "overrides": return send(res, 200, { showOriginal, overrides: showOriginal ? [] : effectiveOverrides() });
      }
    } else {
      switch (route) {
        case "claude": return send(res, 200, await startClaude(await readBody(req)));
        case "claude-cancel": return send(res, 200, ops.cancelClaude());
        case "theme": return send(res, 200, await setTheme(await readBody(req)));
        case "edit": return send(res, 200, await edit(await readBody(req)));
        case "revert": return send(res, 200, await revert(await readBody(req)));
        case "original": return send(res, 200, setOriginal(await readBody(req)));
        case "redo": return send(res, 200, await redoLast());
        case "questions": return send(res, 200, addQuestion(await readBody(req)));
        case "questions-delete": return send(res, 200, deleteQuestion(await readBody(req)));
        case "review": return send(res, 200, await sendForReview(await readBody(req, 20 * 1024 * 1024)));
        case "override": return send(res, 200, override(await readBody(req)));
        case "demo-login": return send(res, 200, await demoLogin(res));
      }
    }
    throw new EditError(`Unknown route ${req.method} ${route}`, 404);
  }

  /**
   * Connect middleware for the editor's own URLs: /__ve/*, the injected
   * scripts, and the /__ve → /__ve/ redirect. Calls next() for the rest.
   */
  async function middleware(req, res, next) {
    const url = req.url ?? "";
    const pathname = url.split("?")[0];
    if (SCRIPTS[pathname] || extraScripts.has(pathname)) {
      res.setHeader("Content-Type", "text/javascript");
      res.setHeader("Cache-Control", "no-store");
      res.end(await fs.readFile(SCRIPTS[pathname] ?? extraScripts.get(pathname), "utf8"));
      return;
    }
    if (pathname === "/__ve") {
      res.statusCode = 302;
      res.setHeader("Location", API);
      res.end();
      return;
    }
    if (!url.startsWith(API)) return next();
    const route = pathname.slice(API.length);
    try {
      await handleApi(req, res, route);
    } catch (err) {
      const status = err instanceof EditError ? err.status : 500;
      const message = err.stderr?.trim() || err.message;
      log(`${req.method} ${route} failed (${status}): ${message}`);
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    }
  }
  const extraScripts = new Map(); // url → file

  /**
   * Source for a module the app server is loading, stamped with element ids,
   * or undefined to let the server load it normally. Stamping happens at load,
   * before any transform: other plugins (e.g. React's Babel pass) reprint the
   * code, which moves columns away from the file on disk that the ids must
   * point at. With "show original" on, each touched file is served as it was
   * before this session.
   */
  async function load(id) {
    if (!root || id.includes("?") || id.includes("/node_modules/")) return;
    const original = showOriginal ? originals.get(id) : undefined;
    if (!/\.[jt]sx$/.test(id)) return original;
    const rel = path.relative(root, id);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return original;
    const code = original ?? await fs.readFile(id, "utf8");
    return stampJsx(code, rel.split(path.sep).join("/")) ?? code;
  }

  /** Script tags the app's HTML needs, in Vite's transformIndexHtml format. */
  const htmlTags = () => [
    // Classic and first in <head>: wraps fetch before the app's modules run.
    { tag: "script", attrs: { src: DATA_URL }, injectTo: "head-prepend" },
    { tag: "script", attrs: { type: "module", src: CANVAS_URL }, injectTo: "body" },
  ];

  return {
    ops,
    events,
    middleware,
    load,
    htmlTags,
    record,
    writeSource,
    ownWrites,
    get root() { return root; },
    get claudeRunning() { return claudeJob?.status === "running"; },
    /** Repo mode: the app folder and where its /api calls go. */
    setRepo({ root: r, apiTarget: t }) {
      root = path.resolve(r);
      apiTarget = t ?? null;
    },
    /** URL mode: the site being edited; its /api is the site itself. */
    setUrlTarget(t) { urlTarget = t; apiTarget = t; },
    get urlTarget() { return urlTarget; },
    setAdapter(a) { adapter = a; },
    route(name, handler) { extraRoutes.set(name, handler); },
    script(url, file) { extraScripts.set(url, file); },
    noteFirstTouch,
    noteFirstTouchFrom,
  };
}
