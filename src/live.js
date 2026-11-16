// Live channel between the server and the open editor page (the shell).
//
// - GET  /__ve/events    Server-Sent Events to the shell: commands from MCP
//                        (navigate, select, screenshot) and "changed" notices.
// - POST /__ve/presence  the shell reports its page and selection.
// - POST /__ve/reply     the shell answers a command by reqId.
//
// Commands go to the most recently connected shell; with none open, they
// fail with a message saying to open the editor.

import { randomUUID } from "node:crypto";
import { EditError } from "./source.js";
import { readBody, send, log } from "./editor.js";

const MAX_REPLY = 20 * 1024 * 1024; // screenshots come back as data URLs

export function createLive(editor) {
  const clients = []; // { id, res }
  const pending = new Map(); // reqId → { resolve, reject, timer }
  const presence = { page: null, selection: null, at: null };

  const sseWrite = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const c of clients) sseWrite(c.res, event, data); };

  editor.events.on("changed", (d) => broadcast("changed", d));
  editor.events.on("claude", (d) => broadcast("claude", d));
  editor.events.on("warning", (d) => broadcast("warning", d));

  const assertLocalJson = (req) => {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new EditError("Expected application/json", 415);
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new EditError(`Cross-origin request from ${origin}`, 403);
  };

  editor.route("events", async (req, res) => {
    if (req.method !== "GET") throw new EditError("GET only", 405);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const client = { id: randomUUID(), res };
    clients.push(client);
    sseWrite(res, "hello", { id: client.id });
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      const i = clients.indexOf(client);
      if (i >= 0) clients.splice(i, 1);
    });
  });

  editor.route("presence", async (req, res) => {
    assertLocalJson(req);
    const { page, selection } = await readBody(req);
    presence.page = typeof page === "string" ? page.slice(0, 500) : null;
    presence.selection = selection && typeof selection.id === "string"
      ? { id: selection.id, index: Number(selection.index) || 0, label: String(selection.label ?? "").slice(0, 200) }
      : null;
    presence.at = Date.now();
    send(res, 200, { ok: true });
  });

  editor.route("reply", async (req, res) => {
    assertLocalJson(req);
    const { reqId, ok, result, error } = await readBody(req, MAX_REPLY);
    const p = pending.get(reqId);
    if (!p) return send(res, 404, { error: "No such request (it may have timed out)" });
    pending.delete(reqId);
    clearTimeout(p.timer);
    if (ok) p.resolve(result);
    else p.reject(new EditError(String(error ?? "The editor page couldn't do that"), 422));
    send(res, 200, { ok: true });
  });

  /** Sends a command to the open editor page and waits for its answer. */
  function request(type, payload = {}, timeoutMs = 15_000) {
    const client = clients[clients.length - 1];
    if (!client) {
      return Promise.reject(new EditError("The visual editor isn't open in a browser. Open it (the Editor URL printed at start) and try again.", 409));
    }
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        log(`live ${type} timed out`);
        reject(new EditError(`The editor page didn't answer "${type}" within ${timeoutMs / 1000}s`, 504));
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      sseWrite(client.res, "command", { reqId, type, ...payload });
    });
  }

  return {
    request,
    broadcast,
    get connected() { return clients.length > 0; },
    get presence() { return { ...presence }; },
  };
}
