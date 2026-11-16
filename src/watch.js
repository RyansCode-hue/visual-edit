// Logs source edits made outside the editor (an IDE, or someone's own Claude
// editing files directly) in the change list, so they can be seen in the
// editor and reverted like any other change.
//
// Keeps the last known content of every text file under the app root and
// compares on each file-system event. Not logged: the editor's own writes
// (it records those itself), files added or deleted, and anything changed
// while Ask Claude runs (the run records its own before/after).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { snapshot } from "./claude.js";
import { log } from "./editor.js";

const TEXT_EXT = /\.(jsx?|tsx?|css|scss|html|json|md)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git)(\/|$)|(^|\/)\./;

export async function startWatcher(editor, { debounceMs = 300 } = {}) {
  const root = editor.root;
  const known = await snapshot(root); // rel → content
  const pending = new Set();
  let timer = null;
  let deferred = false;

  const warn = (msg) => {
    log(msg);
    editor.events.emit("warning", { message: msg });
  };

  async function flush() {
    if (editor.claudeRunning) { deferred = true; return; }
    const rels = [...pending];
    pending.clear();
    for (const rel of rels) {
      const abs = path.join(root, rel);
      let content;
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile() || st.size > 512 * 1024) continue;
        content = await fsp.readFile(abs, "utf8");
      } catch (e) {
        if (e.code === "ENOENT") {
          if (known.delete(rel)) log(`${rel} was deleted outside the editor (not in the change list)`);
          continue;
        }
        warn(`Couldn't read ${rel} after it changed: ${e.message}`);
        continue;
      }
      const own = editor.ownWrites.get(abs);
      if (own !== undefined) editor.ownWrites.delete(abs);
      const before = own ?? known.get(rel);
      known.set(rel, content);
      if (before === undefined) { log(`${rel} was added outside the editor (not in the change list)`); continue; }
      if (content === before) continue;
      try {
        await editor.noteFirstTouchFrom(abs, rel, before);
        editor.record(abs, rel, before, content, { label: `Edited outside the editor · ${rel}`, source: "external" });
      } catch (e) {
        warn(`Couldn't log the outside edit to ${rel}: ${e.message}`);
      }
    }
  }

  // After an Ask Claude run, its files are already recorded: take their
  // current content as known without logging them again.
  editor.events.on("claude", async ({ status }) => {
    if (status === "running" || !deferred) return;
    deferred = false;
    const rels = [...pending];
    pending.clear();
    for (const rel of rels) {
      try {
        known.set(rel, await fsp.readFile(path.join(root, rel), "utf8"));
        editor.ownWrites.delete(path.join(root, rel));
      } catch (e) {
        if (e.code === "ENOENT") known.delete(rel);
        else warn(`Couldn't read ${rel} after Ask Claude: ${e.message}`);
      }
    }
  });

  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.split(path.sep).join("/");
      if (!TEXT_EXT.test(rel) || SKIP.test(rel)) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => flush().catch((e) => warn(`Watching files failed: ${e.message}`)), debounceMs);
    });
  } catch (e) {
    warn(`Can't watch ${root} for outside edits: ${e.message}. Edits made outside the editor won't show in the change list.`);
    return { close() {} };
  }
  watcher.on("error", (e) => warn(`Stopped watching for outside edits: ${e.message}`));
  log(`watching ${known.size} files for outside edits`);
  return {
    close() { clearTimeout(timer); watcher.close(); },
    /** For tests: process pending events now. */
    flush,
  };
}
