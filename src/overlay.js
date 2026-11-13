// Editor overlay injected into the app page by the visual-edit plugin.
// Plain DOM inside a shadow root so it neither depends on nor restyles the app.
//
// Elements are tracked by their data-ve id ("file:line:col") plus their index
// among elements with the same id, because hot reload replaces DOM nodes and
// one source element can render many times (lists).

const COMMON = {
  Size: ["w", "h", "miw", "maw"],
  Spacing: ["m", "mt", "mb", "ml", "mr", "p", "pt", "pb", "pl", "pr", "px", "py", "gap"],
  Type: ["size", "fz", "fw", "c", "ta"],
  Fill: ["bg"],
};
const SUGGEST = {
  space: ["xs", "sm", "md", "lg", "xl", "0"],
  color: ["dimmed", "atticusInk", "atticusBrass", "atticusParchment", "atticusInk.7", "black", "white", "red", "green"],
  fw: ["400", "500", "600", "700"],
  ta: ["left", "center", "right"],
};
const listFor = (p) =>
  p === "c" || p === "bg" ? "color" : p === "fw" ? "fw" : p === "ta" ? "ta" : "space";

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font: 12px/1.4 -apple-system, system-ui, sans-serif; }
.box { position: fixed; pointer-events: none; z-index: 2147483646; display: none; }
.hover { outline: 1px dashed #7c3aed; }
.sel { outline: 2px solid #7c3aed; }
.tag { position: absolute; left: -2px; top: -20px; background: #7c3aed; color: #fff;
  padding: 1px 6px; border-radius: 3px 3px 0 0; white-space: nowrap; font-size: 11px; }
.h { position: absolute; width: 10px; height: 10px; background: #fff; border: 2px solid #7c3aed;
  border-radius: 2px; pointer-events: auto; }
.h.e { right: -6px; top: calc(50% - 5px); cursor: ew-resize; }
.h.s { bottom: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.h.se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.drop { position: fixed; z-index: 2147483647; background: #7c3aed; border-radius: 2px;
  pointer-events: none; display: none; box-shadow: 0 0 0 2px #fff; }
.readout { position: fixed; z-index: 2147483647; background: #111; color: #fff; padding: 2px 6px;
  border-radius: 3px; font-size: 11px; display: none; pointer-events: none; }
.bar { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: flex; gap: 6px; }
.toggle { background: #111; color: #fff; border: 0; border-radius: 16px; padding: 6px 12px; cursor: pointer; }
.toggle.on { background: #7c3aed; }
.panel { position: fixed; top: 12px; right: 12px; bottom: 12px; width: 300px; z-index: 2147483647;
  background: #fff; color: #111; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 8px 30px #0002;
  overflow: auto; padding: 12px; display: none; }
.panel h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
.panel h3 { font-size: 11px; font-weight: 600; color: #666; text-transform: uppercase; margin: 14px 0 6px; }
.loc { color: #666; font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
.crumbs { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
.crumbs button { border: 1px solid #ddd; background: #f6f6f6; border-radius: 3px; padding: 1px 6px; cursor: pointer; }
.grid { display: grid; grid-template-columns: 56px 1fr; gap: 4px 6px; align-items: center; }
.grid label { color: #444; font-family: ui-monospace, monospace; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
input { width: 100%; border: 1px solid #ccc; border-radius: 4px; padding: 3px 6px; }
input:focus { outline: 2px solid #7c3aed55; border-color: #7c3aed; }
.ro { color: #888; font-family: ui-monospace, monospace; font-size: 11px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.note { color: #888; margin: 4px 0; }
.status { margin-top: 10px; min-height: 16px; color: #2b8a3e; }
.status.err { color: #c92a2a; }
.row { display: flex; gap: 6px; margin-top: 10px; }
.row button { border: 1px solid #ccc; background: #fff; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
.row button:disabled { opacity: .4; cursor: default; }
.seg { display: flex; margin-top: 8px; }
.seg button { flex: 1; border: 1px solid #ccc; background: #fff; padding: 4px; cursor: pointer; }
.seg button:first-child { border-radius: 4px 0 0 4px; }
.seg button:last-child { border-radius: 0 4px 4px 0; border-left: 0; }
.seg button.on { background: #7c3aed; color: #fff; border-color: #7c3aed; }
.ramp { display: flex; gap: 2px; margin: 2px 0 8px; }
.ramp input { width: 24px; height: 24px; padding: 0; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; }
.rampname { font-family: ui-monospace, monospace; color: #444; }
.px { color: #888; margin-left: 4px; }
.cell { display: flex; align-items: center; }
`;

const host = document.createElement("div");
host.id = "visual-edit-root";
const shadow = host.attachShadow({ mode: "open" });
shadow.innerHTML = `<style>${STYLES}</style>
<div class="box hover"></div>
<div class="box sel"><div class="tag"></div>
  <div class="h e" data-dir="e"></div><div class="h s" data-dir="s"></div><div class="h se" data-dir="se"></div></div>
<div class="readout"></div>
<div class="drop"></div>
<div class="bar"><button class="toggle edit">✎ Edit</button><button class="toggle theme">◐ Theme</button></div>
<div class="panel"></div>
${Object.entries(SUGGEST).map(([k, v]) =>
  `<datalist id="ve-${k}">${v.map((o) => `<option value="${o}">`).join("")}</datalist>`).join("")}`;
document.body.appendChild(host);

const $ = (s) => shadow.querySelector(s);
const hoverBox = $(".hover");
const selBox = $(".sel");
const tag = $(".tag");
const readout = $(".readout");
const dropLine = $(".drop");
const toggle = $(".toggle.edit");
const themeBtn = $(".toggle.theme");
const panel = $(".panel");

let on = false;
let hovered = null;      // Element
let sel = null;          // { id, index }
let info = null;         // inspect response for sel
let resizing = null;     // { dir, el, startX, startY, w, h, prevW, prevH }
let editingText = null;  // { el, original }
let drag = null;         // { el, x, y, active, target, position }
let justDragged = false; // swallow the click that ends a drag
let statusMsg = { text: "", err: false };
let view = "element";    // "element" | "theme"
let scope = "instance";  // element view: "instance" | "component"
let theme = null;        // GET /__ve/theme response, null until loaded

// Props offered as app-wide defaults for a Mantine component.
const COMPONENT_PROPS = ["size", "variant", "color", "radius", "shadow", "c", "fz", "fw", "ta", "p", "gap"];

// ---------- helpers ----------

const isOurs = (e) => e.composedPath().includes(host);
const stamped = (el) => el?.closest?.("[data-ve]") ?? null;
const all = (id) => document.querySelectorAll(`[data-ve="${CSS.escape(id)}"]`);
const selectedEl = () => (sel ? all(sel.id)[sel.index] ?? all(sel.id)[0] ?? null : null);
const isComponent = (name) => /^[A-Z]/.test(name);

function place(box, el) {
  if (!el) { box.style.display = "none"; return; }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, {
    display: "block", left: `${r.left}px`, top: `${r.top}px`,
    width: `${r.width}px`, height: `${r.height}px`,
  });
}

function setStatus(text, err = false) {
  statusMsg = { text, err };
  const s = panel.querySelector(".status");
  if (s) { s.textContent = text; s.className = err ? "status err" : "status"; }
  if (err) console.error(`[visual-edit] ${text}`);
}

async function api(route, body) {
  const res = await fetch(`/__ve/${route}`, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// ---------- selection + panel ----------

async function select(el) {
  const id = el.getAttribute("data-ve");
  sel = { id, index: [...all(id)].indexOf(el) };
  view = "element";
  scope = "instance";
  await refresh();
}

async function refresh() {
  if (!sel) { render(); return; }
  try {
    info = await api(`inspect?id=${encodeURIComponent(sel.id)}`);
    render();
  } catch (e) {
    info = null;
    render();
    setStatus(e.message, true);
  }
}

async function edit(editBody, okMsg) {
  try {
    const r = await api("edit", { id: sel.id, edit: editBody });
    // A move changes the element's line, so follow it to its new id.
    if (r.id !== sel.id) sel = { id: r.id, index: 0 };
    setStatus(r.changed ? okMsg : "No change");
  } catch (e) {
    setStatus(e.message, true);
  }
  await refresh();
}

async function loadTheme() {
  try {
    theme = await api("theme");
  } catch (e) {
    theme = { error: e.message, leaves: [] };
    setStatus(`Theme: ${e.message}`, true);
  }
  render();
}

// Theme edits rewrite the app's entry module, which makes Vite reload the
// page; saveState() lets the editor come back where it was.
async function themeEdit(path, value, okMsg) {
  try {
    const r = await api("theme", { path, value });
    setStatus(r.changed ? okMsg : "No change");
  } catch (e) {
    setStatus(e.message, true);
  }
  saveState();
  await loadTheme();
}

function themeInput(leaf, { removable = false, onCommit } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "cell";
  if (leaf.kind === "computed" || leaf.kind === "alias") {
    const ro = document.createElement("div");
    ro.className = "ro";
    ro.textContent = leaf.kind === "alias" ? `= ${leaf.value}` : leaf.source;
    ro.title = leaf.kind === "alias" ? `Alias of ${leaf.value}` : "Computed in code";
    wrap.append(ro);
    return { wrap, input: null };
  }
  const input = document.createElement("input");
  const original = String(leaf.value ?? "");
  input.value = original;
  input.placeholder = "—";
  wrap.append(input);
  if (leaf.kind === "rem" || leaf.kind === "em") {
    wrap.append(Object.assign(document.createElement("span"), { className: "px", textContent: "px" }));
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = original; input.blur(); }
  });
  input.addEventListener("change", () => {
    if (input.value.trim() === original) return;
    let value = leaf.kind === "string" ? input.value.trim() : parseValue(input.value);
    if (value === "") value = null;
    if (value === null && !removable) {
      input.value = original;
      setStatus("Theme values can't be empty", true);
      return;
    }
    onCommit(value);
  });
  return { wrap, input };
}

function crumbs(el) {
  const out = [];
  let cur = el;
  while (cur && out.length < 6) {
    cur = stamped(cur.parentElement);
    if (cur) out.unshift(cur);
  }
  return out;
}

function propRow(name, attr) {
  const row = document.createElement("div");
  row.style.display = "contents";
  const label = document.createElement("label");
  label.textContent = name;
  row.append(label);
  if (attr?.kind === "computed") {
    const ro = document.createElement("div");
    ro.className = "ro";
    ro.textContent = attr.source;
    ro.title = `Computed in code: ${attr.source}`;
    row.append(ro);
    return row;
  }
  const input = document.createElement("input");
  input.value = attr ? String(attr.value) : "";
  input.placeholder = "—";
  input.setAttribute("list", `ve-${listFor(name)}`);
  const commit = () => {
    const before = attr ? String(attr.value) : "";
    if (input.value.trim() === before) return;
    const value = parseValue(input.value);
    edit({ type: "prop", name, value }, value === null ? `Removed ${name}` : `Set ${name}=${value}`);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = attr ? String(attr.value) : ""; input.blur(); }
  });
  input.addEventListener("change", commit);
  row.append(input);
  return row;
}

function render() {
  saveState();
  themeBtn.classList.toggle("on", view === "theme");
  panel.style.display = view === "theme" || sel ? "block" : "none";
  if (view === "theme") { renderTheme(); return; }
  if (!sel) return;
  renderElement();
}

function renderElement() {
  const el = selectedEl();
  const [file, line] = sel.id.split(":");
  const count = all(sel.id).length;
  panel.innerHTML = "";

  const h2 = document.createElement("h2");
  h2.textContent = `<${info?.name ?? el?.dataset.veN ?? "?"}>` + (count > 1 ? `  ×${count}` : "");
  const loc = document.createElement("div");
  loc.className = "loc";
  loc.textContent = `${file}:${line}`;
  panel.append(h2, loc);
  if (count > 1) {
    const n = document.createElement("div");
    n.className = "note";
    n.textContent = `Rendered ${count} times from one line of code: edits change all of them.`;
    panel.append(n);
  }

  if (el) {
    const c = document.createElement("div");
    c.className = "crumbs";
    for (const a of crumbs(el)) {
      const b = document.createElement("button");
      b.textContent = a.dataset.veN;
      b.title = a.dataset.ve;
      b.onclick = () => select(a);
      c.append(b);
    }
    if (c.childElementCount) panel.append(c);
  }

  if (info) {
    const th = document.createElement("h3");
    th.textContent = "Text";
    panel.append(th);
    if (info.text.editable) {
      const input = document.createElement("input");
      input.value = info.text.value;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      input.addEventListener("change", () =>
        edit({ type: "text", value: input.value }, "Text updated"));
      panel.append(input);
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = "Or double-click the element to edit in place.";
      panel.append(n);
    } else {
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = info.text.source
        ? `Not editable: comes from code (${info.text.source})`
        : `Not editable: ${info.text.reason}`;
      panel.append(n);
    }

    const mh = document.createElement("h3");
    mh.textContent = "Position";
    panel.append(mh);
    const mv = info.move;
    if (mv.movable) {
      const row = document.createElement("div");
      row.className = "row";
      row.style.marginTop = "0";
      const step = (label, delta) => {
        const b = document.createElement("button");
        b.textContent = label;
        const neighbour = mv.order[mv.index + delta];
        b.disabled = !neighbour;
        b.onclick = () => edit(
          { type: "move", targetId: neighbour[0], position: delta < 0 ? "before" : "after" },
          delta < 0 ? "Moved up" : "Moved down",
        );
        return b;
      };
      row.append(step("↑ Move up", -1), step("↓ Move down", 1));
      const pos = document.createElement("div");
      pos.className = "note";
      pos.textContent = `Item ${mv.index + 1} of ${mv.order.length}. ` +
        "Drag to reorder; hold ⌘/Ctrl while dragging to drop into another container.";
      panel.append(row, pos);
    } else {
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = `Can't move: ${mv.reason}.`;
      panel.append(n);
    }

    const known = new Map(info.attrs.map((a) => [a.name, a]));
    if (info.mantine) {
      const seg = document.createElement("div");
      seg.className = "seg";
      for (const [value, label] of [["instance", "This element"], ["component", `All <${info.name}>`]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.classList.toggle("on", scope === value);
        b.onclick = () => { scope = value; render(); };
        seg.append(b);
      }
      panel.append(seg);
    }
    if (scope === "component" && info.mantine) {
      renderComponentDefaults(info.name, known);
      footer();
      return;
    }
    const ph = document.createElement("h3");
    ph.textContent = "Props in code";
    const pg = document.createElement("div");
    pg.className = "grid";
    for (const a of info.attrs) pg.append(propRow(a.name, a));
    panel.append(ph, info.attrs.length ? pg : Object.assign(document.createElement("div"),
      { className: "note", textContent: "None" }));

    if (isComponent(info.name)) {
      for (const [group, names] of Object.entries(COMMON)) {
        const missing = names.filter((n) => !known.has(n));
        if (!missing.length) continue;
        const gh = document.createElement("h3");
        gh.textContent = `Add ${group.toLowerCase()}`;
        const gg = document.createElement("div");
        gg.className = "grid";
        for (const n of missing) gg.append(propRow(n, null));
        panel.append(gh, gg);
      }
    } else {
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = "Plain HTML element: style props and resize need a Mantine component.";
      panel.append(n);
    }
  }

  footer();
}

function renderComponentDefaults(name, known) {
  const onPage = document.querySelectorAll(`[data-ve-n="${CSS.escape(name)}"]`).length;
  const n = document.createElement("div");
  n.className = "note";
  n.textContent = `Defaults for every <${name}> in the app (${onPage} on this page). ` +
    "An element that sets a prop itself keeps its own value.";
  panel.append(n);
  if (!theme) {
    panel.append(Object.assign(document.createElement("div"), { className: "note", textContent: "Loading theme…" }));
    loadTheme();
    return;
  }
  const prefix = ["components", name, "defaultProps"];
  const defaults = theme.leaves.filter((l) =>
    l.path.length === 4 && prefix.every((k, i) => l.path[i] === k));
  const have = new Set(defaults.map((l) => l.path[3]));
  const row = (prop, leaf) => {
    const label = document.createElement("label");
    label.textContent = known.has(prop) ? `${prop}*` : prop;
    if (known.has(prop)) label.title = "This element sets it itself, so it won't follow the default";
    const { wrap, input } = themeInput(leaf ?? { kind: "new", value: "" }, {
      removable: true,
      onCommit: (value) => themeEdit([...prefix, prop], value,
        value === null ? `Removed ${name} default ${prop}` : `All <${name}>: ${prop}=${value}`),
    });
    input?.setAttribute("list", `ve-${listFor(prop)}`);
    return [label, wrap];
  };
  const h = document.createElement("h3");
  h.textContent = "App-wide defaults";
  const g = document.createElement("div");
  g.className = "grid";
  for (const l of defaults) g.append(...row(l.path[3], l));
  panel.append(h, defaults.length ? g : Object.assign(document.createElement("div"),
    { className: "note", textContent: "None yet" }));
  const missing = COMPONENT_PROPS.filter((p) => !have.has(p));
  if (missing.length) {
    const ah = document.createElement("h3");
    ah.textContent = "Add default";
    const ag = document.createElement("div");
    ag.className = "grid";
    for (const p of missing) ag.append(...row(p, null));
    panel.append(ah, ag);
  }
  if ([...known.keys()].some((k) => have.has(k) || missing.includes(k))) {
    panel.append(Object.assign(document.createElement("div"),
      { className: "note", textContent: "* set on this element in code" }));
  }
}

const THEME_SECTIONS = [
  ["Brand", (l) => ["primaryColor", "primaryShade"].includes(l.path[0])],
  ["Typography", (l) => /^(font|headings|lineHeights)/.test(l.path[0])],
  ["Spacing", (l) => l.path[0] === "spacing"],
  ["Radius", (l) => /radius/i.test(l.path[0])],
  ["Shadows", (l) => l.path[0] === "shadows"],
  ["Breakpoints", (l) => l.path[0] === "breakpoints"],
  ["Component defaults", (l) => l.path[0] === "components"],
];

function renderTheme() {
  panel.innerHTML = "";
  const h2 = document.createElement("h2");
  h2.textContent = "Theme";
  panel.append(h2);
  if (!theme) {
    panel.append(Object.assign(document.createElement("div"), { className: "note", textContent: "Loading theme…" }));
    loadTheme();
    footer();
    return;
  }
  panel.append(
    Object.assign(document.createElement("div"), { className: "loc", textContent: theme.file ?? "" }),
    Object.assign(document.createElement("div"), { className: "note", textContent: "Changes here restyle every page." }),
  );
  const leaves = theme.leaves;
  const primary = leaves.find((l) => l.path[0] === "primaryColor")?.value;

  // Colour ramps as swatch strips.
  const ch = document.createElement("h3");
  ch.textContent = "Colours";
  panel.append(ch);
  const ramps = new Map();
  for (const l of leaves.filter((l) => l.path[0] === "colors")) {
    if (!ramps.has(l.path[1])) ramps.set(l.path[1], []);
    ramps.get(l.path[1]).push(l);
  }
  for (const [name, shades] of ramps) {
    const label = document.createElement("div");
    label.className = "rampname";
    label.textContent = name + (name === primary ? "  · primary" : "");
    panel.append(label);
    if (shades.length === 1 && shades[0].path.length === 2) {
      panel.append(themeInput(shades[0]).wrap);
      continue;
    }
    const strip = document.createElement("div");
    strip.className = "ramp";
    for (const l of shades) {
      const hex = typeof l.value === "string" && /^#[0-9a-f]{6}$/i.test(l.value) ? l.value : null;
      const sw = document.createElement("input");
      sw.type = "color";
      sw.value = hex ? hex.toLowerCase() : "#000000";
      sw.disabled = !hex;
      sw.title = `${name}.${l.path[2]}  ${l.value ?? l.source}`;
      sw.addEventListener("change", () => {
        const next = hex === hex?.toUpperCase() ? sw.value.toUpperCase() : sw.value;
        themeEdit(l.path, next, `${name}.${l.path[2]} = ${next}`);
      });
      strip.append(sw);
    }
    panel.append(strip);
  }

  const rest = leaves.filter((l) => l.path[0] !== "colors");
  const used = new Set();
  const sections = THEME_SECTIONS.map(([title, test]) => {
    const items = rest.filter((l) => !used.has(l) && test(l));
    items.forEach((l) => used.add(l));
    return [title, items];
  });
  sections.push(["Other", rest.filter((l) => !used.has(l))]);
  for (const [title, items] of sections) {
    if (!items.length) continue;
    const h = document.createElement("h3");
    h.textContent = title;
    const g = document.createElement("div");
    g.className = "grid";
    g.style.gridTemplateColumns = "110px 1fr";
    for (const l of items) {
      const label = document.createElement("label");
      const scale = ["spacing", "radius", "shadows", "breakpoints", "fontSizes", "lineHeights"];
      label.textContent = (l.path[0] === "components"
        ? l.path.filter((k) => k !== "defaultProps").slice(1)
        : scale.includes(l.path[0]) ? l.path.slice(1) : l.path).join(".");
      label.title = l.path.join(".");
      const input = themeInput(l, {
        removable: l.path[0] === "components",
        onCommit: (value) => themeEdit(l.path, value,
          value === null ? `Removed ${l.path.join(".")}` : `${l.path.join(".")} = ${value}`),
      });
      g.append(label, input.wrap);
    }
    panel.append(h, g);
  }
  footer();
}

function footer() {
  const row = document.createElement("div");
  row.className = "row";
  const undoBtn = document.createElement("button");
  undoBtn.textContent = "Undo last edit";
  undoBtn.onclick = async () => {
    try {
      const r = await api("undo", {});
      if (r.id) sel = { id: r.id, index: 0 };
      theme = null;
      setStatus(`Undid ${r.undone}`);
    }
    catch (e) { setStatus(e.message, true); }
    setTimeout(refresh, 150);
  };
  const close = document.createElement("button");
  close.textContent = view === "theme" ? "Close" : "Deselect";
  close.onclick = () => {
    if (view === "theme") view = "element";
    else { sel = null; info = null; }
    render();
  };
  row.append(undoBtn, close);
  const status = document.createElement("div");
  status.className = "status";
  panel.append(row, status);
  setStatus(statusMsg.text, statusMsg.err);
}

// ---------- page interaction (capture phase, edit mode only) ----------

function swallow(e) {
  if (!on || isOurs(e) || editingText) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

document.addEventListener("mousemove", (e) => {
  if (!on || resizing) return;
  hovered = isOurs(e) ? null : stamped(e.target);
}, true);

for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "submit"]) {
  document.addEventListener(type, swallow, true);
}

document.addEventListener("click", (e) => {
  if (!swallow(e)) return;
  if (justDragged) { justDragged = false; return; }
  const el = stamped(e.target);
  if (el) { statusMsg = { text: "", err: false }; select(el); }
}, true);

document.addEventListener("dblclick", (e) => {
  if (!swallow(e)) return;
  const el = selectedEl();
  if (!el || !info?.text.editable || !el.contains(e.target)) return;
  editingText = { el, original: el.textContent };
  el.contentEditable = "plaintext-only";
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  const finish = (save) => {
    el.removeEventListener("keydown", onKey, true);
    el.removeEventListener("blur", onBlur);
    el.contentEditable = "false";
    const value = el.textContent;
    const original = editingText.original;
    editingText = null;
    if (save && value.trim() !== original.trim()) {
      edit({ type: "text", value }, "Text updated");
    } else {
      el.textContent = original;
    }
  };
  const onKey = (k) => {
    if (k.key === "Enter") { k.preventDefault(); finish(true); }
    if (k.key === "Escape") { k.preventDefault(); finish(false); }
    k.stopPropagation();
  };
  const onBlur = () => finish(true);
  el.addEventListener("keydown", onKey, true);
  el.addEventListener("blur", onBlur);
}, true);

document.addEventListener("keydown", (e) => {
  if (on && e.key === "Escape" && !editingText && !drag?.active && !isOurs(e)) {
    sel = null; info = null; render();
  }
}, true);

// ---------- resize ----------

selBox.addEventListener("mousedown", (e) => {
  const dir = e.target.dataset?.dir;
  const el = selectedEl();
  if (!dir || !el) return;
  if (!info || !isComponent(info.name)) {
    setStatus("Resize needs a Mantine component (w/h props)", true);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const r = el.getBoundingClientRect();
  resizing = {
    dir, el, startX: e.clientX, startY: e.clientY,
    w: Math.round(r.width), h: Math.round(r.height),
    prevW: el.style.width, prevH: el.style.height,
    nextW: null, nextH: null,
  };
});

window.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const z = resizing;
  const snap = (v) => (e.shiftKey ? Math.round(v / 8) * 8 : Math.round(v));
  if (z.dir.includes("e")) {
    z.nextW = Math.max(1, snap(z.w + e.clientX - z.startX));
    z.el.style.width = `${z.nextW}px`;
  }
  if (z.dir.includes("s")) {
    z.nextH = Math.max(1, snap(z.h + e.clientY - z.startY));
    z.el.style.height = `${z.nextH}px`;
  }
  readout.textContent = `${z.nextW ?? z.w} × ${z.nextH ?? z.h} px` + (e.shiftKey ? "  (snap 8)" : "");
  Object.assign(readout.style, { display: "block", left: `${e.clientX + 14}px`, top: `${e.clientY + 14}px` });
}, true);

window.addEventListener("mouseup", async () => {
  if (!resizing) return;
  const z = resizing;
  resizing = null;
  readout.style.display = "none";
  if (z.nextW !== null) await edit({ type: "prop", name: "w", value: z.nextW }, `Set w=${z.nextW}`);
  if (z.nextH !== null) await edit({ type: "prop", name: "h", value: z.nextH }, `Set h=${z.nextH}`);
  // The px preview stays until hot reload re-renders from source. Clear it
  // only if it is still ours: by then React may have written its own value
  // (Mantine emits rem/calc), and React won't re-apply a style it thinks is set.
  setTimeout(() => {
    if (z.nextW !== null && z.el.style.width === `${z.nextW}px`) z.el.style.width = z.prevW;
    if (z.nextH !== null && z.el.style.height === `${z.nextH}px`) z.el.style.height = z.prevH;
  }, 400);
}, true);

// ---------- drag to reorder ----------
//
// By default only the element's siblings in the source are drop targets, so a
// drag reorders within its container. Holding ⌘/Ctrl allows any movable
// element in the same file, i.e. moving into another container.

const DRAG_THRESHOLD = 4;

function isHorizontal(el) {
  const p = el.parentElement;
  if (!p) return false;
  const cs = getComputedStyle(p);
  if (cs.display.includes("grid")) return true;
  return cs.display.includes("flex") && cs.flexDirection.startsWith("row");
}

function targetAt(el, x, y) {
  const r = el.getBoundingClientRect();
  const horizontal = isHorizontal(el);
  const before = horizontal ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
  return { el, horizontal, position: before ? "before" : "after" };
}

function dropTarget(x, y, anyContainer) {
  const allowed = new Set(anyContainer ? info.move.targets : info.move.siblings);
  for (let el = stamped(document.elementFromPoint(x, y)); el; el = stamped(el.parentElement)) {
    if (!drag.el.contains(el) && allowed.has(el.dataset.ve)) return targetAt(el, x, y);
  }
  if (anyContainer) return null;
  // Pointer in the gap between siblings: use the nearest one.
  const parent = drag.el.parentElement;
  const pr = parent?.getBoundingClientRect();
  if (!pr || x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) return null;
  let best = null;
  for (const el of parent.children) {
    if (el === drag.el || !allowed.has(el.dataset?.ve)) continue;
    const r = el.getBoundingClientRect();
    const dist = Math.hypot(
      Math.max(r.left - x, 0, x - r.right),
      Math.max(r.top - y, 0, y - r.bottom),
    );
    if (!best || dist < best.dist) best = { el, dist };
  }
  return best ? targetAt(best.el, x, y) : null;
}

function endDrag() {
  const d = drag;
  drag = null;
  dropLine.style.display = "none";
  readout.style.display = "none";
  document.documentElement.style.cursor = "";
  if (d?.active) d.el.style.opacity = d.prevOpacity;
  return d;
}

// Pointer events, not mouse events: swallow() cancels pointerdown so the app
// ignores the press, and that suppresses the compatibility mouse events.
document.addEventListener("pointerdown", (e) => {
  if (!on || isOurs(e) || editingText || resizing || e.button !== 0) return;
  const el = selectedEl();
  if (!el || !el.contains(e.target)) return;
  drag = { el, x: e.clientX, y: e.clientY, active: false, target: null };
}, true);

window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
    if (!info?.move?.movable) {
      setStatus(`Can't move: ${info?.move?.reason ?? "element info still loading"}`, true);
      drag = null;
      return;
    }
    drag.active = true;
    drag.prevOpacity = drag.el.style.opacity;
    drag.el.style.opacity = "0.4";
    document.documentElement.style.cursor = "grabbing";
  }
  const t = dropTarget(e.clientX, e.clientY, e.metaKey || e.ctrlKey);
  drag.target = t;
  if (!t) {
    dropLine.style.display = "none";
    readout.style.display = "none";
    return;
  }
  const r = t.el.getBoundingClientRect();
  const after = t.position === "after";
  Object.assign(dropLine.style, t.horizontal
    ? { display: "block", left: `${(after ? r.right : r.left) - 2}px`, top: `${r.top}px`, width: "4px", height: `${r.height}px` }
    : { display: "block", left: `${r.left}px`, top: `${(after ? r.bottom : r.top) - 2}px`, width: `${r.width}px`, height: "4px" });
  readout.textContent = `${t.position} <${t.el.dataset.veN}>`;
  Object.assign(readout.style, { display: "block", left: `${e.clientX + 14}px`, top: `${e.clientY + 14}px` });
}, true);

window.addEventListener("pointerup", async () => {
  if (!drag) return;
  const d = endDrag();
  if (!d.active) return;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 300);
  if (!d.target) {
    setStatus("Not over a valid drop spot; nothing moved");
    return;
  }
  const { el, position } = d.target;
  await edit(
    { type: "move", targetId: el.dataset.ve, position },
    `Moved ${position} <${el.dataset.veN}>`,
  );
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drag?.active) {
    endDrag();
    justDragged = true;
    setStatus("Move cancelled");
  }
}, true);

// ---------- loop + toggle ----------

function frame() {
  place(hoverBox, on && !resizing && !drag?.active ? hovered : null);
  const el = on ? selectedEl() : null;
  place(selBox, el);
  if (el) {
    const r = el.getBoundingClientRect();
    const n = sel ? all(sel.id).length : 1;
    tag.textContent = `${el.dataset.veN}  ${Math.round(r.width)} × ${Math.round(r.height)}` +
      (n > 1 ? `  ×${n}` : "");
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function showToggle() {
  toggle.classList.toggle("on", on);
  toggle.textContent = on ? "✎ Editing (click to stop)" : "✎ Edit";
}

toggle.addEventListener("click", () => {
  on = !on;
  showToggle();
  if (!on) { hovered = null; sel = null; info = null; }
  render();
});

themeBtn.addEventListener("click", () => {
  view = view === "theme" ? "element" : "theme";
  render();
});

// ---------- state across full reloads ----------

const STATE_KEY = "visual-edit-state";

function saveState() {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ on, view, scope, sel, statusMsg }));
  } catch (e) {
    console.warn("[visual-edit] couldn't save editor state; it will reset on reload", e);
  }
}

function restoreState() {
  let s = null;
  try {
    s = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "null");
  } catch (e) {
    console.warn("[visual-edit] couldn't restore editor state", e);
  }
  if (!s) return;
  ({ on, view, scope, sel, statusMsg } = s);
  showToggle();
  if (sel) refresh(); else render();
}

restoreState();
