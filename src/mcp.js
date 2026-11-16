// MCP server on /__ve/mcp: lets someone's own Claude (Claude Code on their
// subscription) see and drive the open editor, and pull the design handoff.
//
//   claude mcp add --transport http visual-edit http://localhost:5390/__ve/mcp \
//     --header "Authorization: Bearer <token from ~/.visual-edit/token>"
//
// Access: the host must be localhost (DNS-rebinding guard), a browser Origin
// must be localhost too, and every request needs the bearer token. Writes go
// through the same editor operations as the UI, so they are path-checked,
// logged in the change list and revertible.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EditError } from "./source.js";
import { send, log } from "./editor.js";
import { changeHunk } from "./handoff.js";
import { varsForKey } from "./mantine-vars.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The bearer token in ~/.visual-edit/token, created (0600) on first use. */
export function loadToken(dir = path.join(os.homedir(), ".visual-edit")) {
  const file = path.join(dir, "token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
    log(`${file} is too short to be a token; making a new one`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${t}\n`, { mode: 0o600 });
  return t;
}

/** Throws unless the request is local and carries the token. */
export function checkMcpAccess(req, token) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) throw new EditError(`MCP only answers on localhost, not ${host || "(no host)"}`, 403);
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = new URL(origin).hostname; } catch { oh = ""; }
    if (!LOCAL_HOSTS.has(oh) && !LOCAL_HOSTS.has(`[${oh}]`)) throw new EditError(`MCP refuses browser requests from ${origin}`, 403);
  }
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  const given = Buffer.from(m?.[1] ?? "");
  const want = Buffer.from(token);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new EditError("Missing or wrong MCP token (see ~/.visual-edit/token)", 401);
  }
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const image = (dataUrl) => {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(dataUrl ?? "");
  if (!m) throw new EditError("The editor page sent back something that isn't an image", 502);
  return { type: "image", mimeType: m[1], data: m[2] };
};
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** Builds the tool set for one request (stateless transport). */
export function buildMcpServer({ editor, live, target }) {
  const server = new McpServer({ name: "visual-edit", version: "0.1.0" }, {
    instructions: [
      "visual-edit is a visual editor open in the user's browser on a running web app.",
      "Use get_status first. get_selection tells you what the user has selected; element ids look like",
      "\"pages/dashboard.tsx:86:8\" (repo mode: file:line:column of the JSX tag) or \"dom:…\" (URL mode).",
      "In repo mode prefer edit_element / set_theme_value over editing files yourself, so the change shows in the",
      "editor's change list; if you do edit files directly, the editor logs them as \"edited outside the editor\".",
      "get_handoff returns the session's design changes as a prompt for implementing or reviewing them.",
    ].join(" "),
  });
  const mode = () => (editor.root ? "repo" : "url");

  server.registerTool("get_status", {
    title: "Editor status",
    description: "Mode (repo or url), what is being edited, whether the editor is open in a browser, its current page and selection, and the number of changes.",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const p = live.presence;
    const cfg = await editor.ops.config();
    return text({
      mode: mode(),
      editing: editor.root || target,
      editorOpen: live.connected,
      page: p.page,
      selection: p.selection,
      changes: editor.ops.listChanges().changes.length,
      questions: editor.ops.listQuestions().questions.length,
      showingOriginal: cfg.showOriginal,
      askClaudeRunning: editor.claudeRunning,
    });
  });

  server.registerTool("get_selection", {
    title: "Selected element",
    description: "What the user has selected in the editor. In repo mode: component, source location, current props and text, and every page that renders it (a change there shows on all of them).",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const sel = live.presence.selection;
    if (!sel) return text({ selection: null, note: live.connected ? "Nothing is selected." : "The editor isn't open in a browser." });
    if (mode() !== "repo") return text({ selection: sel, element: await live.request("describe", { id: sel.id }) });
    const [info, pages] = await Promise.all([
      editor.ops.inspectElement(sel.id),
      editor.ops.pagesOf(sel.id).catch((e) => ({ error: e.message })),
    ]);
    return text({ selection: sel, element: info, pages });
  });

  server.registerTool("get_page_elements", {
    title: "Elements on the page",
    description: "The current page's element tree as the editor's layers panel shows it: id, index (for repeated elements), component name and label. Use the ids with select or edit_element.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(await live.request("tree")));

  server.registerTool("list_pages", {
    title: "Pages",
    description: "Every page (route) of the app, found by reading its router. Repo mode only.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(await editor.ops.allPages()));

  server.registerTool("get_changes", {
    title: "Change list",
    description: "The editor's change list for this session, newest last, with a diff per change (repo mode) or before → after values (URL mode).",
    inputSchema: { diffs: z.boolean().optional().describe("Include a diff per change (default true)") },
    annotations: READ,
  }, async ({ diffs = true }) => {
    if (mode() !== "repo") return text({ elements: editor.ops.overrideDetails(), theme: editor.ops.themeDetails() });
    return text(editor.ops.changeDetails().map(({ before, after, ...c }) => (
      diffs ? { ...c, diff: changeHunk(c.rel, before, after) } : c
    )));
  });

  server.registerTool("get_handoff", {
    title: "Design handoff",
    description: "The session's design changes and the designer's questions, written as a prompt for implementing or reviewing them, plus a screenshot of the current page when the editor is open.",
    inputSchema: {
      notes: z.string().max(4000).optional().describe("Extra notes to include"),
      screenshot: z.boolean().optional().describe("Attach a screenshot of the current page (default true)"),
    },
    annotations: READ,
  }, async ({ notes, screenshot = true }) => {
    const content = [{ type: "text", text: await editor.ops.handoff({ notes, target }) }];
    if (screenshot && live.connected) {
      try {
        const { dataUrl } = await live.request("screenshot", { target: "page" }, 30_000);
        content.push(image(dataUrl));
      } catch (e) {
        content.push({ type: "text", text: `(No screenshot: ${e.message})` });
      }
    }
    return { content };
  });

  server.registerTool("screenshot", {
    title: "Screenshot",
    description: "A screenshot of the visible page or of the selected element, as the user sees it in the editor.",
    inputSchema: { target: z.enum(["page", "selection"]).optional().describe("Default: page") },
    annotations: READ,
  }, async ({ target: t = "page" }) => {
    const { dataUrl, page } = await live.request("screenshot", { target: t }, 30_000);
    return { content: [image(dataUrl), { type: "text", text: `Page ${page}${t === "selection" ? ", selected element" : ""}` }] };
  });

  server.registerTool("navigate", {
    title: "Go to page",
    description: "Opens a page of the app in the editor, e.g. \"/dashboard\".",
    inputSchema: { path: z.string().min(1).max(500) },
    annotations: { ...WRITE, readOnlyHint: true },
  }, async ({ path: p }) => text(await live.request("navigate", { path: p })));

  server.registerTool("select", {
    title: "Select element",
    description: "Selects an element in the editor so the user sees it highlighted. Pass no id to clear the selection.",
    inputSchema: {
      id: z.string().max(500).optional(),
      index: z.number().int().min(0).optional().describe("Which one, when the same element repeats (list rows); default 0"),
    },
    annotations: { ...WRITE, readOnlyHint: true },
  }, async ({ id, index = 0 }) => text(await live.request("select", { id: id ?? null, index })));

  server.registerTool("edit_element", {
    title: "Edit element",
    description: [
      "Changes one element through the editor; the change appears in its change list and can be reverted.",
      "Repo mode: {type:\"prop\", name, value} sets a JSX prop (null removes it; numbers and booleans stay typed;",
      "prefer Mantine props and theme tokens like mt=\"md\", c=\"blue.6\"), or {type:\"text\", value} replaces the text.",
      "URL mode: {type:\"style\", name, value} sets a CSS property, or {type:\"text\", value}.",
    ].join(" "),
    inputSchema: {
      id: z.string().min(1).max(500),
      edit: z.object({
        type: z.enum(["prop", "text", "style"]),
        name: z.string().max(100).optional(),
        value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
      }),
      label: z.string().max(200).optional().describe("How the change reads in the change list"),
    },
    annotations: WRITE,
  }, async ({ id, edit, label }) => {
    if (mode() !== "repo") {
      if (edit.type === "prop") throw new EditError("In URL mode, use type \"style\" with a CSS property (e.g. margin-top, color)");
      const el = await live.request("describe", { id });
      const r = editor.ops.override({
        id, page: el.page, label: label ? `Claude (MCP): ${label}` : undefined, source: "mcp",
        edit: { ...edit, value: edit.value === null ? null : String(edit.value) },
        element: { description: el.description },
        before: edit.type === "text" ? el.text?.value ?? null : el.styles?.[edit.name] ?? null,
      });
      return text(r);
    }
    if (edit.type === "style") throw new EditError("In repo mode, use type \"prop\" (Mantine style props like mt, c, fz)");
    return text(await editor.ops.edit({ id, edit, label: label ? `Claude (MCP): ${label}` : undefined, source: "mcp" }));
  });

  server.registerTool("get_theme", {
    title: "Theme values",
    description: "The design tokens and their current values. Repo mode: the Mantine theme file's values. URL mode: the CSS variables the page defines on :root (for Mantine sites, --mantine-spacing-xs etc.), with the site's own values of any this session changed.",
    inputSchema: { filter: z.string().max(100).optional().describe("Only names containing this text") },
    annotations: READ,
  }, async ({ filter }) => {
    const keep = (name) => !filter || name.includes(filter);
    if (mode() === "repo") {
      const t = await editor.ops.readThemeLeaves();
      return text({ file: t.file, values: t.leaves.filter((l) => keep(l.path.join("."))).map((l) => ({ path: l.path, value: l.value, kind: l.kind })) });
    }
    const t = await live.request("themeVars");
    return text({ mantine: t.mantine, vars: Object.fromEntries(Object.entries(t.vars).filter(([n]) => keep(n))), siteValuesOfChanged: t.site });
  });

  server.registerTool("set_theme_value", {
    title: "Set theme value",
    description: "Changes one theme value for every page. Path is a Mantine theme key, e.g. [\"spacing\",\"xs\"] with \"6px\" (numbers are px), [\"colors\",\"blue\",6] with \"#1c7ed6\", or [\"primaryColor\"] with \"teal\". Repo mode writes the theme file; URL mode sets the page's CSS variables, and also accepts a variable name as the path ([\"--mantine-spacing-xs\"]).",
    inputSchema: {
      path: z.array(z.union([z.string(), z.number()])).min(1).max(6),
      value: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
      label: z.string().max(200).optional(),
    },
    annotations: WRITE,
  }, async ({ path: p, value, label }) => {
    const lbl = label ? `Claude (MCP): ${label}` : undefined;
    if (mode() === "repo") return text(await editor.ops.setTheme({ path: p, value, label: lbl, source: "mcp" }));
    const t = await live.request("themeVars");
    let vars;
    try {
      vars = varsForKey(p, value, new Set(Object.keys(t.vars)));
    } catch (e) {
      throw new EditError(e.message);
    }
    const missing = Object.keys(vars).filter((n) => !(n in t.vars));
    if (missing.length) throw new EditError(`The page doesn't define ${missing.join(", ")}`);
    const before = Object.fromEntries(Object.keys(vars).map((n) => [n, t.site[n] ?? t.vars[n]]));
    return text(editor.ops.themeOverride({
      vars, before, key: p.join("."), source: "mcp",
      label: lbl ?? `Claude (MCP): theme ${p.join(".")} → ${value}`,
    }));
  });

  server.registerTool("revert_change", {
    title: "Revert change",
    description: "Reverts one change from the change list by its number n (from get_changes), or the newest when n is omitted.",
    inputSchema: { n: z.number().int().positive().optional() },
    annotations: { ...WRITE, destructiveHint: true },
  }, async ({ n }) => text(await editor.ops.revert({ n })));

  return server;
}

/** Registers /__ve/mcp on the editor. @returns the `claude mcp add` command */
export function mountMcp({ editor, live, target, token = loadToken() }) {
  editor.route("mcp", async (req, res) => {
    try {
      checkMcpAccess(req, token);
    } catch (e) {
      log(`MCP request refused: ${e.message}`);
      return send(res, e.status ?? 403, { error: e.message });
    }
    const server = buildMcpServer({ editor, live, target });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch((e) => log(`MCP transport close failed: ${e.message}`));
      server.close().catch((e) => log(`MCP server close failed: ${e.message}`));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  return (port) =>
    `claude mcp add --transport http visual-edit http://localhost:${port}/__ve/mcp --header "Authorization: Bearer $(cat ~/.visual-edit/token)"`;
}
