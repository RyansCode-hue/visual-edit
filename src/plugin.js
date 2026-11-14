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

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CANVAS_URL = "/@visual-edit/canvas.js";
const STATIC = {
  "": [here("./shell/index.html"), "text/html"],
  "shell.js": [here("./shell/shell.js"), "text/javascript"],
  "shell.css": [here("./shell/shell.css"), "text/css"],
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

  function record(abs, rel, before, after, { id = null, label }) {
    if (!originals.has(abs)) originals.set(abs, before);
    changes.push({ n: ++seq, abs, rel, id, label, before, after, at: Date.now() });
    if (changes.length > MAX_CHANGES) changes.shift();
    log(`#${seq} ${label}  (${rel})`);
  }

  function assertEditable() {
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

  async function sendForReview({ title, notes }) {
    assertEditable();
    if (!changes.length) throw new EditError("No changes to send", 409);
    const t = cleanLabel(title, null);
    if (!t) throw new EditError("Give the change a short title");
    const files = [...new Set(changes.map((c) => c.abs))];
    const prevBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const branch = `design/${slug(t)}-${stamp}`;
    const body = [
      "Design changes made with the visual editor:",
      "",
      ...changes.map((c) => `- ${c.label}`),
      ...(cleanLabel(notes, null) ? ["", cleanLabel(notes, "")] : []),
    ].join("\n");

    await git(["switch", "-c", branch]);
    try {
      await git(["add", "--", ...files]);
      await git(["commit", "-m", `${t}\n\n${body}\n`]);
    } catch (e) {
      // Leave the repo as it was: back to the previous branch, no empty branch.
      log(`commit failed, returning to ${prevBranch}: ${e.stderr?.trim() || e.message}`);
      await git(["reset", "-q", "--", ...files]).catch((r) => log(`reset failed: ${r.message}`));
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
    changes.length = 0;
    originals.clear();
    dirtyBefore.clear();
    return { branch, commit, files: files.map((f) => path.relative(root, f)), sent, pushed, prUrl };
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

    if (isGet && route === "theme") {
      const rel = await findThemeFile();
      const code = await fs.readFile(path.join(root, rel), "utf8");
      return send(res, 200, { file: rel, leaves: readTheme(code, rel) });
    }

    if (isGet && route === "changes") {
      return send(res, 200, {
        showOriginal,
        changes: changes.map(({ n, rel, label, at }) => ({ n, rel, label, at })),
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
      await noteFirstTouch(abs, rel);
      await fs.writeFile(abs, after, "utf8");
      record(abs, rel, before, after, {
        id,
        label: cleanLabel(label, `${rel}:${line} ${edit.type}`),
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
      return [{
        tag: "script",
        attrs: { type: "module", src: CANVAS_URL },
        injectTo: "body",
      }];
    },

    configureServer(s) {
      server = s;
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (url === CANVAS_URL) {
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Cache-Control", "no-store");
          res.end(await fs.readFile(here("./canvas.js"), "utf8"));
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
