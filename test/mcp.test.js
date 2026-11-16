import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEditor } from "../src/editor.js";
import { buildMcpServer, checkMcpAccess, loadToken } from "../src/mcp.js";

const TOKEN = "t".repeat(64);
const req = (headers) => ({ headers: { host: "localhost:5390", authorization: `Bearer ${TOKEN}`, ...headers } });

test("MCP needs localhost and the token", () => {
  assert.doesNotThrow(() => checkMcpAccess(req({}), TOKEN));
  assert.doesNotThrow(() => checkMcpAccess(req({ host: "127.0.0.1:5390", origin: "http://localhost:5390" }), TOKEN));
  assert.throws(() => checkMcpAccess(req({ authorization: undefined }), TOKEN), /token/);
  assert.throws(() => checkMcpAccess(req({ authorization: "Bearer nope" }), TOKEN), /token/);
  // DNS rebinding: a page on another name that resolves to 127.0.0.1.
  assert.throws(() => checkMcpAccess(req({ host: "evil.test:5390" }), TOKEN), /only answers on localhost/);
  assert.throws(() => checkMcpAccess(req({ origin: "https://evil.test" }), TOKEN), /refuses browser requests/);
});

test("the token is created once, private to the user", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-token-"));
  const a = loadToken(dir);
  assert.equal(a.length, 64);
  assert.equal(loadToken(dir), a);
  assert.equal(fs.statSync(path.join(dir, "token")).mode & 0o777, 0o600);
});

// A stand-in for the open editor page.
function fakeLive() {
  const sel = { id: "dom:#root > h2:nth-of-type(1)", index: 0, label: "Title “Hi”" };
  return {
    connected: true,
    presence: { page: "/login", selection: sel },
    async request(type, args) {
      if (type === "describe") {
        return { id: args.id, page: "/login", description: "Title “Hi”", text: { editable: true, value: "Hi" }, styles: { color: "rgb(0, 0, 0)" } };
      }
      if (type === "screenshot") return { dataUrl: "data:image/png;base64,iVBORw0KGgo=", page: "/login" };
      throw new Error(`unexpected ${type}`);
    },
  };
}

async function connect(editor, live) {
  const server = buildMcpServer({ editor, live, target: "https://site.test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}
const textOf = (r) => r.content.find((c) => c.type === "text").text;

test("URL mode over MCP: edit the selection, then read it back in the handoff", async () => {
  const editor = createEditor({ claude: false });
  editor.setUrlTarget("https://site.test");
  const client = await connect(editor, fakeLive());

  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["get_status", "get_selection", "edit_element", "get_handoff", "screenshot", "revert_change"]) assert.ok(tools.includes(t), t);

  const status = JSON.parse(textOf(await client.callTool({ name: "get_status", arguments: {} })));
  assert.equal(status.mode, "url");
  assert.equal(status.selection.label, "Title “Hi”");

  const edit = await client.callTool({ name: "edit_element", arguments: {
    id: status.selection.id, edit: { type: "style", name: "color", value: "#7c3aed" }, label: "brand title",
  } });
  assert.equal(JSON.parse(textOf(edit)).changed, true);
  assert.equal(editor.ops.listChanges().changes[0].source, "mcp");

  const handoff = await client.callTool({ name: "get_handoff", arguments: {} });
  assert.match(textOf(handoff), /`color`: `rgb\(0, 0, 0\)` → `#7c3aed`/);
  assert.equal(handoff.content.find((c) => c.type === "image").mimeType, "image/png");

  await client.callTool({ name: "revert_change", arguments: {} });
  assert.equal(editor.ops.listChanges().changes.length, 0);
});

test("errors come back as tool errors, not silence", async () => {
  const editor = createEditor({ claude: false });
  editor.setUrlTarget("https://site.test");
  const client = await connect(editor, fakeLive());
  const r = await client.callTool({ name: "edit_element", arguments: {
    id: "dom:#x", edit: { type: "prop", name: "c", value: "red" },
  } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /use type "style"/);
  const t = await client.callTool({ name: "set_theme_value", arguments: { path: ["primaryColor"], value: "teal" } });
  assert.equal(t.isError, true);
  assert.match(textOf(t), /opened on a URL/);
});
