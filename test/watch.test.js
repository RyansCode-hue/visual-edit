import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEditor } from "../src/editor.js";
import { startWatcher } from "../src/watch.js";

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

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
    await settle();
    await w.flush();
    let list = editor.ops.listChanges().changes;
    assert.equal(list.length, 1);
    assert.equal(list[0].source, "external");
    assert.match(list[0].label, /Edited outside the editor · a\.tsx/);

    // Reverting goes through the editor's own write: not logged again.
    await editor.ops.revert({});
    await settle();
    await w.flush();
    assert.equal(fs.readFileSync(file, "utf8"), A);
    list = editor.ops.listChanges().changes;
    assert.equal(list.length, 0);
  } finally {
    w.close();
  }
});
