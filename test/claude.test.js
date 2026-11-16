import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs, childEnv, describeEvent, diffSnapshots } from "../src/claude.js";

test("runs fenced: dontAsk, folder-scoped tools, no shell/web/new files, project settings only", () => {
  const a = claudeArgs({ prompt: "hi" });
  const after = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--setting-sources"), "project");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.ok(!a.includes("--bare"), "--bare skips the subscription login");
  const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
  assert.deepEqual(allowed, ["Read(./**)", "Edit(./**)", "Glob(./**)", "Grep(./**)"]);
  for (const t of ["Bash", "Write", "WebFetch", "WebSearch", "Agent"]) assert.ok(a.includes(t), t);
});

test("child environment keeps only basics: no API keys or parent-session variables", () => {
  const env = childEnv({ HOME: "/h", PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", SECRET: "x" });
  assert.deepEqual(env, { HOME: "/h", PATH: "/bin" });
});

test("progress lines name files relative to the app folder", () => {
  const lines = describeEvent({
    type: "assistant",
    message: { content: [
      { type: "tool_use", name: "Read", input: { file_path: "/app/pages/a.tsx" } },
      { type: "tool_use", name: "Grep", input: { pattern: "Search" } },
      { type: "text", text: " Done. " },
    ] },
  }, "/app");
  assert.deepEqual(lines, ["Reading pages/a.tsx", "Searching for “Search”", "Done."]);
  assert.equal(describeEvent({ type: "system" }, "/app"), null);
});

test("snapshot diff finds changed, added and deleted files", () => {
  const before = new Map([["a", "1"], ["b", "2"], ["c", "3"]]);
  const after = new Map([["a", "1"], ["b", "22"], ["d", "4"]]);
  assert.deepEqual(diffSnapshots(before, after), [
    { rel: "b", before: "2", after: "22" },
    { rel: "d", before: "", after: "4", added: true },
    { rel: "c", before: "3", after: "", deleted: true },
  ]);
});
