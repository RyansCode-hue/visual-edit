// Design tokens exported from Figma, compared with the app's Mantine theme.
// Pure functions (no DOM) so the shell and the unit tests share them.
//
// Accepts the common export shapes:
//   - W3C design tokens:  { color: { atticusInk: { 6: { $value: "#0071CE" } } } }
//   - Tokens Studio:      { color: { atticusInk: { 6: { value: "#0071CE", type: "color" } } } }
//   - Figma variables (REST /variables/local or plugin exports):
//       { meta: { variables: { id: { name: "color/atticusInk/6", valuesByMode, resolvedType } } } }
//   - A flat list:        [{ name: "color/atticusInk/6", value: "#0071CE" }]
// Compared: colour ramps, spacing, radius and font sizes.

const seg = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const segments = (name) => String(name).split(/[/.]+/).map(seg).filter(Boolean);

const hex2 = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");

/** A colour in any common notation → "#RRGGBB", or null. */
export function normalizeColor(v) {
  if (v && typeof v === "object" && "r" in v && "g" in v && "b" in v) {
    return `#${hex2(v.r)}${hex2(v.g)}${hex2(v.b)}`.toUpperCase();
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return `#${m[1].split("").map((c) => c + c).join("")}`.toUpperCase();
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
  if (m) return `#${m[1]}`.toUpperCase();
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return null;
}

/** A size → px number, or null. "13px" → 13, "0.8125rem" → 13, 13 → 13. */
export function normalizeSize(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const m = /^(-?\d*\.?\d+)\s*(px|rem|em)?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] && m[2].toLowerCase() !== "px" ? Math.round(n * 16 * 100) / 100 : n;
}

/** Flattens any supported export to [{ name, segs, value }]. */
export function flattenTokens(json) {
  const out = [];
  const add = (name, value) => out.push({ name, segs: segments(name), value });

  // Figma variables export
  const vars = json?.meta?.variables ?? (Array.isArray(json?.variables) ? Object.fromEntries(json.variables.map((v) => [v.id ?? v.name, v])) : null);
  if (vars && typeof vars === "object") {
    const collections = json?.meta?.variableCollections ?? {};
    const resolve = (val, depth = 0) => {
      if (val && val.type === "VARIABLE_ALIAS" && depth < 10) {
        const target = vars[val.id];
        return target ? resolve(firstValue(target), depth + 1) : null;
      }
      return val;
    };
    const firstValue = (v) => {
      const modes = v.valuesByMode ?? {};
      const def = collections[v.variableCollectionId]?.defaultModeId;
      return def && def in modes ? modes[def] : Object.values(modes)[0] ?? v.value;
    };
    for (const v of Object.values(vars)) {
      if (v?.name) add(v.name, resolve(firstValue(v)));
    }
    return out;
  }

  if (Array.isArray(json)) {
    for (const t of json) if (t && t.name !== undefined) add(t.name, t.value ?? t.$value);
    return out;
  }

  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if ("$value" in node) return add(path.join("/"), node.$value);
    if ("value" in node && (typeof node.value !== "object" || "r" in node.value)) return add(path.join("/"), node.value);
    for (const [k, v] of Object.entries(node)) if (!k.startsWith("$")) walk(v, [...path, k]);
  };
  walk(json, []);
  return out;
}

const SCALE_PARENTS = {
  spacing: ["spacing", "space", "spacer", "spaces", "gap"],
  radius: ["radius", "radii", "borderradius", "cornerradius", "corner", "rounded"],
  fontSizes: ["fontsize", "fontsizes", "size", "textsize", "fontscale"],
};

function findToken(tokens, leaf) {
  const [group, a, b] = leaf.path;
  if (group === "colors" && leaf.path.length === 3) {
    const want = [seg(a), String(b)];
    return tokens.find((t) => t.segs.length >= 2 &&
      t.segs[t.segs.length - 2] === want[0] && t.segs[t.segs.length - 1] === want[1]);
  }
  if (SCALE_PARENTS[group] && leaf.path.length === 2) {
    return tokens.find((t) => t.segs.length >= 2 &&
      t.segs[t.segs.length - 1] === seg(a) && SCALE_PARENTS[group].includes(t.segs[t.segs.length - 2]));
  }
  return undefined;
}

/**
 * @param tokens  output of flattenTokens
 * @param leaves  theme leaves from GET /__ve/theme
 * @returns {{ diffs, same, checked, missingInFigma, figmaOnly }}
 */
export function compareTokens(tokens, leaves) {
  const diffs = [];
  const missingInFigma = [];
  const used = new Set();
  let same = 0;
  let checked = 0;
  for (const leaf of leaves) {
    const isColor = leaf.path[0] === "colors" && leaf.path.length === 3 && typeof leaf.value === "string";
    const isSize = SCALE_PARENTS[leaf.path[0]] && leaf.path.length === 2 && typeof leaf.value === "number";
    if (!isColor && !isSize) continue;
    checked++;
    const token = findToken(tokens, leaf);
    if (!token) { missingInFigma.push(leaf.path.join(".")); continue; }
    used.add(token);
    const code = isColor ? normalizeColor(leaf.value) : leaf.value;
    const figma = isColor ? normalizeColor(token.value) : normalizeSize(token.value);
    if (figma === null) continue;
    if (code === figma) same++;
    else diffs.push({ path: leaf.path, kind: leaf.kind, code: leaf.value, figma, figmaName: token.name });
  }
  return { diffs, same, checked, missingInFigma, figmaOnly: tokens.length - used.size };
}
