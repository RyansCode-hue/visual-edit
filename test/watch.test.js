import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEditor } from "../src/editor.js";
import { startWatcher } from "../src/watch.js";

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
// File-system events can arrive late when the machine is busy.
async function waitFor(check, w, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await w.flush();
    if (check()) return;
    await settle(50);
  }
  assert.fail("timed out waiting for the watcher");
}

test("edits made outside the editor are logged and revertible; the editor's own are not logged twice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ve-watch-"));
  const file = path.join(root, "a.tsx");
  const A = "export const A = () => <p>one</p>;\n";
  fs.writeFileSync(file, A);
  const editor = createEditor({ claude: false });
  editor.setRepo({ root });
  const w = await startWatcher(editor, { debounceMs: 20 });
  try {
    // Someone else (an IDE, a terminal Claude) edits the file.
    const B = A.replace("one", "two");
    fs.writeFileSync(file, B);
    await waitFor(() => editor.ops.listChanges().changes.length > 0, w);
    let list = editor.ops.listChanges().changes;
    assert.equal(list.length, 1);
    assert.equal(list[0].source, "external");
    assert.match(list[0].label, /Edited outside the editor · a\.tsx/);

    // Reverting goes through the editor's own write: not logged again.
    await editor.ops.revert({});
    // The watcher sees the revert's own write and drops it.
    await waitFor(() => !editor.ownWrites.has(file), w);
    assert.equal(fs.readFileSync(file, "utf8"), A);
    list = editor.ops.listChanges().changes;
    assert.equal(list.length, 0);
  } finally {
    w.close();
  }
});
