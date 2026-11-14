import { test } from "node:test";
import assert from "node:assert/strict";
import { regionDiff, revertChange, slug } from "../src/changes.js";

const A = `<Stack>\n  <Text c="dimmed">Hi</Text>\n  <Button radius="sm">Go</Button>\n</Stack>\n`;
const B = A.replace('c="dimmed"', 'c="atticusInk"');           // change 1
const C = B.replace('radius="sm"', 'radius="xl"');              // change 2

test("regionDiff finds the changed span", () => {
  const d = regionDiff(A, B);
  assert.equal(A.slice(0, d.start) + d.added + A.slice(d.start + d.removed.length), B);
  assert.match(d.removed, /dimmed/);
  assert.match(d.added, /atticusInk/);
});

test("reverting the newest change restores exactly", () => {
  assert.equal(revertChange(C, { before: B, after: C }), B);
});

test("reverting an older change keeps later ones", () => {
  const out = revertChange(C, { before: A, after: B });
  assert.equal(out, A.replace('radius="sm"', 'radius="xl"'));
});

test("refuses when a later change rewrote the same spot", () => {
  const D = B.replace('c="atticusInk"', 'c="red"');
  assert.throws(() => revertChange(D, { before: A, after: B }), /overlaps a later one/);
});

test("slug makes safe branch names", () => {
  assert.equal(slug("Rounder buttons & new  subtitle!"), "rounder-buttons-new-subtitle");
  assert.equal(slug("???"), "design-change");
});
