// Source-level operations on a JSX/TSX file: stamping elements with their
// location, reading an element's props/text, and writing edits back.
//
// An element is addressed by the line and 0-based column of its opening `<`
// in the file on disk. Edits are applied with MagicString so only the touched
// characters change and the rest of the file keeps its formatting.

import { parse } from "@babel/parser";
import MagicString from "magic-string";

export class EditError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function parseSource(code, filename) {
  const isTs = /\.tsx?$/.test(filename);
  return parse(code, {
    sourceType: "module",
    plugins: isTs ? ["jsx", "typescript"] : ["jsx"],
  });
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit, node);
    } else if (child && typeof child.type === "string") {
      walk(child, visit, node);
    }
  }
}

const idOf = (rel, el) =>
  `${rel}:${el.openingElement.loc.start.line}:${el.openingElement.loc.start.column}`;

export function elementName(nameNode) {
  switch (nameNode.type) {
    case "JSXIdentifier":
      return nameNode.name;
    case "JSXMemberExpression":
      return `${elementName(nameNode.object)}.${nameNode.property.name}`;
    case "JSXNamespacedName":
      return `${nameNode.namespace.name}:${nameNode.name.name}`;
    default:
      return "?";
  }
}

// Fragments reject unknown props, so they are never stamped.
function isFragment(name) {
  return name === "Fragment" || name.endsWith(".Fragment");
}

/**
 * Adds data-ve="<relPath>:<line>:<col>" and data-ve-n="<Name>" to every JSX
 * opening element. Runs in the dev server transform only; the file on disk is
 * never stamped.
 */
export function stampJsx(code, relPath) {
  const ast = parseSource(code, relPath);
  const s = new MagicString(code);
  let count = 0;
  walk(ast, (node) => {
    if (node.type !== "JSXOpeningElement") return;
    const name = elementName(node.name);
    if (isFragment(name)) return;
    const { line, column } = node.loc.start;
    const at = (node.typeArguments ?? node.typeParameters ?? node.name).end;
    s.appendLeft(
      at,
      ` data-ve="${relPath}:${line}:${column}" data-ve-n="${name}"`,
    );
    count++;
  });
  if (count === 0) return null;
  return { code: s.toString(), map: s.generateMap({ hires: true }) };
}

function findElement(ast, line, column) {
  let found = null;
  walk(ast, (node) => {
    if (
      !found &&
      node.type === "JSXElement" &&
      node.openingElement.loc.start.line === line &&
      node.openingElement.loc.start.column === column
    ) {
      found = node;
    }
  });
  if (!found) {
    throw new EditError(
      `No JSX element at ${line}:${column}; the file may have changed since ` +
        "the page last reloaded.",
      409,
    );
  }
  return found;
}

/** Classifies an attribute so the UI knows whether it can be edited. */
function describeAttr(attr, code) {
  if (attr.type === "JSXSpreadAttribute") {
    return {
      name: "...",
      kind: "computed",
      source: code.slice(attr.start, attr.end),
    };
  }
  const name = attr.name.type === "JSXIdentifier"
    ? attr.name.name
    : elementName(attr.name);
  const v = attr.value;
  if (v === null) return { name, kind: "boolean", value: true };
  if (v.type === "StringLiteral") {
    return { name, kind: "string", value: v.value };
  }
  if (v.type === "JSXExpressionContainer") {
    const e = v.expression;
    if (e.type === "NumericLiteral") {
      return { name, kind: "number", value: e.value };
    }
    if (e.type === "StringLiteral") {
      return { name, kind: "string", value: e.value };
    }
    if (
      e.type === "UnaryExpression" && e.operator === "-" &&
      e.argument.type === "NumericLiteral"
    ) {
      return { name, kind: "number", value: -e.argument.value };
    }
  }
  return { name, kind: "computed", source: code.slice(v.start, v.end) };
}

function meaningfulChildren(element) {
  return element.children.filter((c) => {
    if (c.type === "JSXText") return c.value.trim() !== "";
    if (c.type === "JSXExpressionContainer") {
      return c.expression.type !== "JSXEmptyExpression";
    }
    return true;
  });
}

/** The element's text, if it is exactly one literal child. */
function describeText(element, code) {
  const kids = meaningfulChildren(element);
  if (kids.length === 0) return { editable: false, reason: "no text" };
  if (kids.length > 1) {
    return { editable: false, reason: "mixed content" };
  }
  const k = kids[0];
  if (k.type === "JSXText") {
    const raw = code.slice(k.start, k.end);
    return { editable: true, value: raw.trim().replace(/\s+/g, " ") };
  }
  if (
    k.type === "JSXExpressionContainer" &&
    k.expression.type === "StringLiteral"
  ) {
    return { editable: true, value: k.expression.value };
  }
  if (k.type === "JSXExpressionContainer") {
    return {
      editable: false,
      reason: "comes from code/data",
      source: code.slice(k.expression.start, k.expression.end),
    };
  }
  return { editable: false, reason: "contains elements" };
}

// ---------- moving elements ----------
//
// The thing that moves is a "unit": one child of a JSX element. Usually that
// is the element itself; for `{cond && <A/>}` or `{c ? <A/> : <B/>}` it is the
// whole `{...}` so the condition travels with it. Elements returned from a
// callback (`.map`) or used as a component's root have no unit: their order
// is decided by code, not by markup.

const PASS_THROUGH = new Set([
  "LogicalExpression", "ConditionalExpression", "ParenthesizedExpression",
  "JSXExpressionContainer",
]);
const FUNCTIONS = new Set([
  "ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration",
]);

function analyse(ast) {
  const parents = new Map();
  const elements = [];
  walk(ast, (node, parent) => {
    parents.set(node, parent);
    if (node.type === "JSXElement") elements.push(node);
  });

  const unitOf = (el) => {
    let node = el;
    let p = parents.get(node);
    while (p) {
      if (p.type === "JSXElement" || p.type === "JSXFragment") {
        if (node === el || node.type === "JSXExpressionContainer") {
          return { unit: node, parent: p };
        }
        break;
      }
      if (FUNCTIONS.has(p.type)) {
        return { unit: null, reason: "rendered by a list or callback; order comes from code" };
      }
      if (!PASS_THROUGH.has(p.type)) break;
      node = p;
      p = parents.get(p);
    }
    return { unit: null, reason: "top-level element of a component" };
  };

  const units = new Map(); // element -> { unit, parent, reason }
  const byUnit = new Map(); // unit -> [element]
  for (const el of elements) {
    const u = unitOf(el);
    units.set(el, u);
    if (u.unit) {
      if (!byUnit.has(u.unit)) byUnit.set(u.unit, []);
      byUnit.get(u.unit).push(el);
    }
  }
  return { elements, units, byUnit };
}

function moveInfo(rel, el, a) {
  const self = a.units.get(el);
  if (!self.unit) return { movable: false, reason: self.reason };
  const order = self.parent.children
    .filter((c) => a.byUnit.has(c))
    .map((c) => a.byUnit.get(c).map((e) => idOf(rel, e)));
  const index = self.parent.children
    .filter((c) => a.byUnit.has(c))
    .indexOf(self.unit);
  const inside = (n) => n.start >= self.unit.start && n.end <= self.unit.end;
  const targets = a.elements
    .filter((e) => {
      const u = a.units.get(e).unit;
      return u && u !== self.unit && !inside(e);
    })
    .map((e) => idOf(rel, e));
  const siblings = order.filter((_, i) => i !== index).flat();
  return { movable: true, order, index, siblings, targets };
}

function lineInfo(code, pos) {
  const start = code.lastIndexOf("\n", pos - 1) + 1;
  const indent = code.slice(start, pos);
  let end = code.indexOf("\n", pos);
  if (end === -1) end = code.length;
  return { start, indent, ownStart: /^[ \t]*$/.test(indent), end };
}

function reindent(text, from, to) {
  return text
    .split("\n")
    .map((l, i) => (i > 0 && l.startsWith(from) ? to + l.slice(from.length) : l))
    .join("\n");
}

function toLineCol(code, offset) {
  const before = code.slice(0, offset);
  const line = (before.match(/\n/g) || []).length + 1;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) };
}

/**
 * Moves the element at line:column so it sits before or after the element
 * `targetId` (same file). Returns the new file contents and the moved
 * element's new id.
 */
export function applyMove(code, rel, line, column, { targetId, position }) {
  if (position !== "before" && position !== "after") {
    throw new EditError(`Bad position: ${position}`);
  }
  const m = /^(.+):(\d+):(\d+)$/.exec(targetId ?? "");
  if (!m) throw new EditError(`Bad target id: ${targetId}`);
  if (m[1] !== rel) {
    throw new EditError("Moving between files isn't supported yet", 422);
  }
  const ast = parseSource(code, rel);
  const a = analyse(ast);
  const el = findElement(ast, line, column);
  const target = findElement(ast, Number(m[2]), Number(m[3]));
  const info = moveInfo(rel, el, a);
  if (!info.movable) throw new EditError(`Can't move: ${info.reason}`, 422);
  const tu = a.units.get(target);
  if (!tu.unit) throw new EditError(`Can't drop there: ${tu.reason}`, 422);
  const src = a.units.get(el).unit;
  const dst = tu.unit;
  if (dst === src) return { code, id: idOf(rel, el) };
  if (dst.start >= src.start && dst.end <= src.end) {
    throw new EditError("Can't move an element inside itself", 422);
  }

  // Cut: a unit alone on its line(s) takes its line break with it.
  const sl = lineInfo(code, src.start);
  const srcLineEnd = lineInfo(code, src.end).end;
  const srcAlone = sl.ownStart && /^[ \t]*$/.test(code.slice(src.end, srcLineEnd));
  const cut = srcAlone ? [Math.max(0, sl.start - 1), srcLineEnd] : [src.start, src.end];

  // Paste, indented to match the target.
  const tl = lineInfo(code, dst.start);
  const targetAlone = tl.ownStart;
  const prefix = reindent(code.slice(src.start, el.start), sl.indent, tl.indent);
  const moved = reindent(code.slice(src.start, src.end), sl.indent, tl.indent);
  let at;
  let insert;
  let elOffset; // moved element's start within `insert`
  if (targetAlone && srcAlone) {
    if (position === "before") {
      at = tl.start;
      insert = `${tl.indent}${moved}\n`;
      elOffset = tl.indent.length + prefix.length;
    } else {
      at = lineInfo(code, dst.end).end;
      insert = `\n${tl.indent}${moved}`;
      elOffset = 1 + tl.indent.length + prefix.length;
    }
  } else {
    at = position === "before" ? dst.start : dst.end;
    insert = moved;
    elOffset = prefix.length;
  }

  if (at > cut[0] && at < cut[1]) {
    throw new EditError("Target overlaps the moved element", 422);
  }
  let out;
  let newStart;
  if (at <= cut[0]) {
    out = code.slice(0, at) + insert + code.slice(at, cut[0]) + code.slice(cut[1]);
    newStart = at + elOffset;
  } else {
    out = code.slice(0, cut[0]) + code.slice(cut[1], at) + insert + code.slice(at);
    newStart = at - (cut[1] - cut[0]) + elOffset;
  }
  parseSource(out, rel); // refuse to write a file that no longer parses
  const pos = toLineCol(out, newStart);
  return { code: out, id: `${rel}:${pos.line}:${pos.column}` };
}

export function inspect(code, filename, line, column) {
  const ast = parseSource(code, filename);
  const el = findElement(ast, line, column);
  return {
    name: elementName(el.openingElement.name),
    attrs: el.openingElement.attributes
      .map((a) => describeAttr(a, code))
      .filter((a) => !a.name.startsWith("data-ve")),
    text: describeText(el, code),
    move: moveInfo(filename, el, analyse(ast)),
  };
}

const ATTR_NAME = /^[A-Za-z_][\w-]*$/;

function formatValue(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EditError("Number is not finite");
    return `{${value}}`;
  }
  if (typeof value === "string") {
    return /["\\\n]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
  }
  throw new EditError(`Unsupported value type: ${typeof value}`);
}

function formatText(value) {
  const v = value.replace(/\s+/g, " ").trim();
  if (v === "") throw new EditError("Text cannot be empty");
  return /[{}<>]/.test(v) ? `{${JSON.stringify(v)}}` : v;
}

function setProp(s, code, opening, name, value) {
  if (!ATTR_NAME.test(name)) throw new EditError(`Bad prop name: ${name}`);
  const attr = opening.attributes.find(
    (a) => a.type === "JSXAttribute" && a.name.name === name,
  );

  if (value === null) {
    if (!attr) return;
    let from = attr.start;
    while (from > 0 && /\s/.test(code[from - 1])) from--;
    s.remove(from, attr.end);
    return;
  }

  const formatted = formatValue(value);
  if (attr) {
    if (describeAttr(attr, code).kind === "computed") {
      throw new EditError(
        `${name} is computed in code and can't be edited here`,
        422,
      );
    }
    if (attr.value === null) {
      s.overwrite(attr.start, attr.end, `${name}=${formatted}`);
    } else {
      s.overwrite(attr.value.start, attr.value.end, formatted);
    }
    return;
  }

  // New prop: follow the element's existing layout (one-per-line or inline).
  const attrs = opening.attributes;
  const last = attrs[attrs.length - 1];
  const anchor = last ?? opening.typeArguments ?? opening.name;
  const multiline = last && last.loc.start.line !== opening.loc.start.line;
  const sep = multiline ? `\n${" ".repeat(last.loc.start.column)}` : " ";
  s.appendLeft(anchor.end, `${sep}${name}=${formatted}`);
}

function setText(s, code, element, value) {
  const text = describeText(element, code);
  if (!text.editable) {
    throw new EditError(`Text is not editable here (${text.reason})`, 422);
  }
  const k = meaningfulChildren(element)[0];
  const formatted = formatText(value);
  if (k.type === "JSXText") {
    const raw = code.slice(k.start, k.end);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    s.overwrite(k.start + lead, k.end - trail, formatted);
  } else {
    s.overwrite(k.start, k.end, formatted.startsWith("{")
      ? formatted
      : `{${JSON.stringify(formatted)}}`);
  }
}

/**
 * Applies one edit and returns the new file contents.
 *   { type: "prop", name, value }   value: string | number | null (remove)
 *   { type: "text", value }
 */
export function applyEdit(code, filename, line, column, edit) {
  const ast = parseSource(code, filename);
  const el = findElement(ast, line, column);
  const s = new MagicString(code);
  if (edit.type === "prop") {
    setProp(s, code, el.openingElement, edit.name, edit.value);
  } else if (edit.type === "text") {
    if (typeof edit.value !== "string") throw new EditError("Text must be a string");
    setText(s, code, el, edit.value);
  } else {
    throw new EditError(`Unknown edit type: ${edit.type}`);
  }
  const out = s.toString();
  parseSource(out, filename); // refuse to write a file that no longer parses
  return out;
}
