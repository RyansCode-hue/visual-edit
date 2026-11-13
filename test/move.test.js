import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMove, inspect } from "../src/source.js";

const FILE = "pages/m.tsx";
const SRC = `export function M({ rows, show }) {
  return (
    <Stack gap="md">
      <Title>Heading</Title>
      <Card withBorder>
        <Text>One</Text>
      </Card>
      {show && <Badge>New</Badge>}
      <Group>
        <Button>A</Button><Button>B</Button>
      </Group>
      {rows.map((r) => (
        <Row key={r.id}>{r.name}</Row>
      ))}
    </Stack>
  );
}
`;
const id = (l, c) => `${FILE}:${l}:${c}`;
const move = (l, c, targetId, position) =>
  applyMove(SRC, FILE, l, c, { targetId, position });

test("reports siblings in order, and why some elements can't move", () => {
  const card = inspect(SRC, FILE, 5, 6).move;
  assert.equal(card.movable, true);
  assert.equal(card.index, 1);
  assert.deepEqual(card.order, [[id(4, 6)], [id(5, 6)], [id(8, 15)], [id(9, 6)]]);
  assert.ok(!card.targets.includes(id(6, 8)), "own child is not a target");
  assert.equal(inspect(SRC, FILE, 13, 8).move.movable, false);
  assert.match(inspect(SRC, FILE, 13, 8).move.reason, /list/);
  assert.equal(inspect(SRC, FILE, 3, 4).move.movable, false);
});

test("moves a multi-line element up past a sibling", () => {
  const r = move(5, 6, id(4, 6), "before");
  assert.equal(r.code, SRC.replace(
    "      <Title>Heading</Title>\n      <Card withBorder>\n        <Text>One</Text>\n      </Card>\n",
    "      <Card withBorder>\n        <Text>One</Text>\n      </Card>\n      <Title>Heading</Title>\n",
  ));
  assert.equal(r.id, id(4, 6));
});

test("moves an element down, after a later sibling", () => {
  const r = move(4, 6, id(9, 6), "after");
  const lines = r.code.split("\n");
  assert.equal(lines[3], "      <Card withBorder>");
  assert.equal(lines[9], "      </Group>");
  assert.equal(lines[10], "      <Title>Heading</Title>");
  assert.equal(r.id, id(11, 6));
});

test("moves a conditional together with its condition", () => {
  const r = move(8, 15, id(4, 6), "before");
  assert.match(r.code, /<Stack gap="md">\n      \{show && <Badge>New<\/Badge>\}\n      <Title>/);
  assert.equal(r.id, id(4, 15));
});

test("moves into another container, re-indented", () => {
  const r = move(4, 6, id(6, 8), "after");
  assert.match(r.code, /<Text>One<\/Text>\n        <Title>Heading<\/Title>\n      <\/Card>/);
  assert.equal(r.id, id(6, 8));
});

test("swaps inline siblings", () => {
  const r = move(10, 26, id(10, 8), "before");
  assert.match(r.code, /<Button>B<\/Button><Button>A<\/Button>/);
  assert.equal(r.id, id(10, 8));
});

test("no-op and invalid moves", () => {
  assert.equal(move(5, 6, id(4, 6), "after").code, SRC);
  assert.throws(() => move(5, 6, id(6, 8), "after"), /inside itself/);
  assert.throws(() => move(13, 8, id(4, 6), "before"), /order comes from code/);
  assert.throws(() => move(4, 6, id(13, 8), "before"), /Can't drop there/);
  assert.throws(() => move(4, 6, "other.tsx:1:0", "before"), /between files/);
});
