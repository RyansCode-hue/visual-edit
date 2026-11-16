import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditor } from "../src/editor.js";

const ID = "dom:#root > h2:nth-of-type(1)";
const el = { description: "Title “Hi”" };

function urlEditor() {
  const e = createEditor({ claude: false });
  e.setUrlTarget("https://site.test");
  return e;
}

test("overrides fold into one entry per element, newest value winning", () => {
  const e = urlEditor();
  e.ops.override({ id: ID, page: "/login", edit: { type: "style", name: "color", value: "red" }, element: el, before: "rgb(0, 0, 0)" });
  e.ops.override({ id: ID, page: "/login", edit: { type: "style", name: "color", value: "blue" }, element: el, before: "red" });
  e.ops.override({ id: ID, page: "/login", edit: { type: "text", value: "Hello" }, element: el, before: "Hi" });
  assert.deepEqual(e.ops.effectiveOverrides(), [
    { page: "/login", selector: "#root > h2:nth-of-type(1)", styles: { color: "blue" }, text: "Hello" },
  ]);
  const [d] = e.ops.overrideDetails();
  // The site's own value stays "before", however many times it changed.
  assert.deepEqual(d.props.color, { before: "rgb(0, 0, 0)", after: "blue" });
  assert.deepEqual(d.text, { before: "Hi", after: "Hello" });
  assert.deepEqual(d.ns, [1, 2, 3]);
});

test("revert drops one change and redo brings it back", async () => {
  const e = urlEditor();
  e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "color", value: "red" }, element: el, before: "black" });
  e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "font-size", value: "20px" }, element: el, before: "16px" });
  await e.ops.revert({ n: 2 });
  assert.deepEqual(e.ops.effectiveOverrides()[0].styles, { color: "red" });
  await e.ops.redoLast();
  assert.deepEqual(e.ops.effectiveOverrides()[0].styles, { color: "red", "font-size": "20px" });
});

test("clearing a property removes it from the page's overrides", () => {
  const e = urlEditor();
  e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "color", value: "red" }, element: el });
  e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "color", value: "" }, element: el });
  assert.deepEqual(e.ops.effectiveOverrides()[0].styles, {});
});

test("overrides reject CSS that could break out of the rule", () => {
  const e = urlEditor();
  assert.throws(() => e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "color", value: "red} body{display:none" } }), /plain CSS value/);
  assert.throws(() => e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "color;x", value: "red" } }), /Not a CSS property/);
  assert.throws(() => e.ops.override({ id: "pages/a.tsx:1:1", page: "/", edit: { type: "text", value: "x" } }), /Bad element id/);
  assert.throws(() => e.ops.override({ id: ID, page: "/", edit: { type: "prop", name: "c", value: "red" } }), /text and styles/);
});

test("show original hides every override; repo-only operations explain themselves", async () => {
  const e = urlEditor();
  e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "color", value: "red" }, element: el });
  e.ops.setOriginal({ on: true });
  assert.throws(() => e.ops.override({ id: ID, page: "/", edit: { type: "style", name: "color", value: "blue" } }), /viewing the original/);
  await assert.rejects(e.ops.readThemeLeaves(), /opened on a URL/);
  assert.equal((await e.ops.config()).mode, "url");
  assert.equal((await e.ops.config()).claude.enabled, false);
});

test("the URL handoff covers every changed element", async () => {
  const e = urlEditor();
  e.ops.override({ id: ID, page: "/login", edit: { type: "style", name: "color", value: "red" }, element: el, before: "black" });
  const md = await e.ops.handoff({ target: "https://site.test" });
  assert.match(md, /Title “Hi” on \/login/);
  assert.match(md, /`color`: `black` → `red`/);
});
