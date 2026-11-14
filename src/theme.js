// Reads and writes the Mantine theme: the object passed to createTheme().
//
// The theme is flattened to leaves addressed by path, e.g.
//   ["spacing", "md"], ["colors", "atticusInk", 6],
//   ["components", "Button", "defaultProps", "radius"].
// Values referenced by name (`colors: { atticusInk }`) are followed to their
// top-level const, so an edit lands where the value is actually written.

import { parseSource, EditError } from "./source.js";

const unwrap = (n) =>
  n && ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(n.type)
    ? unwrap(n.expression)
    : n;

function keyOf(prop) {
  if (prop.computed) return null;
  const k = prop.key;
  if (k.type === "Identifier") return k.name;
  if (k.type === "StringLiteral") return k.value;
  if (k.type === "NumericLiteral") return String(k.value);
  return null;
}

function topLevelConsts(ast) {
  const consts = new Map();
  for (let stmt of ast.program.body) {
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) stmt = stmt.declaration;
    if (stmt.type !== "VariableDeclaration") continue;
    for (const d of stmt.declarations) {
      if (d.id.type === "Identifier" && d.init) consts.set(d.id.name, unwrap(d.init));
    }
  }
  return consts;
}

function findThemeObject(ast) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "createTheme" &&
      unwrap(node.arguments[0])?.type === "ObjectExpression"
    ) {
      found.push(unwrap(node.arguments[0]));
    }
    for (const k of Object.keys(node)) {
      if (k === "loc") continue;
      const c = node[k];
      if (Array.isArray(c)) c.forEach(visit);
      else if (c && typeof c.type === "string") visit(c);
    }
  };
  visit(ast.program);
  if (found.length !== 1) {
    throw new EditError(`Expected one createTheme({...}) call, found ${found.length}`, 422);
  }
  return found[0];
}

function collect(code, ast) {
  const consts = topLevelConsts(ast);
  const seen = new Set();
  const entries = []; // { path, kind, value?, source?, node, prop? }

  const walk = (raw, path, prop) => {
    const node = unwrap(raw);
    const leaf = (kind, value) => entries.push({ path, kind, value, node, prop });
    switch (node.type) {
      case "ObjectExpression":
        entries.push({ path, kind: "object", node, prop });
        for (const p of node.properties) {
          if (p.type !== "ObjectProperty") {
            entries.push({ path: [...path, "..."], kind: "computed", source: code.slice(p.start, p.end), node: p });
            continue;
          }
          const k = keyOf(p);
          if (k !== null) walk(p.value, [...path, k], p);
        }
        return;
      case "ArrayExpression":
        node.elements.forEach((e, i) => e && walk(e, [...path, i], null));
        return;
      case "StringLiteral":
        return leaf("string", node.value);
      case "TemplateLiteral":
        if (node.expressions.length === 0) return leaf("string", node.quasis[0].value.cooked);
        break;
      case "NumericLiteral":
        return leaf("number", node.value);
      case "BooleanLiteral":
        return leaf("boolean", node.value);
      case "CallExpression": {
        const c = node.callee;
        if (
          c.type === "Identifier" && (c.name === "rem" || c.name === "em") &&
          node.arguments.length === 1 && node.arguments[0].type === "NumericLiteral"
        ) {
          return entries.push({ path, kind: c.name, value: node.arguments[0].value, node, prop });
        }
        // Button.extend({ defaultProps }) is the typed form of { defaultProps }.
        if (
          c.type === "MemberExpression" && c.property.name === "extend" &&
          unwrap(node.arguments[0])?.type === "ObjectExpression"
        ) {
          return walk(node.arguments[0], path, prop);
        }
        break;
      }
      case "Identifier": {
        const target = consts.get(node.name);
        if (!target) break;
        if (seen.has(target)) {
          return entries.push({ path, kind: "alias", value: node.name, node, prop });
        }
        seen.add(target);
        return walk(target, path, prop);
      }
    }
    leaf("computed", undefined);
    entries[entries.length - 1].source = code.slice(node.start, node.end);
  };

  const theme = findThemeObject(ast);
  walk(theme, [], null);
  return entries;
}

const pathKey = (p) => p.join("\u0000");

function quoteStyle(code, entries) {
  const s = entries.find((e) => e.kind === "string" && e.node.type === "StringLiteral");
  return s ? code[s.node.start] : '"';
}

function quote(s, q) {
  return q + String(s).replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), `\\${q}`) + q;
}

const formatKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function formatValue(value, kind, q) {
  if (kind === "rem" || kind === "em") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EditError(`Expected a number of px for ${kind}()`);
    }
    return `${kind}(${value})`;
  }
  if (kind === "string") return quote(value, q);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EditError("Number is not finite");
    return String(value);
  }
  if (typeof value === "string") return quote(value, q);
  throw new EditError(`Unsupported value: ${typeof value}`);
}

function lineStart(code, pos) {
  return code.lastIndexOf("\n", pos - 1) + 1;
}

function ownLine(code, node) {
  const start = lineStart(code, node.start);
  return /^[ \t]*$/.test(code.slice(start, node.start));
}

function insertInto(code, obj, entryFor) {
  const props = obj.properties;
  if (props.length === 0) {
    const indent = code.slice(lineStart(code, obj.start)).match(/^[ \t]*/)[0];
    const inner = `${indent}  `;
    return { at: [obj.start, obj.end], text: `{\n${inner}${entryFor(inner, true)},\n${indent}}` };
  }
  const last = props[props.length - 1];
  const tail = code.slice(last.end, obj.end - 1);
  const comma = tail.match(/^\s*,/);
  if (ownLine(code, last)) {
    const indent = code.slice(lineStart(code, last.start), last.start);
    return comma
      ? { at: [last.end + comma[0].length], text: `\n${indent}${entryFor(indent, true)},` }
      : { at: [last.end], text: `,\n${indent}${entryFor(indent, false)}` };
  }
  return comma
    ? { at: [last.end + comma[0].length], text: ` ${entryFor("", true)},` }
    : { at: [last.end], text: `, ${entryFor("", false)}` };
}

/** Flattened theme for the editor: [{ path, kind, value?, source? }]. */
export function readTheme(code, filename) {
  const entries = collect(code, parseSource(code, filename));
  return entries
    .filter((e) => e.kind !== "object")
    .map(({ path, kind, value, source }) => ({ path, kind, value, source }));
}

/**
 * Sets (or with value === null, removes) the theme value at `path`.
 * Missing objects along the path are created, e.g. a new
 * components.Button.defaultProps.radius.
 */
export function setThemeValue(code, filename, path, value) {
  if (!Array.isArray(path) || path.length === 0 || path.length > 6) {
    throw new EditError("Bad theme path");
  }
  for (const k of path) {
    if (!(typeof k === "number" || /^[\w$-]+$/.test(k))) {
      throw new EditError(`Bad theme key: ${k}`);
    }
  }
  const entries = collect(code, parseSource(code, filename));
  const byPath = new Map(entries.map((e) => [pathKey(e.path), e]));
  const q = quoteStyle(code, entries);
  const hit = byPath.get(pathKey(path));
  let out;

  if (hit && value === null) {
    if (!hit.prop) throw new EditError("Only object keys can be removed", 422);
    const p = hit.prop;
    let end = p.end;
    const after = code.slice(end).match(/^[ \t]*,/);
    if (after) end += after[0].length;
    const start = ownLine(code, p) ? lineStart(code, p.start) - 1 : p.start;
    out = code.slice(0, start) + code.slice(end);
  } else if (hit) {
    if (hit.kind === "computed" || hit.kind === "alias" || hit.kind === "object") {
      throw new EditError(`${path.join(".")} isn't a plain value; edit it in code`, 422);
    }
    const text = formatValue(value, hit.kind, q);
    out = code.slice(0, hit.node.start) + text + code.slice(hit.node.end);
  } else if (value === null) {
    return code;
  } else {
    let i = path.length - 1;
    while (i >= 0 && byPath.get(pathKey(path.slice(0, i)))?.kind !== "object") i--;
    if (i < 0) throw new EditError(`Can't place ${path.join(".")} in the theme`, 422);
    const parent = byPath.get(pathKey(path.slice(0, i)));
    const rest = path.slice(i);
    if (rest.some((k) => typeof k === "number")) {
      throw new EditError("Can't add array entries", 422);
    }
    const build = (keys, indent, trailing) => {
      const [k, ...more] = keys;
      if (more.length === 0) return `${formatKey(k)}: ${formatValue(value, null, q)}`;
      const inner = `${indent}  `;
      return `${formatKey(k)}: {\n${inner}${build(more, inner, trailing)}${trailing ? "," : ""}\n${indent}}`;
    };
    const ins = insertInto(code, parent.node, (indent, trailing) => build(rest, indent, trailing));
    out = ins.at.length === 2
      ? code.slice(0, ins.at[0]) + ins.text + code.slice(ins.at[1])
      : code.slice(0, ins.at[0]) + ins.text + code.slice(ins.at[0]);
  }
  parseSource(out, filename); // refuse to write a file that no longer parses
  return out;
}

/** True if `name` is imported from @mantine/core in this file. */
export function isMantineComponent(code, filename, name) {
  if (!/^[A-Z]\w*$/.test(name)) return false;
  const ast = parseSource(code, filename);
  return ast.program.body.some((s) =>
    s.type === "ImportDeclaration" &&
    s.source.value === "@mantine/core" &&
    s.importKind !== "type" &&
    s.specifiers.some((sp) => sp.local.name === name && sp.importKind !== "type"));
}
