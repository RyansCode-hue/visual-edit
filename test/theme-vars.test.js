import { test } from "node:test";
import assert from "node:assert/strict";
import { themeKeyFor, varsForKey, primaryColorVars, toPx } from "../src/mantine-vars.js";
import { createEditor } from "../src/editor.js";

const DEFINED = new Set([
  "--mantine-spacing-xs", "--mantine-color-teal-6", "--mantine-color-teal-0", "--mantine-color-teal-filled",
  "--mantine-primary-color-0", "--mantine-primary-color-6", "--mantine-primary-color-filled", "--mantine-primary-color-light",
]);

test("variables map back to the Mantine theme keys they come from", () => {
  assert.equal(themeKeyFor("--mantine-spacing-xs"), "theme.spacing.xs");
  assert.equal(themeKeyFor("--mantine-font-size-lg"), "theme.fontSizes.lg");
  assert.equal(themeKeyFor("--mantine-color-atticusInk-6"), "theme.colors.atticusInk[6]");
  assert.equal(themeKeyFor("--mantine-primary-color-filled"), "theme.primaryColor");
  assert.equal(themeKeyFor("--mantine-h2-font-size"), "theme.headings.sizes.h2.fontSize");
  assert.equal(themeKeyFor("--mantine-font-family-headings"), "theme.headings.fontFamily");
  assert.equal(themeKeyFor("--mantine-color-blue-filled"), null);
});

test("theme keys map to variables; numbers are px", () => {
  assert.deepEqual(varsForKey(["spacing", "xs"], 12, DEFINED), { "--mantine-spacing-xs": "12px" });
  assert.deepEqual(varsForKey(["colors", "teal", 6], "#0f0", DEFINED), { "--mantine-color-teal-6": "#0f0" });
  assert.deepEqual(varsForKey(["--brand-gap"], "4px", DEFINED), { "--brand-gap": "4px" });
  assert.throws(() => varsForKey(["breakpoints", "sm"], "1px", DEFINED), /No page variable/);
});

test("the primary colour switches only variables the page defines for both", () => {
  // teal has no "light" variable here, so the primary "light" one is left alone.
  assert.deepEqual(primaryColorVars("teal", DEFINED), {
    "--mantine-primary-color-0": "var(--mantine-color-teal-0)",
    "--mantine-primary-color-6": "var(--mantine-color-teal-6)",
    "--mantine-primary-color-filled": "var(--mantine-color-teal-filled)",
  });
  assert.throws(() => primaryColorVars("nope", DEFINED), /no colour/);
  assert.throws(() => primaryColorVars("x;y", DEFINED), /Not a colour name/);
});

test("lengths read as px", () => {
  assert.equal(toPx("calc(0.375rem * 1)"), 6);
  assert.equal(toPx("0.5rem"), 8);
  assert.equal(toPx("24px"), 24);
  assert.equal(toPx("#fff"), null);
});

function urlEditor() {
  const e = createEditor({ claude: false });
  e.setUrlTarget("https://site.test");
  return e;
}

test("theme changes fold into one set of variables and keep the site's value as before", async () => {
  const e = urlEditor();
  e.ops.themeOverride({ vars: { "--mantine-spacing-md": "20px" }, before: { "--mantine-spacing-md": "calc(0.8125rem * 1)" } });
  e.ops.themeOverride({ vars: { "--mantine-spacing-md": "24px" }, before: { "--mantine-spacing-md": "20px" } });
  e.ops.themeOverride({ vars: { "--mantine-radius-default": "12px" } });
  assert.deepEqual(e.ops.effectiveThemeVars(), { "--mantine-spacing-md": "24px", "--mantine-radius-default": "12px" });
  assert.equal(e.ops.themeDetails()[1].vars["--mantine-spacing-md"].before, "calc(0.8125rem * 1)");
  assert.equal(e.ops.listChanges().changes[0].rel, "theme · every page");
  await e.ops.revert({});
  assert.deepEqual(e.ops.effectiveThemeVars(), { "--mantine-spacing-md": "24px" });
});

test("theme variables reject anything that isn't a plain variable and value", () => {
  const e = urlEditor();
  assert.throws(() => e.ops.themeOverride({ vars: { color: "red" } }), /Not a CSS variable/);
  assert.throws(() => e.ops.themeOverride({ vars: { "--x": "red } body { display:none" } }), /plain CSS value/);
  assert.throws(() => e.ops.themeOverride({ vars: {} }), /Nothing to change/);
  const repo = createEditor({ claude: false });
  repo.setRepo({ root: "/tmp" });
  assert.throws(() => repo.ops.themeOverride({ vars: { "--x": "1px" } }), /URL mode/);
});

test("the handoff gives theme keys, with the primary colour as one value", async () => {
  const e = urlEditor();
  e.ops.themeOverride({
    vars: primaryColorVars("teal", DEFINED), key: "primaryColor", label: "Theme: primary colour blue → teal",
    before: { "--mantine-primary-color-6": "#228be6" },
  });
  e.ops.themeOverride({ vars: { "--mantine-spacing-xs": "8px" }, before: { "--mantine-spacing-xs": "calc(0.375rem * 1)" } });
  const md = await e.ops.handoff({ target: "https://site.test" });
  assert.match(md, /## Theme \(every page\)/);
  assert.match(md, /`theme\.primaryColor` → `"teal"` \(3 CSS variables\)/);
  assert.match(md, /`--mantine-spacing-xs` \(`theme\.spacing\.xs`\): `calc\(0\.375rem \* 1\)` → `8px`/);
});
