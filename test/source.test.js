import { test } from "node:test";
import assert from "node:assert/strict";
import { stampJsx, inspect, applyEdit } from "../src/source.js";

const FILE = "pages/demo.tsx";
const SRC = `import { Card, Group, Text } from "@mantine/core";

export function Demo({ count, ok }: { count: number; ok: boolean }) {
  return (
    <>
      <Card shadow="xs" padding="lg" withBorder>
        <Group justify="space-between" mb={6}>
          <Text size="sm" c="dimmed">
            Active staff
          </Text>
          <Text c={ok ? "green" : "red"}>{count}</Text>
        </Group>
        <Text
          size="xl"
          fw={600}
        >Total</Text>
      </Card>
    </>
  );
}
`;

test("stamps elements with location and name, skipping fragments", () => {
  const out = stampJsx(SRC, FILE).code;
  assert.match(out, /<Card data-ve="pages\/demo.tsx:6:6" data-ve-n="Card" shadow/);
  assert.match(out, /<Group data-ve="pages\/demo.tsx:7:8"/);
  assert.doesNotMatch(out, /<> data-ve/);
  assert.equal((out.match(/data-ve=/g) || []).length, 5);
});

test("inspect classifies props and text", () => {
  const card = inspect(SRC, FILE, 6, 6);
  assert.equal(card.name, "Card");
  assert.deepEqual(card.attrs.map((a) => [a.name, a.kind, a.value]), [
    ["shadow", "string", "xs"],
    ["padding", "string", "lg"],
    ["withBorder", "boolean", true],
  ]);
  assert.equal(card.text.editable, false);

  const label = inspect(SRC, FILE, 8, 10);
  assert.deepEqual(label.text, { editable: true, value: "Active staff" });

  const dynamic = inspect(SRC, FILE, 11, 10);
  assert.equal(dynamic.attrs[0].kind, "computed");
  assert.equal(dynamic.text.editable, false);
  assert.equal(dynamic.text.reason, "comes from code/data");
});

test("changes an existing prop in place, nothing else", () => {
  const out = applyEdit(SRC, FILE, 7, 8, { type: "prop", name: "mb", value: "md" });
  assert.equal(out, SRC.replace("mb={6}", 'mb="md"'));
  const num = applyEdit(SRC, FILE, 6, 6, { type: "prop", name: "padding", value: 24 });
  assert.equal(num, SRC.replace('padding="lg"', "padding={24}"));
});

test("adds a prop inline or on its own line to match layout", () => {
  const inline = applyEdit(SRC, FILE, 8, 10, { type: "prop", name: "fw", value: 700 });
  assert.equal(inline, SRC.replace('c="dimmed">', 'c="dimmed" fw={700}>'));
  const multi = applyEdit(SRC, FILE, 13, 8, { type: "prop", name: "w", value: 240 });
  assert.equal(multi, SRC.replace("fw={600}\n", "fw={600}\n          w={240}\n"));
});

test("removes a prop with its leading whitespace", () => {
  const out = applyEdit(SRC, FILE, 6, 6, { type: "prop", name: "withBorder", value: null });
  assert.equal(out, SRC.replace(" withBorder>", ">"));
});

test("refuses to edit computed props", () => {
  assert.throws(
    () => applyEdit(SRC, FILE, 11, 10, { type: "prop", name: "c", value: "blue" }),
    (e) => e.status === 422,
  );
});

test("edits text, keeping surrounding whitespace", () => {
  const out = applyEdit(SRC, FILE, 8, 10, { type: "text", value: "Active people" });
  assert.equal(out, SRC.replace("Active staff", "Active people"));
  const braces = applyEdit(SRC, FILE, 13, 8, { type: "text", value: "a {b}" });
  assert.match(braces, />\{"a \{b\}"\}<\/Text>/);
});

test("refuses text edits on dynamic content and stale locations", () => {
  assert.throws(
    () => applyEdit(SRC, FILE, 11, 10, { type: "text", value: "x" }),
    (e) => e.status === 422,
  );
  assert.throws(
    () => applyEdit(SRC, FILE, 99, 0, { type: "text", value: "x" }),
    (e) => e.status === 409,
  );
});

test("writes booleans as bare or {false} attributes", () => {
  const off = applyEdit(SRC, FILE, 6, 6, { type: "prop", name: "withBorder", value: false });
  assert.equal(off, SRC.replace(" withBorder>", " withBorder={false}>"));
  assert.equal(inspect(off, FILE, 6, 6).attrs[2].value, false);
  const on = applyEdit(off, FILE, 6, 6, { type: "prop", name: "withBorder", value: true });
  assert.equal(on, SRC);
  const added = applyEdit(SRC, FILE, 8, 10, { type: "prop", name: "inherit", value: true });
  assert.equal(added, SRC.replace('c="dimmed">', 'c="dimmed" inherit>'));
});
