// URL mode: serves a live site through a local reverse proxy, so the editor
// can load it in its iframe on its own origin and inject the canvas.
//
// Rewrites per response:
//   - HTML: the editor's scripts are injected (data.js first in <head>,
//     stamp-dom.js and canvas.js at the end of <body>).
//   - Content-Security-Policy and X-Frame-Options are dropped: the site's
//     policy would block the injected scripts and the iframe. This only
//     affects the local copy.
//   - Set-Cookie: Domain and Secure are dropped and SameSite=None becomes
//     Lax, so the site's cookies work on http://localhost (and stay there).
//   - Location headers pointing at the site are made relative.
// Requests: Host, Origin and Referer are rewritten to the site, and
// Accept-Encoding is limited to identity so HTML can be rewritten.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { CANVAS_URL, DATA_URL, log } from "../editor.js";

export const STAMP_URL = "/@visual-edit/stamp-dom.js";
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

export function rewriteSetCookie(cookie) {
  return cookie
    .split(";")
    .map((p) => p.trim())
    .filter((p) => !/^domain=/i.test(p) && !/^secure$/i.test(p) && !/^partitioned$/i.test(p))
    .map((p) => (/^samesite=none$/i.test(p) ? "SameSite=Lax" : p))
    .join("; ");
}

export function rewriteLocation(location, target) {
  try {
    const u = new URL(location, target);
    return u.origin === new URL(target).origin ? `${u.pathname}${u.search}${u.hash}` : location;
  } catch {
    return location;
  }
}

export function injectScripts(html) {
  const head = `<script src="${DATA_URL}"></script>`;
  const body = `<script src="${STAMP_URL}"></script><script type="module" src="${CANVAS_URL}"></script>`;
  let out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : head + html;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${body}</body>`) : out + body;
  return out;
}

/** Response headers for the local copy. */
export function rewriteResponseHeaders(headers, target) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP.has(key) || key.startsWith("content-security-policy") || key === "x-frame-options" ||
      key === "strict-transport-security" || key === "alt-svc") continue;
    if (key === "set-cookie") out[k] = (Array.isArray(v) ? v : [v]).map(rewriteSetCookie);
    else if (key === "location") out[k] = rewriteLocation(v, target);
    else out[k] = v;
  }
  return out;
}

export async function startProxyAdapter({ target, editor, httpServer }) {
  const t = new URL(target);
  if (!/^https?:$/.test(t.protocol)) throw new Error(`Only http(s) sites can be opened, not ${t.protocol}`);
  const client = t.protocol === "https:" ? https : http;
  editor.script(STAMP_URL, fileURLToPath(new URL("../stamp-dom.js", import.meta.url)));
  // A quick check that the site answers, so a wrong URL fails at start.
  await new Promise((resolve, reject) => {
    const r = client.request(t, { method: "HEAD", timeout: 10_000 }, (res) => { res.resume(); resolve(); });
    r.on("timeout", () => r.destroy(new Error("timed out after 10s")));
    r.on("error", (e) => reject(new Error(`Can't reach ${t.origin}: ${e.message}`)));
    r.end();
  });

  const requestHeaders = (req) => {
    const h = { ...req.headers, host: t.host, "accept-encoding": "identity" };
    for (const k of Object.keys(h)) if (HOP.has(k)) delete h[k];
    if (h.origin) h.origin = t.origin;
    if (h.referer) h.referer = h.referer.replace(/^https?:\/\/[^/]+/, t.origin);
    return h;
  };

  function middleware(req, res) {
    const upstream = client.request({
      protocol: t.protocol, hostname: t.hostname, port: t.port || undefined,
      method: req.method, path: req.url, headers: requestHeaders(req),
    }, (up) => {
      const headers = rewriteResponseHeaders(up.headers, t.origin);
      const isHtml = /text\/html/i.test(up.headers["content-type"] ?? "") && req.method !== "HEAD";
      if (!isHtml) {
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
        return;
      }
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        let raw = Buffer.concat(chunks);
        // Some servers compress even when asked for identity.
        const enc = String(up.headers["content-encoding"] ?? "").toLowerCase();
        try {
          if (enc === "gzip") raw = zlib.gunzipSync(raw);
          else if (enc === "br") raw = zlib.brotliDecompressSync(raw);
          else if (enc === "deflate") raw = zlib.inflateSync(raw);
        } catch (e) {
          log(`proxy: couldn't decompress ${req.url} (${enc}): ${e.message}`);
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`visual-edit couldn't read the page from ${t.origin} (${enc}): ${e.message}`);
          return;
        }
        for (const k of Object.keys(headers)) if (/^content-(length|encoding)$/i.test(k)) delete headers[k];
        const body = Buffer.from(injectScripts(raw.toString("utf8")), "utf8");
        headers["content-length"] = body.length;
        headers["cache-control"] = "no-store";
        res.writeHead(up.statusCode ?? 200, headers);
        res.end(body);
      });
      up.on("error", (e) => {
        log(`proxy: reading ${req.url} from ${t.origin} failed: ${e.message}`);
        res.destroy(e);
      });
    });
    upstream.on("error", (e) => {
      log(`proxy: ${req.method} ${req.url} → ${t.origin} failed: ${e.message}`);
      if (!res.headersSent) { res.statusCode = 502; res.end(`visual-edit couldn't reach ${t.origin}: ${e.message}`); }
      else res.destroy(e);
    });
    req.pipe(upstream);
  }

  // WebSockets (live updates on the site) are piped through untouched.
  httpServer.on("upgrade", (req, socket, head) => {
    const up = client.request({
      protocol: t.protocol, hostname: t.hostname, port: t.port || undefined,
      method: req.method, path: req.url, headers: { ...req.headers, host: t.host, origin: t.origin },
    });
    up.on("upgrade", (upRes, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
    });
    up.on("response", (r) => { socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`); });
    up.on("error", (e) => { log(`proxy: websocket ${req.url} failed: ${e.message}`); socket.destroy(); });
    up.end();
  });

  log(`proxying ${t.origin}`);
  return { middleware, close: async () => {} };
}
