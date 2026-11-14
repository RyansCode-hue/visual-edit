// Session change log helpers.
//
// Every write records the whole file before and after. Reverting the newest
// change to a file is an exact restore; reverting an older one replaces just
// the region that change touched, located in the current file by its
// surrounding text, so later unrelated edits survive.

import { EditError } from "./source.js";

/** The single contiguous region where `before` and `after` differ. */
export function regionDiff(before, after) {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;
  return {
    start,
    removed: before.slice(start, before.length - tail),
    added: after.slice(start, after.length - tail),
  };
}

/** Returns `current` with one recorded change undone. */
export function revertChange(current, change) {
  if (current === change.after) return change.before;
  const d = regionDiff(change.before, change.after);
  const end = d.start + d.added.length;
  for (const context of [40, 20, 8, 0]) {
    const pre = change.after.slice(Math.max(0, d.start - context), d.start);
    const post = change.after.slice(end, end + context);
    const needle = pre + d.added + post;
    if (needle === "") break;
    const i = current.indexOf(needle);
    if (i === -1) continue;
    if (current.indexOf(needle, i + 1) !== -1) continue; // ambiguous, need more context
    const at = i + pre.length;
    return current.slice(0, at) + d.removed + current.slice(at + d.added.length);
  }
  throw new EditError(
    "This change overlaps a later one. Revert the later change first.",
    409,
  );
}

/** Branch-name-safe slug. */
export function slug(text, max = 40) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "") || "design-change";
}
