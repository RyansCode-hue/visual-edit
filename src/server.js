// The standalone editor: one local HTTP server carrying the editor (shell,
// API, MCP) and the app, served either by its own Vite (repo mode) or by a
// proxy to a live site (URL mode).

import http from "node:http";
import { createEditor, log } from "./editor.js";
import { startViteAdapter } from "./adapters/vite.js";
import { createLive } from "./live.js";
import { mountMcp } from "./mcp.js";
import { startWatcher } from "./watch.js";

const HOST = "127.0.0.1";

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const onError = (e) => {
        server.off("listening", onListening);
        if (e.code === "EADDRINUSE" && left > 0) tryPort(p + 1, left - 1);
        else reject(e);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, HOST);
    };
    tryPort(port, 20);
  });
}

/**
 * @param {object} o
 * @param {string} [o.appDir]   repo mode: the app folder (with its own Vite)
 * @param {string} [o.url]      URL mode: the site to edit
 * @param {number} [o.port]
 * @param {object} [o.options]  editor options (see createEditor)
 * @param {string} [o.token]    MCP bearer token (default: ~/.visual-edit/token)
 * @returns {Promise<{ url, port, editor, live, mcpCommand, close }>}
 */
export async function startServer({ appDir, url, port = 5390, options = {}, token }) {
  const editor = createEditor(options);
  if (url) editor.setUrlTarget(url);
  const live = createLive(editor);
  const mcpCommandFor = mountMcp({ editor, live, target: url ?? appDir, ...(token ? { token } : {}) });
  let app = null;
  const httpServer = http.createServer((req, res) => {
    editor.middleware(req, res, () => {
      if (!app) {
        res.statusCode = 503;
        res.end("Starting…");
        return;
      }
      app.middleware(req, res, () => {
        res.statusCode = 404;
        res.end("Not found");
      });
    });
  });

  let watcher = null;
  if (appDir) {
    app = await startViteAdapter({ appDir, editor, httpServer });
    watcher = await startWatcher(editor);
  } else if (url) {
    const { startProxyAdapter } = await import("./adapters/proxy.js");
    app = await startProxyAdapter({ target: url, editor, httpServer });
  } else {
    throw new Error("Give an app folder or a URL");
  }

  const actual = await listen(httpServer, port);
  const base = `http://localhost:${actual}`;
  log(`${appDir ? `repo mode: ${appDir}` : `URL mode: ${url}`}`);
  return {
    url: base,
    port: actual,
    editor,
    live,
    mcpCommand: mcpCommandFor(actual),
    async close() {
      watcher?.close();
      await app?.close?.();
      await new Promise((r) => httpServer.close(r));
    },
  };
}
