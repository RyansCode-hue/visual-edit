// Which pages render a given element, so the editor can warn before a change
// to a shared component reaches pages the designer isn't looking at.
//
// Builds a component graph from the app's source:
//   - nodes: top-level components, keyed "file#Name"
//   - edges: component A renders <B /> (B resolved through local bindings
//     and relative imports)
//   - roots: react-router routes, from object routes ({ path, element }, with
//     nested children) or <Route path element> JSX. Paths may be string
//     literals or members of an exported constants object (ROUTES.DASHBOARD).
// A page "uses" a component when its route element, or any layout route
// above it, reaches that component.
//
// Static and best-effort: components rendered by reference (lazy(),
// `Component: X`, props holding components) aren't followed, so a missing
// page means "not found by reading the code", never "definitely unused".

import path from "node:path";
import { parseSource } from "./source.js";

const EXTS = [".tsx", ".ts", ".jsx", ".js"];
const isComponentName = (n) => typeof n === "string" && /^[A-Z]/.test(n);

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) walk(c, visit);
    else if (child && typeof child.type === "string") walk(child, visit);
  }
}

function resolveImport(fromRel, spec, known) {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => known.has(c)) ?? null;
}

// `function X`, `const X = () => …`, `const X = memo(() => …)`, with or
// without `export` / `export default`.
function topLevelComponents(ast) {
  const out = [];
  let defaultName = null;
  const fromDecl = (decl, node) => {
    if (!decl) return;
    if (decl.type === "FunctionDeclaration" && isComponentName(decl.id?.name)) {
      out.push({ name: decl.id.name, node });
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id.type === "Identifier" && isComponentName(d.id.name) && d.init &&
          /Function|ArrowFunction|CallExpression/.test(d.init.type)) {
          out.push({ name: d.id.name, node });
        }
      }
    }
  };
  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportNamedDeclaration") fromDecl(stmt.declaration, stmt);
    else if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration;
      if (d.type === "Identifier") defaultName = d.name;
      else if (d.type === "FunctionDeclaration") {
        defaultName = d.id?.name ?? "default";
        out.push({ name: defaultName, node: stmt });
      }
    } else fromDecl(stmt, stmt);
  }
  return { components: out, defaultName };
}

/** Exported `const NAME = { KEY: "string" }` objects, for ROUTES.X paths. */
function stringConstants(ast) {
  const out = {};
  for (const stmt of ast.program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      let init = d.init;
      while (init && (init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression")) init = init.expression;
      if (d.id.type !== "Identifier" || init?.type !== "ObjectExpression") continue;
      for (const p of init.properties) {
        const key = p.key?.name ?? p.key?.value;
        if (p.type === "ObjectProperty" && key && p.value.type === "StringLiteral") out[`${d.id.name}.${key}`] = p.value.value;
      }
    }
  }
  return out;
}

export function buildPageGraph(files) {
  const known = new Set(files.map((f) => f.rel));
  const mods = new Map(); // rel → { ast, comps, defaultName, imports: Map(local → {rel, imported}) }
  const constants = {};
  for (const { rel, code } of files) {
    if (!/\.[jt]sx?$/.test(rel) || /\.(test|spec)\.[jt]sx?$/.test(rel)) continue;
    let ast;
    try { ast = parseSource(code, rel); } catch { continue; } // unparseable files contribute nothing
    const { components, defaultName } = topLevelComponents(ast);
    const imports = new Map();
    for (const stmt of ast.program.body) {
      if (stmt.type !== "ImportDeclaration") continue;
      const target = resolveImport(rel, stmt.source.value, known);
      for (const s of stmt.specifiers) {
        imports.set(s.local.name, {
          rel: target,
          imported: s.type === "ImportDefaultSpecifier" ? "default" : s.type === "ImportNamespaceSpecifier" ? "*" : s.imported.name ?? s.imported.value,
        });
      }
    }
    mods.set(rel, { ast, components, defaultName, imports });
    Object.assign(constants, stringConstants(ast));
  }

  const keyFor = (rel, name) => {
    const m = mods.get(rel);
    if (!m) return null;
    const n = name === "default" ? m.defaultName : name;
    return m.components.some((c) => c.name === n) ? `${rel}#${n}` : null;
  };
  // A JSX tag name in a file → component key, through local bindings and imports.
  const resolveTag = (rel, tag) => {
    const m = mods.get(rel);
    if (!m || !isComponentName(tag)) return null;
    if (m.components.some((c) => c.name === tag)) return `${rel}#${tag}`;
    const imp = m.imports.get(tag);
    return imp?.rel ? keyFor(imp.rel, imp.imported) : null;
  };

  const renders = new Map(); // key → Set(key)
  for (const [rel, m] of mods) {
    for (const c of m.components) {
      const set = new Set();
      walk(c.node, (n) => {
        if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier") {
          const k = resolveTag(rel, n.name.name);
          if (k && k !== `${rel}#${c.name}`) set.add(k);
        }
      });
      renders.set(`${rel}#${c.name}`, set);
    }
  }

  const routes = []; // { path, keys: [layout…, page] }
  const pathValue = (node) => {
    if (!node) return null;
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type === "MemberExpression" && node.object.type === "Identifier") {
      const key = `${node.object.name}.${node.property.name ?? node.property.value}`;
      return constants[key] ?? null;
    }
    return null;
  };
  const elementKey = (rel, node) => {
    if (node?.type === "JSXExpressionContainer") node = node.expression;
    return node?.type === "JSXElement" && node.openingElement.name.type === "JSXIdentifier"
      ? resolveTag(rel, node.openingElement.name.name) : null;
  };
  const join = (parent, p) => {
    if (p == null) return parent;
    if (p.startsWith("/")) return p;
    return `${parent.replace(/\/$/, "")}/${p}`;
  };

  for (const [rel, m] of mods) {
    const visitObjectRoute = (obj, parentPath, parentKeys) => {
      const prop = (name) => obj.properties.find((p) => p.type === "ObjectProperty" && (p.key.name ?? p.key.value) === name)?.value;
      const own = pathValue(prop("path"));
      const isIndex = prop("index")?.value === true;
      const full = isIndex ? parentPath : join(parentPath, own);
      const k = elementKey(rel, prop("element"));
      const keys = k ? [...parentKeys, k] : parentKeys;
      const children = prop("children");
      if (children?.type === "ArrayExpression") {
        for (const c of children.elements) if (c?.type === "ObjectExpression") visitObjectRoute(c, full, keys);
      } else if (k && (own != null || isIndex) && full !== "*" && !full.endsWith("*")) {
        routes.push({ path: full || "/", keys, index: isIndex });
      }
    };
    const visitJsxRoute = (el, parentPath, parentKeys) => {
      const attr = (name) => el.openingElement.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);
      const pv = attr("path")?.value;
      const own = pv?.type === "StringLiteral" ? pv.value : pv?.type === "JSXExpressionContainer" ? pathValue(pv.expression) : null;
      const isIndex = Boolean(attr("index"));
      const full = isIndex ? parentPath : join(parentPath, own);
      const k = elementKey(rel, attr("element")?.value);
      const keys = k ? [...parentKeys, k] : parentKeys;
      const kids = el.children.filter((c) => c.type === "JSXElement" && c.openingElement.name.name === "Route");
      if (kids.length) for (const c of kids) visitJsxRoute(c, full, keys);
      else if (k && (own != null || isIndex) && !full.endsWith("*")) routes.push({ path: full || "/", keys, index: isIndex });
    };

    walk(m.ast, (n) => {
      if (n.type === "CallExpression" && /^create(Browser|Hash|Memory)Router$/.test(n.callee.name ?? "") &&
        n.arguments[0]?.type === "ArrayExpression") {
        for (const r of n.arguments[0].elements) if (r?.type === "ObjectExpression") visitObjectRoute(r, "", []);
        return false;
      }
      if (n.type === "JSXElement" && n.openingElement.name.name === "Routes") {
        for (const c of n.children) {
          if (c.type === "JSXElement" && c.openingElement.name.name === "Route") visitJsxRoute(c, "", []);
        }
        return false;
      }
    });
  }

  // Everything each route reaches.
  const reach = (start) => {
    const seen = new Set();
    const stack = [...start];
    while (stack.length) {
      const k = stack.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      for (const next of renders.get(k) ?? []) stack.push(next);
    }
    return seen;
  };
  // One entry per page component: an index route and /login both rendering
  // <Login /> are one page, listed under its explicit path.
  const byPage = new Map();
  for (const r of routes) {
    const page = r.keys[r.keys.length - 1];
    const prev = byPage.get(page);
    if (!prev || (prev.index && !r.index)) byPage.set(page, r);
  }
  const pages = [...byPage.values()].map((r) => ({
    path: r.path, page: r.keys[r.keys.length - 1], reach: reach(r.keys),
  }));

  return { mods, pages };
}

/** The top-level component whose source contains `line:column` in `rel`. */
export function componentAt(graph, rel, line, column) {
  const m = graph.mods.get(rel);
  if (!m) return null;
  const pos = (l, c) => l * 100000 + c;
  const at = pos(line, column);
  const hit = m.components.find((c) =>
    pos(c.node.loc.start.line, c.node.loc.start.column) <= at && at <= pos(c.node.loc.end.line, c.node.loc.end.column));
  return hit ? `${rel}#${hit.name}` : null;
}

const label = (key) => key.split("#")[1];

/**
 * Pages that render the element at `rel:line:column`.
 * @returns {{ component: string|null, file: string, isPage: boolean, pages: {path, page, needsParams}[] }}
 */
export function pagesFor(graph, rel, line, column) {
  const key = componentAt(graph, rel, line, column);
  const pages = key
    ? graph.pages.filter((p) => p.reach.has(key)).map((p) => ({
      path: p.path, page: label(p.page), needsParams: /[:*]/.test(p.path),
    }))
    : [];
  return {
    component: key ? label(key) : null,
    file: rel,
    isPage: Boolean(key && graph.pages.some((p) => p.page === key)),
    pages,
  };
}
