// Where a design token or component is used in the app's source, so the
// editor can say how far a theme change reaches before it is applied.
//
// Counts are textual (regex over source files): good enough to tell "3
// places" from "300", not a type-checked reference search.

const SPACING_PROPS = "(?:m|p)[trblxy]?|gap|spacing|rowGap|columnGap|maw|miw|mah|mih";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tokenValue = (t) => `(?:"${esc(t)}"|'${esc(t)}'|\\{\\s*["']${esc(t)}["']\\s*\\})`;

/** RegExp (global) matching uses of one token/component, or null. */
export function usagePattern(kind, name) {
  if (typeof name !== "string" || !/^[\w.-]{1,60}$/.test(name)) return null;
  switch (kind) {
    case "component":
      return new RegExp(`<${esc(name)}(?=[\\s/>])`, "g");
    case "color":
      // `c="atticusInk"`, `color="atticusInk.6"`, `var(--mantine-color-atticusInk-6)`
      return new RegExp(`(?:["'\`]${esc(name)}(?:\\.\\d)?["'\`]|--mantine-color-${esc(name)}-)`, "g");
    case "spacing":
      return new RegExp(`\\b(?:${SPACING_PROPS})=${tokenValue(name)}`, "g");
    case "radius":
      return new RegExp(`\\bradius=${tokenValue(name)}`, "g");
    case "fontSize":
      return new RegExp(`\\b(?:size|fz)=${tokenValue(name)}`, "g");
    default:
      return null;
  }
}

/**
 * @param {{rel: string, code: string}[]} files
 * @returns {{count: number, files: {rel: string, count: number}[]}}
 */
export function countUsage(files, kind, name) {
  const re = usagePattern(kind, name);
  if (!re) return null;
  const hits = [];
  for (const { rel, code } of files) {
    const n = (code.match(re) ?? []).length;
    if (n) hits.push({ rel, count: n });
  }
  hits.sort((a, b) => b.count - a.count);
  return { count: hits.reduce((s, h) => s + h.count, 0), files: hits };
}
