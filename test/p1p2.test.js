import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { countUsage, usagePattern } from "../src/usage.js";
import { flattenTokens, compareTokens, normalizeColor, normalizeSize } from "../src/shell/tokens.js";

// ---------- usage ----------
const FILES = [
  { rel: "a.tsx", code: `<Button radius="xl">Go</Button><Button>B</Button><ButtonGroup/>\n<Text c="atticusInk" mb="md" gap={"md"}/>` },
  { rel: "b.tsx", code: `<Badge color="atticusInk.6" p="md" px='md'/>\nconst x = "var(--mantine-color-atticusInk-6)"; <Text size="md"/>` },
];

test("counts component uses, not prefixes", () => {
  assert.deepEqual(countUsage(FILES, "component", "Button"), { count: 2, files: [{ rel: "a.tsx", count: 2 }] });
});

test("counts colour, spacing, font-size and radius tokens", () => {
  assert.equal(countUsage(FILES, "color", "atticusInk").count, 3);
  assert.equal(countUsage(FILES, "spacing", "md").count, 4);
  assert.equal(countUsage(FILES, "fontSize", "md").count, 1);
  assert.equal(countUsage(FILES, "radius", "xl").count, 1);
});

test("rejects bad queries", () => {
  assert.equal(usagePattern("component", "a(b"), null);
  assert.equal(usagePattern("nope", "x"), null);
});

// ---------- data states ----------
const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL("../src/data.js", import.meta.url), "utf8"), { window: sandbox, console });
const transform = sandbox.__veTransform;
const DATA = { items: [{ id: 1, name: "Ada Lovelace", status: "ACTIVE", email: "ada@x.org" }], total: 1, title: "Donors" };

test("empty state clears lists and keeps the rest", () => {
  assert.equal(JSON.stringify(transform(DATA, "empty")), JSON.stringify({ items: [], total: 1, title: "Donors" }));
});

test("long state lengthens human text only", () => {
  const out = transform(DATA, "long");
  assert.match(out.items[0].name, /^Ada Lovelace and a considerably longer/);
  assert.equal(out.items[0].status, "ACTIVE");
  assert.equal(out.items[0].email, "ada@x.org");
});

test("many state fills lists to 25 with unique ids", () => {
  const out = transform(DATA, "many");
  assert.equal(out.items.length, 25);
  assert.equal(new Set(out.items.map((i) => i.id)).size, 25);
});

// ---------- Figma tokens ----------
const LEAVES = [
  { path: ["colors", "atticusInk", 6], kind: "string", value: "#0071CE" },
  { path: ["colors", "atticusInk", 7], kind: "string", value: "#005CB0" },
  { path: ["spacing", "md"], kind: "rem", value: 13 },
  { path: ["spacing", "xl"], kind: "rem", value: 26 },
  { path: ["primaryShade"], kind: "number", value: 6 },
];

test("normalizes colours and sizes", () => {
  assert.equal(normalizeColor("#0071ce"), "#0071CE");
  assert.equal(normalizeColor("#abc"), "#AABBCC");
  assert.equal(normalizeColor({ r: 0, g: 0.443, b: 0.808, a: 1 }), "#0071CE");
  assert.equal(normalizeColor("rgb(0, 113, 206)"), "#0071CE");
  assert.equal(normalizeSize("0.8125rem"), 13);
  assert.equal(normalizeSize("13px"), 13);
});

test("compares W3C tokens with the theme", () => {
  const w3c = {
    color: { "atticus-ink": { 6: { $value: "#0071CE", $type: "color" }, 7: { $value: "#0060B8" } } },
    spacing: { md: { $value: "14px" } },
  };
  const r = compareTokens(flattenTokens(w3c), LEAVES);
  assert.equal(r.checked, 4);
  assert.equal(r.same, 1);
  assert.deepEqual(r.diffs.map((d) => [d.path.join("."), d.figma]), [["colors.atticusInk.7", "#0060B8"], ["spacing.md", 14]]);
  assert.deepEqual(r.missingInFigma, ["spacing.xl"]);
});

test("reads Figma variables exports, resolving aliases and default modes", () => {
  const figma = { meta: {
    variableCollections: { c1: { defaultModeId: "m1" } },
    variables: {
      v1: { name: "Primitives/atticusInk/6", variableCollectionId: "c1", valuesByMode: { m1: { r: 0, g: 0.443, b: 0.808, a: 1 }, m2: { r: 1, g: 1, b: 1, a: 1 } } },
      v2: { name: "Space/md", variableCollectionId: "c1", valuesByMode: { m1: 13 } },
      v3: { name: "Brand/atticusInk/7", variableCollectionId: "c1", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "v1" } } },
    },
  } };
  const r = compareTokens(flattenTokens(figma), LEAVES);
  assert.equal(r.same, 2);
  assert.deepEqual(r.diffs.map((d) => [d.path.join("."), d.figma]), [["colors.atticusInk.7", "#0071CE"]]);
});
