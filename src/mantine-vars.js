// Mantine theme keys ↔ the CSS variables Mantine puts on :root, for theme
// editing in URL mode (no theme file, only the running page's variables).

const SIZES = "xs|sm|md|lg|xl";

/** The theme key a variable comes from, e.g. --mantine-spacing-xs → spacing.xs. */
export function themeKeyFor(name) {
  let m;
  if ((m = new RegExp(`^--mantine-(spacing|radius|font-size|line-height|shadow)-(${SIZES})$`).exec(name))) {
    const group = { spacing: "spacing", radius: "radius", "font-size": "fontSizes", "line-height": "lineHeights", shadow: "shadows" }[m[1]];
    return `theme.${group}.${m[2]}`;
  }
  if ((m = /^--mantine-color-([A-Za-z]+)-(\d)$/.exec(name))) return `theme.colors.${m[1]}[${m[2]}]`;
  if (/^--mantine-primary-color-/.test(name)) return "theme.primaryColor";
  if ((m = /^--mantine-(h[1-6])-(font-size|line-height|font-weight)$/.exec(name))) {
    return `theme.headings.sizes.${m[1]}.${m[2] === "font-size" ? "fontSize" : m[2] === "line-height" ? "lineHeight" : "fontWeight"}`;
  }
  return {
    "--mantine-font-family": "theme.fontFamily",
    "--mantine-font-family-monospace": "theme.fontFamilyMonospace",
    "--mantine-font-family-headings": "theme.headings.fontFamily",
    "--mantine-heading-font-weight": "theme.headings.fontWeight",
    "--mantine-radius-default": "theme.defaultRadius",
    "--mantine-color-white": "theme.white",
    "--mantine-color-black": "theme.black",
  }[name] ?? null;
}

// Primary-colour variables and the per-colour variable each one follows.
const PRIMARY_SUFFIXES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "filled", "filled-hover", "light", "light-hover", "light-color", "outline", "outline-hover", "contrast"];

/** Variables that switch the primary colour to `color`, among those the page defines. */
export function primaryColorVars(color, defined) {
  if (!/^[A-Za-z][\w]*$/.test(color)) throw new Error(`Not a colour name: ${color}`);
  if (!defined.has(`--mantine-color-${color}-6`)) throw new Error(`The page has no colour “${color}”`);
  const vars = {};
  for (const s of PRIMARY_SUFFIXES) {
    const name = `--mantine-primary-color-${s}`;
    if (defined.has(name) && defined.has(`--mantine-color-${color}-${s}`)) vars[name] = `var(--mantine-color-${color}-${s})`;
  }
  return vars;
}

/**
 * A theme key path (as for the theme file) → the variables to set.
 * ["spacing","xs"] → { "--mantine-spacing-xs": value }; ["primaryColor"] → the
 * primary-colour variables; ["--mantine-…"] sets that variable directly.
 * Numbers are taken as px.
 */
export function varsForKey(path, value, defined) {
  const v = value === null ? null : typeof value === "number" ? `${value}px` : String(value);
  const [a, b, c] = path.map(String);
  if (a.startsWith("--")) return { [a]: v };
  if (a === "primaryColor") return primaryColorVars(String(value), defined);
  const group = { spacing: "spacing", radius: "radius", fontSizes: "font-size", lineHeights: "line-height", shadows: "shadow" }[a];
  if (group && b) return { [`--mantine-${group}-${b}`]: v };
  if (a === "colors" && b && c !== undefined) return { [`--mantine-color-${b}-${c}`]: v };
  const single = {
    fontFamily: "--mantine-font-family", fontFamilyMonospace: "--mantine-font-family-monospace",
    defaultRadius: "--mantine-radius-default", white: "--mantine-color-white", black: "--mantine-color-black",
  }[a];
  if (single && !b) return { [single]: v };
  if (a === "headings" && b === "fontFamily") return { "--mantine-font-family-headings": v };
  if (a === "headings" && b === "fontWeight") return { "--mantine-heading-font-weight": v };
  throw new Error(`No page variable for theme.${path.join(".")}`);
}

/** "calc(0.375rem * 1)" / "0.5rem" / "12px" → px, or null when it isn't a length. */
export function toPx(value, rootPx = 16) {
  const s = String(value ?? "").trim();
  let m;
  if ((m = /^calc\(\s*([\d.]+)rem\s*\*\s*([\d.]+)\s*\)$/.exec(s))) return Math.round(Number(m[1]) * Number(m[2]) * rootPx * 100) / 100;
  if ((m = /^([\d.]+)rem$/.exec(s))) return Math.round(Number(m[1]) * rootPx * 100) / 100;
  if ((m = /^([\d.]+)px$/.exec(s))) return Number(m[1]);
  return null;
}
