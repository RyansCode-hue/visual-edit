// The handoff: a session's design changes written up as a prompt for a
// coding agent (or a developer), with a diff per change in repo mode and
// before → after values in URL mode.

/** One unified-diff hunk for a change: the differing lines with 3 lines of context. */
export function changeHunk(rel, before, after, context = 3) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (start === endA && start === endB) return "";
  const from = Math.max(0, start - context);
  const toA = Math.min(a.length, endA + context);
  const toB = Math.min(b.length, endB + context);
  const lines = [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ];
  return lines.join("\n");
}

const SOURCE_NAMES = {
  editor: "made in the editor",
  mcp: "made by Claude over MCP",
  "ask-claude": "made by Ask Claude",
  external: "edited outside the editor",
  override: "made in the editor (URL mode)",
};

/**
 * @param {object} o
 * @param {"repo"|"url"} o.mode
 * @param {string} o.target         app folder or site URL
 * @param {object[]} o.changes      repo: { n, rel, label, before, after, pages, source }
 *                                  url:  { n, label, page, element, props: {name: {before, after}}, text }
 * @param {object[]} o.questions    { label, id, route, text }
 * @param {string} [o.notes]
 * @param {string[]} [o.screenshots] file names to mention
 */
export function handoffMarkdown({ mode, target, changes, questions, notes, screenshots = [] }) {
  const out = [];
  out.push(`# Design changes from the visual editor`, "");
  if (mode === "repo") {
    out.push(
      `These changes were made with the visual editor on the app in \`${target}\` and are already in the working tree.`,
      "Review them, keep or adjust them, and follow up on the questions.",
      "",
    );
  } else {
    out.push(
      `These changes were made with the visual editor on the live site ${target}. They exist only as overrides in the editor; nothing in the code has changed yet.`,
      "Implement each change in the codebase that serves this site, the way that codebase normally styles things (prefer the design system's components and tokens over raw CSS). Where one change looks like it belongs in a shared component or the theme, say so before changing it.",
      "",
    );
  }

  if (!changes.length) out.push("_No changes yet._", "");
  changes.forEach((c, i) => {
    out.push(`## ${i + 1}. ${c.label}`, "");
    if (mode === "repo") {
      out.push(`- File: \`${c.rel}\``);
      if (c.source && SOURCE_NAMES[c.source]) out.push(`- ${SOURCE_NAMES[c.source][0].toUpperCase()}${SOURCE_NAMES[c.source].slice(1)}`);
      if (c.pages?.list?.length > 1) {
        out.push(`- Shared: part of ${c.pages.component}, shown on ${c.pages.list.length} pages (${c.pages.list.map((p) => p.path).join(", ")})`);
      }
      const hunk = changeHunk(c.rel, c.before, c.after);
      if (hunk) out.push("", "```diff", hunk, "```");
    } else {
      out.push(`- Page: \`${c.page}\``);
      out.push(`- Element: ${c.element.description}`);
      if (c.element.path) out.push(`- DOM path: \`${c.element.path}\``);
      for (const [name, v] of Object.entries(c.props ?? {})) {
        out.push(`- \`${name}\`: \`${v.before ?? "(unset)"}\` → \`${v.after ?? "(unset)"}\``);
      }
      if (c.text) out.push(`- Text: “${c.text.before}” → “${c.text.after}”`);
    }
    out.push("");
  });

  if (questions.length) {
    out.push("## Questions", "");
    for (const q of questions) out.push(`- **${q.label}** (page \`${q.route}\`): ${q.text}`);
    out.push("");
  }
  if (notes?.trim()) out.push("## Notes", "", notes.trim(), "");
  if (screenshots.length) {
    out.push("## Screenshots", "", ...screenshots.map((s) => `- ${s}`), "");
  }
  return out.join("\n");
}
