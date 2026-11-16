import { test } from "node:test";
import assert from "node:assert/strict";
import { changeHunk, handoffMarkdown } from "../src/handoff.js";

const BEFORE = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");

test("a hunk shows the changed lines with three lines of context", () => {
  const after = BEFORE.replace("e", "E");
  assert.equal(changeHunk("x.tsx", BEFORE, after),
    ["--- a/x.tsx", "+++ b/x.tsx", "@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h"].join("\n"));
});

test("added lines change the new side's length", () => {
  const after = BEFORE.replace("a\n", "a\nnew\n");
  const hunk = changeHunk("x.tsx", BEFORE, after);
  assert.match(hunk, /@@ -1,4 \+1,5 @@/);
  assert.match(hunk, /^\+new$/m);
});

test("no change, no hunk", () => {
  assert.equal(changeHunk("x.tsx", BEFORE, BEFORE), "");
});

test("repo handoff lists each change with its diff, shared pages and questions", () => {
  const md = handoffMarkdown({
    mode: "repo", target: "/app",
    changes: [{
      n: 1, rel: "a.tsx", label: "Title colour", before: BEFORE, after: BEFORE.replace("c", "C"), source: "mcp",
      pages: { component: "Header", list: [{ path: "/" }, { path: "/b" }] },
    }],
    questions: [{ label: "Logo", route: "/", text: "Bigger?" }],
    notes: "Thanks",
  });
  assert.match(md, /## 1\. Title colour/);
  assert.match(md, /Made by Claude over MCP/);
  assert.match(md, /part of Header, shown on 2 pages \(\/, \/b\)/);
  assert.match(md, /```diff\n--- a\/a\.tsx/);
  assert.match(md, /\*\*Logo\*\* \(page `\/`\): Bigger\?/);
  assert.match(md, /## Notes\n\nThanks/);
});

test("URL handoff says nothing is in the code yet and lists before → after", () => {
  const md = handoffMarkdown({
    mode: "url", target: "https://uat.test",
    changes: [{
      label: "Title on /login", page: "/login",
      element: { description: "Title “Hi”", path: "#root > h2" },
      props: { color: { before: "rgb(0, 0, 0)", after: "#7c3aed" } },
      text: { before: "Hi", after: "Hello" },
    }],
    questions: [],
    screenshots: ["after.png: with"],
  });
  assert.match(md, /live site https:\/\/uat\.test/);
  assert.match(md, /nothing in the code has changed yet/);
  assert.match(md, /`color`: `rgb\(0, 0, 0\)` → `#7c3aed`/);
  assert.match(md, /Text: “Hi” → “Hello”/);
  assert.match(md, /## Screenshots\n\n- after\.png: with/);
});
