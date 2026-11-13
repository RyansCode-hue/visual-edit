import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readTheme, setThemeValue, isMantineComponent } from "../src/theme.js";

// Snapshot of atticus-backoffice src/web-app/main.tsx.
const SRC = fs.readFileSync(new URL("./fixture-main.tsx.txt", import.meta.url), "utf8");
const F = "main.tsx";
const get = (leaves, ...path) => leaves.find((l) => l.path.join(".") === path.join("."));
const set = (path, value, code = SRC) => setThemeValue(code, F, path, value);

test("reads tokens, following named colour ramps and marking aliases", () => {
  const t = readTheme(SRC, F);
  assert.deepEqual(get(t, "colors", "atticusInk", 6), { path: ["colors", "atticusInk", 6], kind: "string", value: "#0071CE", source: undefined });
  assert.equal(get(t, "colors", "atticusNeutral").kind, "alias");
  assert.equal(get(t, "colors", "atticusNeutral").value, "atticusParchment");
  assert.equal(get(t, "spacing", "md").kind, "rem");
  assert.equal(get(t, "spacing", "md").value, 13);
  assert.equal(get(t, "primaryShade").value, 6);
  assert.equal(get(t, "headings", "fontWeight").value, "600");
  assert.equal(get(t, "components", "Badge", "defaultProps", "radius").value, "sm");
});

test("edits values where they are written, keeping quote style", () => {
  assert.equal(set(["colors", "atticusInk", 6], "#0066BB"),
    SRC.replace("'#0071CE',", "'#0066BB',"));
  assert.equal(set(["spacing", "md"], 14), SRC.replace("md: rem(13)", "md: rem(14)"));
  assert.equal(set(["primaryColor"], "atticusBrass"),
    SRC.replace("primaryColor: 'atticusInk'", "primaryColor: 'atticusBrass'"));
  assert.equal(set(["fontFamily"], 'Inter, "Helvetica Neue", sans-serif'),
    SRC.replace(`fontFamily: 'Barlow, "Helvetica Neue", Arial, sans-serif'`,
      `fontFamily: 'Inter, "Helvetica Neue", sans-serif'`));
});

test("adds a new component default with the file's layout", () => {
  const out = set(["components", "Button", "defaultProps", "radius"], "md");
  assert.ok(out.includes(`    Badge: {
      defaultProps: {
        radius: 'sm',
      },
    },
    Button: {
      defaultProps: {
        radius: 'md',
      },
    },
  },
})`), out.slice(out.indexOf("components:"), out.indexOf("createRoot")));
  const more = set(["components", "Button", "defaultProps", "size"], "xs", out);
  assert.match(more, /radius: 'md',\n        size: 'xs',\n      },/);
  const table = set(["components", "Table", "defaultProps", "striped"], "odd");
  assert.match(table, /fontSize: 'sm',\n        striped: 'odd',\n      },/);
});

test("removes a key and its line", () => {
  const out = set(["components", "Table", "defaultProps", "fontSize"], null);
  assert.equal(out, SRC.replace("        fontSize: 'sm',\n", ""));
});

test("refuses aliases, rem with text, and bad paths", () => {
  assert.throws(() => set(["colors", "atticusNeutral"], "x"), /isn't a plain value/);
  assert.throws(() => set(["spacing", "md"], "big"), /number of px/);
  assert.throws(() => set(["colors", "atticusInk", 10], "#fff"), /array entries/);
  assert.throws(() => set(["x;y"], 1), /Bad theme key/);
});

test("detects Mantine components by import", () => {
  const page = `import { Card, Text } from "@mantine/core";\nimport { StatCard } from "./stat";\n`;
  assert.equal(isMantineComponent(page, "p.tsx", "Card"), true);
  assert.equal(isMantineComponent(page, "p.tsx", "StatCard"), false);
  assert.equal(isMantineComponent(page, "p.tsx", "Card.Section"), false);
});
