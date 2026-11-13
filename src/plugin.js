// Dev-server-only Vite plugin: stamps JSX with source locations, injects the
// editor overlay, and serves a small JSON API that reads and writes source.
//
// The write API can modify any .jsx/.tsx file under the app root, so it is
// only registered for `vite serve`, only accepts JSON POSTs from the dev
// server's own origin, and rejects paths outside the root or in node_modules.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stampJsx, inspect, applyEdit, applyMove, EditError } from "./source.js";
import { readTheme, setThemeValue, isMantineComponent } from "./theme.js";

const OVERLAY_PATH = fileURLToPath(new URL("./overlay.js", import.meta.url));
const OVERLAY_URL = "/@visual-edit/overlay.js";
const API = "/__ve/";
const MAX_BODY = 64 * 1024;
const UNDO_LIMIT = 100;

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
    !/\.[jt]sx$/.test(abs)
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

export default function visualEdit() {
  let root = "";
  // Each entry: { abs, rel, id, before, after, summary }. Undo restores `before`
  // only if the file still holds `after`, so it never clobbers other edits.
  const undo = [];

  let themeRel = null;

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

  async function handleApi(req, res, route) {
    if (route === "inspect" && req.method === "GET") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      const { rel, line, column } = parseId(id);
      const code = await fs.readFile(resolveSource(root, rel), "utf8");
      const info = inspect(code, rel, line, column);
      return send(res, 200, { id, ...info, mantine: isMantineComponent(code, rel, info.name) });
    }

    if (route === "theme" && req.method === "GET") {
      const rel = await findThemeFile();
      const code = await fs.readFile(path.join(root, rel), "utf8");
      return send(res, 200, { file: rel, leaves: readTheme(code, rel) });
    }

    if (route === "theme" && req.method === "POST") {
      assertSameOrigin(req);
      const { path: keyPath, value } = await readBody(req);
      const rel = await findThemeFile();
      const abs = path.join(root, rel);
      const before = await fs.readFile(abs, "utf8");
      const after = setThemeValue(before, rel, keyPath, value ?? null);
      if (after === before) return send(res, 200, { changed: false });
      await fs.writeFile(abs, after, "utf8");
      const summary = `theme ${keyPath.join(".")}=${value === null ? "(removed)" : JSON.stringify(value)}`;
      undo.push({ abs, rel, id: null, before, after, summary: `${rel} ${summary}` });
      if (undo.length > UNDO_LIMIT) undo.shift();
      log(`wrote ${rel} ${summary}`);
      return send(res, 200, { changed: true, undoDepth: undo.length });
    }

    if (route === "edit" && req.method === "POST") {
      assertSameOrigin(req);
      const { id, edit } = await readBody(req);
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
      await fs.writeFile(abs, after, "utf8");
      const summary = edit.type === "text"
        ? `text → ${JSON.stringify(edit.value)}`
        : edit.type === "move"
          ? `moved ${edit.position} ${edit.targetId} (now ${newId})`
          : `${edit.name}=${edit.value === null ? "(removed)" : JSON.stringify(edit.value)}`;
      undo.push({ abs, rel, id, before, after, summary: `${rel}:${line} ${summary}` });
      if (undo.length > UNDO_LIMIT) undo.shift();
      log(`wrote ${rel}:${line} ${summary}`);
      return send(res, 200, { id: newId, changed: true, undoDepth: undo.length });
    }

    if (route === "undo" && req.method === "POST") {
      assertSameOrigin(req);
      const entry = undo.pop();
      if (!entry) throw new EditError("Nothing to undo", 409);
      const current = await fs.readFile(entry.abs, "utf8");
      if (current !== entry.after) {
        throw new EditError(
          `${entry.rel} changed since that edit; undo it by hand`,
          409,
        );
      }
      await fs.writeFile(entry.abs, entry.before, "utf8");
      log(`undid ${entry.summary}`);
      // entry.id is the element's id before the edit, valid again now.
      return send(res, 200, { id: entry.id, undone: entry.summary, undoDepth: undo.length });
    }

    throw new EditError(`Unknown route ${req.method} ${route}`, 404);
  }

  return {
    name: "visual-edit",
    apply: "serve",
    enforce: "pre",

    configResolved(config) {
      root = path.resolve(config.root);
    },

    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.[jt]sx$/.test(file) || file.includes("/node_modules/")) return;
      const rel = path.relative(root, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return;
      return stampJsx(code, rel.split(path.sep).join("/"));
    },

    transformIndexHtml() {
      return [{
        tag: "script",
        attrs: { type: "module", src: OVERLAY_URL },
        injectTo: "body",
      }];
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (url === OVERLAY_URL) {
          res.setHeader("Content-Type", "text/javascript");
          res.end(await fs.readFile(OVERLAY_PATH, "utf8"));
          return;
        }
        if (!url.startsWith(API)) return next();
        const route = url.slice(API.length).split("?")[0];
        try {
          await handleApi(req, res, route);
        } catch (err) {
          const status = err instanceof EditError ? err.status : 500;
          log(`${req.method} ${route} failed (${status}): ${err.message}`);
          if (status === 500) console.error(err);
          send(res, status, { error: err.message });
        }
      });
      log("editor overlay enabled");
    },
  };
}
