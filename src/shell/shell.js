// Visual-edit shell: the editor page around the app iframe.
//
// The app runs in the iframe with canvas.js injected; canvas.js handles the
// app's DOM and calls window.__veShell. This page owns state, talks to the
// /__ve API, and renders layers, the inspector, the theme and the change list.
// Inspector controls speak design vocabulary and offer design-system tokens;
// raw Mantine props stay under "More properties" and "Developer info".

import { toPx, primaryColorVars } from "/__ve/mantine-vars.js";

const $ = (s, root = document) => root.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
};

const frame = $("#app");
const state = {
  mode: "design",
  sel: null,          // { id, index }
  info: null,         // GET inspect for sel
  theme: null,        // GET theme
  config: {},
  changes: [],
  showOriginal: false,
  tab: "design",
  scope: "instance",  // "instance" | "component"
  canvas: null,
  collapsed: new Set(),
  expanded: new Set(),
  review: null,       // last send-for-review result
  questions: [],      // questions for developers
  pending: [],        // previewed theme edits: { path, value, label, vars, reach }
  checks: [],         // page accessibility/overflow issues
  figma: null,        // { name, tokens } imported from a Figma export
  route: "/",
  shared: null,       // GET pages for sel: { component, isPage, pages } or { error }
  tour: null,         // stepping through pages: { component, list, i }
  ai: null,           // Ask Claude run: { job, status, prompt, events, next, result, startedAt }
};

// ---------- API ----------

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

// ---------- toast ----------

let toastTimer = null;
function toast(text, err = false) {
  const t = $("#toast");
  t.hidden = false;
  t.className = err ? "toast err" : "toast";
  t.replaceChildren(h("span", {}, text), h("button", { onclick: () => { t.hidden = true; }, title: "Dismiss" }, "×"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 9000 : 3500);
  if (err) console.error(`[visual-edit] ${text}`);
}

// ---------- tokens ----------

const TOKEN_DEFAULTS = {
  spacing: { xs: 10, sm: 12, md: 16, lg: 20, xl: 32 },
  fontSizes: { xs: 12, sm: 14, md: 16, lg: 18, xl: 20 },
  radius: { xs: 2, sm: 4, md: 8, lg: 16, xl: 32 },
};

function tokens(kind) {
  const fromTheme = {};
  for (const l of state.theme?.leaves ?? []) {
    if (l.path[0] === kind && l.path.length === 2 && typeof l.value === "number") {
      fromTheme[l.path[1]] = l.kind === "em" ? l.value * 16 : l.value;
    }
  }
  return { ...TOKEN_DEFAULTS[kind], ...fromTheme };
}

function ramps() {
  const out = new Map();
  for (const l of state.theme?.leaves ?? []) {
    if (l.path[0] !== "colors" || l.kind === "alias" || l.path.length !== 3) continue;
    if (!out.has(l.path[1])) out.set(l.path[1], []);
    out.get(l.path[1]).push(l);
  }
  return out;
}

const NAMED_COLORS = ["dimmed", "black", "white", "gray", "red", "orange", "yellow", "green", "teal", "blue"];

function colorCss(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (/^(#|rgb|hsl)/.test(v)) return v;
  const [name, shade] = v.split(".");
  const c = state.canvas;
  if (!c) return null;
  if (["dimmed", "black", "white", "text", "body"].includes(name)) return c.cssVar(`--mantine-color-${name}`) || null;
  return c.cssVar(shade !== undefined ? `--mantine-color-${name}-${shade}` : `--mantine-color-${name}-filled`) || null;
}

const isCustomColor = (v) => typeof v === "string" && /^(#|rgb|hsl)/.test(v);
const show = (v) => (v === undefined || v === null ? "default" : typeof v === "number" ? `${v}px` : String(v));

// ---------- selection ----------

const selLabel = () => (state.sel && state.canvas?.describe(state.sel)?.label) || state.info?.name || "Element";

// URL mode: the editor was opened on a live site, not the app's code. Elements
// come from the DOM (stamp-dom.js), and changes are kept as style and text
// overrides that end up in a handoff instead of in the code.
const urlMode = () => state.config?.mode === "url";
const dom = () => frame.contentWindow?.__veDom ?? null;
const NO_MOVE = "moving needs the code; open the editor on the app folder to reorder things";

function urlInfo(s) {
  const d = dom()?.describe(s.id);
  return d ? { ...d, move: { movable: false, reason: NO_MOVE } } : null;
}

async function applyOverrides() {
  if (!urlMode()) return;
  try {
    const r = await api("overrides");
    state.urlTheme = r.themeVars;
    dom()?.setOverrides(r.overrides, r.themeVars);
  } catch (e) {
    toast(`Couldn't apply your changes to the page: ${e.message}`, true);
  }
}

async function refreshInfo() {
  if (!state.sel) { state.info = null; state.shared = null; renderPanel(); return; }
  if (urlMode()) {
    state.info = urlInfo(state.sel);
    state.shared = null;
    if (!state.info) toast("That element isn't on the page any more", true);
    renderPanel();
    return;
  }
  const id = encodeURIComponent(state.sel.id);
  const [info, shared] = await Promise.allSettled([api(`inspect?id=${id}`), api(`pages?id=${id}`)]);
  if (info.status === "fulfilled") state.info = info.value;
  else { state.info = null; toast(info.reason.message, true); }
  if (shared.status === "fulfilled") state.shared = shared.value;
  else {
    state.shared = { error: shared.reason.message };
    console.warn("[visual-edit] couldn't work out which pages show this element", shared.reason);
  }
  renderPanel();
}

// ---------- Ask Claude ----------

let aiTimer = null;

async function askClaude(prompt) {
  try {
    const { job } = await api("claude", { id: state.sel?.id ?? null, route: state.route, prompt });
    state.ai = { job, status: "running", prompt, events: [], next: 0, result: null, startedAt: Date.now() };
    renderAi();
    pollAi();
  } catch (e) {
    toast(e.message, true);
  }
}

async function pollAi() {
  clearTimeout(aiTimer);
  const ai = state.ai;
  if (!ai || ai.status !== "running") return;
  try {
    const r = await api(`claude?job=${ai.job}&since=${ai.next}`);
    ai.events.push(...r.events);
    ai.next = r.next;
    ai.status = r.status;
    ai.result = r.result;
    ai.startedAt = r.startedAt;
  } catch (e) {
    ai.status = "error";
    ai.result = { error: `Lost track of the Claude request: ${e.message}`, changes: [] };
  }
  if (ai.status === "running") {
    renderAi();
    aiTimer = setTimeout(pollAi, 1000);
    return;
  }
  // The run rewrote source: ids in touched files may now point elsewhere.
  const touched = new Set((ai.result?.changes ?? []).map((c) => c.rel));
  if (state.sel && touched.has(state.sel.id.split(":")[0])) select(null);
  await refreshChanges();
  if (ai.result?.changes?.length) toast(`Claude changed ${ai.result.changes.length} file${ai.result.changes.length === 1 ? "" : "s"}`);
  renderPanel();
}

async function undoAi() {
  const ns = (state.ai?.result?.changes ?? []).map((c) => c.n).sort((a, b) => b - a);
  for (const n of ns) {
    try { await api("revert", { n }); } catch (e) { toast(`Couldn't undo part of Claude's change: ${e.message}`, true); break; }
  }
  state.ai = null;
  toast("Undid Claude's change");
  await loadTheme();
  await refreshChanges();
  await refreshInfo();
  renderLayers();
}

function renderAi() {
  const box = $("#ai-box");
  if (box) box.replaceChildren(...aiBody());
}

function aiBody() {
  const ai = state.ai;
  if (!ai) return [];
  if (ai.status === "running") {
    const secs = Math.round((Date.now() - ai.startedAt) / 1000);
    return [
      h("div", {}, h("strong", {}, "Claude is working on: "), `“${ai.prompt}”`),
      h("ul", { class: "ai-log" }, ...ai.events.slice(-5).map((e) => h("li", {}, e.text))),
      h("div", { class: "actions" }, h("span", { class: "muted" }, `${secs}s`),
        h("button", { class: "btn", onclick: () => api("claude-cancel", {}).catch((e) => toast(e.message, true)) }, "Cancel")),
    ];
  }
  const r = ai.result ?? {};
  const changes = r.changes ?? [];
  const lastText = [...ai.events].reverse().find((e) => !/^(Reading|Editing|Searching|Looking|Using) /.test(e.text));
  const summary = r.text || lastText?.text || "";
  const pages = state.changes.find((c) => changes.some((x) => x.n === c.n))?.pages;
  return [
    h("div", {}, h("strong", {}, ai.status === "cancelled" ? "Cancelled: " : ai.status === "error" ? "Claude couldn't finish: " : "Claude: "), `“${ai.prompt}”`),
    summary ? h("div", { class: "ai-summary" }, summary) : null,
    r.error && ai.status !== "cancelled" ? h("div", { class: "note err" }, r.error) : null,
    changes.length
      ? h("div", { class: "note" }, `Changed ${changes.map((c) => c.rel).join(", ")}. It's in your Changes list like any other edit.`)
      : h("div", { class: "note" }, "Nothing was changed."),
    r.denials?.length ? h("div", { class: "note" }, `Blocked (outside what it's allowed to do): ${r.denials.join(", ")}`) : null,
    r.outside?.length ? h("div", { class: "note err" }, `Files outside the app changed during the run and aren't in your Changes list: ${r.outside.join(", ")}. Ask a developer to check them.`) : null,
    r.skipped?.length ? h("div", { class: "note err" }, `Files were added or removed and aren't in your Changes list: ${r.skipped.join(", ")}.`) : null,
    h("div", { class: "actions" },
      changes.length ? h("button", { class: "btn", onclick: undoAi }, "Undo this") : null,
      pages ? h("button", { class: "btn", onclick: () => startTour(pages.component, pages.list) }, `Step through ${pages.list.length} pages`) : null,
      h("button", { class: "linkish", onclick: () => { state.ai = null; renderPanel(); } }, "Dismiss")),
  ];
}

/** The Ask Claude box: for the selection, or the page when nothing is selected. */
function claudeSection() {
  const c = state.config.claude;
  if (!c?.enabled) return null;
  const running = state.ai?.status === "running";
  const input = h("textarea", {
    class: "textbox", rows: 2, disabled: running,
    placeholder: state.sel ? "e.g. Make this more compact, or use the brand blue" : "e.g. Give this page more breathing room",
  });
  const go = h("button", { class: "primary", disabled: running }, "Ask Claude");
  const submit = () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.disabled = go.disabled = true;
    askClaude(text).finally(() => { if (state.ai?.status !== "running") input.disabled = go.disabled = false; });
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
  return h("section", { class: "ai" },
    h("h3", {}, state.sel ? "Ask Claude to change this" : "Ask Claude to change this page"),
    h("div", { id: "ai-box", class: state.ai ? "ai-box" : "" }, ...aiBody()),
    h("div", { class: "ai-input" }, input, go),
    h("div", { class: "note" }, "Uses your own Claude login on this computer. It can only read and edit this app's files; you can undo it like any change."));
}

// ---------- pages that share a component ----------

const samePath = (a, b) => (a || "/").replace(/\/$/, "") === (b || "/").replace(/\/$/, "");

function goToPage(path) {
  frame.contentWindow.location.href = path;
}

function startTour(component, list) {
  const pages = list.filter((p) => !p.needsParams);
  if (!pages.length) { toast("None of those pages can be opened without an id in the address", true); return; }
  const here = pages.findIndex((p) => samePath(p.path, state.route));
  state.tour = { component, list: pages, i: here >= 0 ? here : 0, selId: state.sel?.id ?? null };
  renderTour();
  if (here < 0) goToPage(pages[0].path);
}

function renderTour() {
  const el = $("#tour");
  const t = state.tour;
  el.hidden = !t;
  if (!t) return;
  const p = t.list[t.i];
  const step = (d) => {
    t.i = (t.i + d + t.list.length) % t.list.length;
    renderTour();
    goToPage(t.list[t.i].path);
  };
  el.replaceChildren(
    h("span", { class: "grow" }, h("strong", {}, `Pages using ${t.component}`), ` · ${t.i + 1} of ${t.list.length} · `,
      h("span", { class: "mono" }, p.path)),
    h("button", { onclick: () => step(-1), title: "Previous page" }, "‹ Prev"),
    h("button", { onclick: () => step(1), title: "Next page" }, "Next ›"),
    h("button", { onclick: () => { state.tour = null; renderTour(); }, title: "Stop stepping through pages" }, "Done"));
}

/** Where else the selected element shows up, before Lika edits it. */
function sharedSection() {
  if (urlMode()) return null;
  const s = state.shared;
  if (!s) return null;
  if (s.error) return h("div", { class: "note", style: "margin:0 12px 12px" }, `Couldn't check which pages share this: ${s.error}`);
  if (s.pages.length === 1 && samePath(s.pages[0].path, state.route)) {
    return h("div", { class: "note only-here", style: "margin:0 12px 12px" }, "✓ Only used on this page.");
  }
  if (s.pages.length < 2) return null;
  return h("div", { class: "shared" },
    h("strong", {}, `Shared across ${s.pages.length} pages`),
    h("div", {}, `This is part of ${s.component}. Changes here show up on every page that uses it, not just this one.`),
    h("div", { class: "actions" },
      h("button", { class: "btn", onclick: () => startTour(s.component, s.pages) }, "Step through them"),
      pageList(s.pages)));
}

function pageList(pages) {
  return h("details", {},
    h("summary", {}, "Show the list"),
    h("ul", {}, ...pages.map((p) => h("li", {},
      p.needsParams
        ? h("span", { class: "mono", title: "Needs an id in the address" }, p.path)
        : h("button", { class: "linkish mono", onclick: () => goToPage(p.path) }, p.path),
      samePath(p.path, state.route) ? " (this page)" : ""))));
}

function select(s, { fromLayers = false } = {}) {
  state.sel = s;
  state.scope = "instance";
  state.tab = "design";
  closePopover();
  state.canvas?.setSelection(s);
  if (s && !fromLayers) revealInLayers(s);
  // Keyboard shortcuts (Tab, Enter, arrows) are handled inside the canvas.
  if (s && fromLayers) frame.contentWindow?.focus();
  renderTabs();
  renderLayers();
  refreshInfo();
  sendPresence();
}

async function refreshChanges() {
  try {
    const r = await api("changes");
    state.changes = r.changes;
    state.showOriginal = r.showOriginal;
    state.dirtyBefore = r.dirtyBefore ?? [];
    state.questions = (await api("questions")).questions;
  } catch (e) {
    toast(`Couldn't load the change list: ${e.message}`, true);
  }
  $("#count").textContent = state.changes.length + state.questions.length;
  applyOverrides();
  renderTabs();
  $("#original").checked = state.showOriginal;
  renderBanner();
  sendPins();
  if (state.tab === "changes") renderPanel();
}

const DATA_LABELS = { empty: "Empty lists", loading: "Loading", error: "Server error", long: "Long text", many: "Many rows" };

function renderBanner() {
  const parts = [];
  if (state.showOriginal) parts.push("Showing the original page. Editing is paused until you switch back.");
  const data = $("#data").value;
  if (data !== "live") parts.push(`Test data: ${DATA_LABELS[data]}. The page shows simulated data; switch Data back to Live when done.`);
  $("#banner").hidden = !parts.length;
  $("#banner").textContent = parts.join("  ·  ");
}

function sendPins() {
  state.canvas?.setPins(state.questions.filter((q) => q.route === state.route).map(({ n, id, text }) => ({ n, id, text })));
}

async function loadTheme() {
  // URL mode has no theme file; spacing tokens fall back to px values.
  if (urlMode()) { state.theme = { file: null, leaves: [] }; return; }
  try {
    state.theme = await api("theme");
  } catch (e) {
    state.theme = { file: null, leaves: [], error: e.message };
    toast(`Theme: ${e.message}`, true);
  }
}

// ---------- edits ----------

// Spacing props from in-page nudges and resizes, as CSS in URL mode.
const PROP_CSS = {
  mt: "margin-top", mb: "margin-bottom", ml: "margin-left", mr: "margin-right",
  pt: "padding-top", pb: "padding-bottom", pl: "padding-left", pr: "padding-right", w: "width", h: "height",
};

async function overrideEdit(body, label) {
  let change = body;
  if (body.type === "prop") {
    const css = PROP_CSS[body.name];
    if (!css) { toast(`“${body.name}” can't be changed in URL mode`, true); return; }
    const px = typeof body.value === "number" ? body.value : tokens("spacing")[body.value] ?? parseFloat(body.value);
    change = { type: "style", name: css, value: body.value === null ? null : `${px}px` };
  } else if (body.type === "move") {
    toast(`Can't move this: ${NO_MOVE}`, true);
    return;
  }
  const info = urlInfo(state.sel);
  try {
    const r = await api("override", {
      id: state.sel.id, page: state.route, edit: change, label,
      element: { description: info?.description },
      before: change.type === "text" ? info?.text?.value ?? null : info?.styles?.[change.name] ?? null,
    });
    toast(r.changed ? label : "No change");
  } catch (e) {
    toast(e.message, true);
  }
  await applyOverrides();
  await refreshInfo();
  refreshChanges();
}

async function edit(body, label) {
  if (!state.sel) return;
  if (urlMode()) return overrideEdit(body, label);
  try {
    const r = await api("edit", { id: state.sel.id, edit: body, label });
    if (r.id !== state.sel.id) {
      state.sel = { id: r.id, index: 0 };
      state.canvas?.setSelection(state.sel);
    }
    toast(r.changed ? label : "No change");
  } catch (e) {
    toast(e.message, true);
  }
  await refreshInfo();
  refreshChanges();
}

// Theme edits are previewed first: Mantine's CSS variables are overridden in
// the page (where a change maps to one), the reach is counted in the source,
// and nothing is written until Apply.
function themeEdit(path, value, label) {
  const key = path.join(".");
  const item = { path, value, label, vars: previewVars(path, value), reach: null };
  state.pending = [...state.pending.filter((p) => p.path.join(".") !== key), item];
  applyPreview();
  renderPanel();
  const q = reachQuery(path);
  if (q) {
    api(`usage?kind=${q.kind}&name=${encodeURIComponent(q.name)}`)
      .then((r) => { item.reach = { ...r, note: q.note }; renderPanel(); })
      .catch((e) => { item.reach = { error: e.message }; renderPanel(); });
  } else {
    item.reach = { note: "Affects every page" };
  }
}

function applyPreview() {
  state.canvas?.setPreviewVars(Object.assign({}, ...state.pending.map((p) => p.vars ?? {})));
}

async function applyPending() {
  const items = state.pending;
  state.pending = [];
  let ok = 0;
  for (const p of items) {
    try {
      const r = await api("theme", { path: p.path, value: p.value, label: p.label });
      if (r.changed) ok++;
    } catch (e) {
      toast(`${p.label}: ${e.message}`, true);
    }
  }
  applyPreview();
  if (ok) toast(ok === 1 ? items[0].label : `Applied ${ok} theme changes`);
  await loadTheme();
  renderPanel();
  refreshChanges();
}

function discardPending() {
  state.pending = [];
  applyPreview();
  renderPanel();
}

/** A previewed (not yet applied) value for a theme path, if any. */
function pendingFor(path) {
  const key = path.join(".");
  return state.pending.find((p) => p.path.join(".") === key);
}

function themeGet(key) {
  return state.theme?.leaves?.find((l) => l.path.join(".") === key)?.value;
}

/** Mantine CSS variables that preview a theme change, or null if none can. */
function previewVars(path, value) {
  const key = path.join(".");
  const primary = themeGet("primaryColor");
  const shade = typeof themeGet("primaryShade") === "number" ? themeGet("primaryShade") : 6;
  const rem = (px) => `calc(${px / 16}rem * var(--mantine-scale))`;
  const v = {};
  if (path[0] === "colors" && path.length === 3 && typeof value === "string") {
    const [, ramp, i] = path;
    const names = [ramp, ...(state.theme?.leaves ?? []).filter((l) => l.kind === "alias" && l.value === ramp).map((l) => l.path[1])];
    for (const n of names) {
      v[`--mantine-color-${n}-${i}`] = value;
      if (i === shade) v[`--mantine-color-${n}-filled`] = value;
      if (i === Math.min(shade + 1, 9)) v[`--mantine-color-${n}-filled-hover`] = value;
    }
    if (ramp === primary) {
      v[`--mantine-primary-color-${i}`] = value;
      if (i === shade) v["--mantine-primary-color-filled"] = value;
      if (i === Math.min(shade + 1, 9)) v["--mantine-primary-color-filled-hover"] = value;
    }
  } else if (key === "primaryShade" && typeof value === "number" && primary) {
    const c = (i) => `var(--mantine-color-${primary}-${i})`;
    Object.assign(v, {
      "--mantine-primary-color-filled": c(value), "--mantine-primary-color-filled-hover": c(Math.min(value + 1, 9)),
      [`--mantine-color-${primary}-filled`]: c(value), [`--mantine-color-${primary}-filled-hover`]: c(Math.min(value + 1, 9)),
    });
  } else if (key === "primaryColor" && typeof value === "string") {
    for (let i = 0; i < 10; i++) v[`--mantine-primary-color-${i}`] = `var(--mantine-color-${value}-${i})`;
    Object.assign(v, {
      "--mantine-primary-color-filled": `var(--mantine-color-${value}-${shade})`,
      "--mantine-primary-color-filled-hover": `var(--mantine-color-${value}-${Math.min(shade + 1, 9)})`,
      "--mantine-primary-color-light": `var(--mantine-color-${value}-light)`,
      "--mantine-primary-color-light-hover": `var(--mantine-color-${value}-light-hover)`,
      "--mantine-primary-color-light-color": `var(--mantine-color-${value}-light-color)`,
    });
  } else if (["spacing", "radius", "fontSizes"].includes(path[0]) && path.length === 2 && typeof value === "number") {
    const name = { spacing: "spacing", radius: "radius", fontSizes: "font-size" }[path[0]];
    v[`--mantine-${name}-${path[1]}`] = rem(value);
  } else if (key === "defaultRadius") {
    v["--mantine-radius-default"] = typeof value === "number" ? rem(value) : `var(--mantine-radius-${value})`;
  } else if (key === "fontFamily") v["--mantine-font-family"] = value;
  else if (key === "fontFamilyMonospace") v["--mantine-font-family-monospace"] = value;
  else if (key === "headings.fontFamily") v["--mantine-font-family-headings"] = value;
  else if (key === "headings.fontWeight") v["--mantine-heading-font-weight"] = value;
  else return null;
  return v;
}

/** What to count in the source to show a theme change's reach. */
function reachQuery(path) {
  const [group, a] = path;
  if (group === "colors") return { kind: "color", name: a };
  if (group === "spacing") return { kind: "spacing", name: a };
  if (group === "radius") return { kind: "radius", name: a };
  if (group === "fontSizes") return { kind: "fontSize", name: a };
  if (group === "components") return { kind: "component", name: a };
  if (group === "primaryColor" || group === "primaryShade") {
    const primary = themeGet("primaryColor");
    return primary ? { kind: "color", name: primary, note: "plus every button, link and highlight that uses the primary colour by default" } : null;
  }
  return null;
}

function pendingBar() {
  if (!state.pending.length) return null;
  const reach = (r) => {
    if (!r) return "counting where it's used…";
    if (r.error) return `couldn't count uses: ${r.error}`;
    if (r.count === undefined) return r.note;
    const base = r.count ? `used in ${r.count} place${r.count === 1 ? "" : "s"} across ${r.files.length} file${r.files.length === 1 ? "" : "s"}` : "not referenced by name in the code";
    return r.note ? `${base}, ${r.note}` : base;
  };
  return h("div", { class: "pending" },
    h("h3", {}, `Previewing ${state.pending.length} theme change${state.pending.length === 1 ? "" : "s"}`),
    h("ul", {}, ...state.pending.map((p) => h("li", {}, p.label,
      h("div", { class: "reach" }, reach(p.reach), p.vars ? "" : " · no live preview for this one; Apply to see it")))),
    h("div", { class: "btnrow" },
      h("button", { class: "primary", onclick: applyPending }, "Apply"),
      h("button", { class: "btn", onclick: discardPending }, "Discard")));
}

async function revert(n) {
  try {
    const r = await api("revert", n === undefined ? {} : { n });
    toast(`Reverted: ${r.reverted}`);
    if (r.id) {
      state.sel = { id: r.id, index: 0 };
      state.canvas?.setSelection(state.sel);
    }
  } catch (e) {
    toast(e.message, true);
  }
  await loadTheme();
  await refreshChanges();
  await refreshInfo();
  renderLayers();
}

async function redo() {
  try {
    toast(`Redone: ${(await api("redo", {})).redone}`);
  } catch (e) {
    toast(e.message, true);
  }
  await loadTheme();
  await refreshChanges();
  await refreshInfo();
  renderLayers();
}

// Arrow-key nudges arrive from the canvas as a computed-margin delta. A
// result that lands on a spacing token is written as the token.
async function nudge({ dx, dy, baseLeft, baseTop, label }) {
  const scale = tokens("spacing");
  const asToken = (px) => (px === 0 ? 0 : Object.entries(scale).find(([, v]) => v === px)?.[0] ?? px);
  if (dy) await edit({ type: "prop", name: "mt", value: asToken(baseTop + dy) }, `${label}: margin top → ${baseTop + dy}px (nudged)`);
  if (dx) await edit({ type: "prop", name: "ml", value: asToken(baseLeft + dx) }, `${label}: margin left → ${baseLeft + dx}px (nudged)`);
}

function showHelp(open = true) { $("#help").hidden = !open; }

// ---------- canvas bridge ----------

let layersTimer = null;
window.__veShell = {
  canvasReady(canvas) {
    state.canvas = canvas;
    applyOverrides();
    canvas.setMode(state.mode);
    canvas.setSelection(state.sel);
    applyPreview();
    sendPins();
    renderLayers();
    if (state.sel) refreshInfo(); else renderPanel();
  },
  pick: (s) => select(s),
  selectParent() {
    const p = state.sel && state.canvas?.parentOf(state.sel);
    if (p) select(p); else select(null);
  },
  edit,
  getInfo: () => state.info,
  undo: () => revert(),
  redo,
  nudge,
  help: (open = true) => showHelp(open),
  helpOpen: () => !$("#help").hidden,
  status: (text, err) => toast(text, err),
  // The page re-rendered (hot reload, navigation, data arriving): refresh
  // what is read from the DOM, but never under someone typing in the panel.
  domChanged() {
    clearTimeout(layersTimer);
    layersTimer = setTimeout(() => {
      renderLayers();
      const typing = $("#panel").contains(document.activeElement) &&
        /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if ((state.tab === "design" || state.tab === "checks") && !typing && $("#popover").hidden) renderPanel();
      else refreshCheckCount();
    }, 100);
  },
  routeChanged(route) {
    if (document.activeElement !== $("#route")) $("#route").value = route;
    // A different page has different elements; a reload of the same page
    // (e.g. after a theme edit) keeps the selection.
    // Stepping through the pages that share a component keeps that
    // component's element selected, since it exists on each of them.
    const touring = state.tour && state.sel && state.sel.id === state.tour.selId;
    if (state.route && route !== state.route && state.sel && !touring) select(null);
    state.route = route;
    sendPresence();
    if (state.tour) {
      const i = state.tour.list.findIndex((p) => samePath(p.path, route));
      if (i >= 0 && i !== state.tour.i) { state.tour.i = i; renderTour(); }
    }
    sendPins();
  },
  spaceHeld(held) {
    $("#stage").style.outline = held ? "2px solid #f59e0b" : "";
  },
};

// ---------- live channel (MCP) ----------
// Someone's own Claude, connected over MCP, can see and steer this editor:
// the server forwards its commands here and reads back the answers.

let presenceTimer = null;
function sendPresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    const d = state.sel && state.canvas?.describe(state.sel);
    fetch("/__ve/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: state.route ?? null,
        selection: state.sel ? { ...state.sel, label: d?.label ?? "" } : null,
      }),
    }).catch((e) => console.warn("[visual-edit] couldn't report the selection to the server", e));
  }, 100);
}

const COMMANDS = {
  async navigate({ path }) {
    goToPage(path);
    return { path };
  },
  async select({ id, index = 0 }) {
    if (!state.canvas) throw new Error("The page hasn't loaded yet");
    const s = id ? { id, index } : null;
    if (s && !state.canvas.describe(s)) throw new Error(`No element ${id} (#${index}) on this page`);
    select(s);
    return { selected: s, label: s ? state.canvas.describe(s).label : null };
  },
  async screenshot({ target }) {
    if (!state.canvas) throw new Error("The page hasn't loaded yet");
    if (target === "selection" && !state.sel) throw new Error("Nothing is selected");
    return { dataUrl: await state.canvas.shot(target === "selection" ? state.sel : null), page: state.route };
  },
  async describe({ id }) {
    if (!urlMode()) throw new Error("describe is for URL mode");
    const d = dom()?.describe(id);
    if (!d) throw new Error(`No element ${id} on this page`);
    return { ...d, page: state.route };
  },
  async themeVars() {
    if (!urlMode()) throw new Error("themeVars is for URL mode");
    const t = dom()?.themeVars();
    if (!t) throw new Error("The page hasn't loaded yet");
    return t;
  },
  async tree() {
    if (!state.canvas) throw new Error("The page hasn't loaded yet");
    return { page: state.route, tree: state.canvas.tree() };
  },
};

let changedTimer = null;
function connectLive() {
  const es = new EventSource("/__ve/events");
  es.addEventListener("command", async (ev) => {
    const { reqId, type, ...args } = JSON.parse(ev.data);
    let reply;
    try {
      const fn = COMMANDS[type];
      if (!fn) throw new Error(`Unknown command ${type}`);
      reply = { reqId, ok: true, result: await fn(args) };
      // Only commands that change what the user sees are announced.
      if (type === "navigate" || type === "select") toast(`Claude (MCP): ${type}`);
    } catch (e) {
      reply = { reqId, ok: false, error: e.message };
    }
    fetch("/__ve/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reply) })
      .catch((e) => console.warn(`[visual-edit] couldn't answer ${type}`, e));
  });
  // Changes made elsewhere (MCP, files edited outside the editor) show up here.
  es.addEventListener("changed", () => {
    clearTimeout(changedTimer);
    changedTimer = setTimeout(async () => {
      await refreshChanges();
      if (state.sel) refreshInfo();
      else if (state.tab === "theme" && urlMode()) renderPanel();
    }, 200);
  });
  es.addEventListener("hello", () => sendPresence());
  es.addEventListener("warning", (ev) => toast(JSON.parse(ev.data).message, true));
  es.onerror = () => console.warn("[visual-edit] live channel dropped; the browser will reconnect");
}

// ---------- layers ----------

const GLYPHS = {
  Stack: "↓", Group: "→", SimpleGrid: "▦", Grid: "▦", Flex: "⇄", Text: "T", Title: "H", Anchor: "🔗",
  Button: "▭", ActionIcon: "▫", Card: "▢", Paper: "▢", Badge: "●", Image: "▨", Table: "▤", Alert: "!",
  TextInput: "⌨", PasswordInput: "⌨", Textarea: "⌨", Select: "▾", Container: "□", Center: "◎",
};
const glyph = (name) => (/^[a-z]/.test(name) ? "‹›" : GLYPHS[name] ?? "◇");
const key = (n) => `${n.id}#${n.index}`;

function revealInLayers(s) {
  // Expand every ancestor of the selection.
  let p = state.canvas?.parentOf(s);
  while (p) {
    state.expanded.add(key(p));
    state.collapsed.delete(key(p));
    p = state.canvas.parentOf(p);
  }
}

function renderLayers() {
  const tree = $("#tree");
  if (!state.canvas) { tree.replaceChildren(h("div", { class: "empty" }, "Loading page…")); return; }
  const roots = state.canvas.tree();
  const rows = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const k = key(n);
      const open = n.children.length > 0 &&
        !state.collapsed.has(k) && (depth < 6 || state.expanded.has(k));
      const isSel = state.sel && state.sel.id === n.id && state.sel.index === n.index;
      rows.push(h("div", {
        class: `row${isSel ? " sel" : ""}`,
        style: `padding-left:${6 + depth * 12}px`,
        title: n.id,
        onclick: () => select({ id: n.id, index: n.index }, { fromLayers: true }),
        onmouseenter: () => state.canvas?.setLayerHover({ id: n.id, index: n.index }),
        onmouseleave: () => state.canvas?.setLayerHover(null),
      },
      h("span", {
        class: "caret",
        onclick: (e) => {
          e.stopPropagation();
          if (open) { state.collapsed.add(k); state.expanded.delete(k); }
          else { state.expanded.add(k); state.collapsed.delete(k); }
          renderLayers();
        },
      }, n.children.length ? (open ? "▾" : "▸") : ""),
      h("span", { class: "glyph" }, glyph(n.name)),
      h("span", { class: "txt" }, n.label)));
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  tree.replaceChildren(...(rows.length ? rows : [h("div", { class: "empty" }, "No editable elements on this page")]));
  tree.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
}

// ---------- popover ----------

function openPopover(anchor, content) {
  const p = $("#popover");
  p.replaceChildren(content);
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = 290;
  p.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  p.style.top = `${Math.min(r.bottom + 4, innerHeight - p.offsetHeight - 8)}px`;
}
function closePopover() { $("#popover").hidden = true; }
document.addEventListener("mousedown", (e) => {
  const p = $("#popover");
  if (!p.hidden && !p.contains(e.target) && !e.target.closest?.("[data-popover]")) closePopover();
});

// ---------- inspector: where values come from ----------

// Instance scope reads/writes JSX props on the selected element; component
// scope reads/writes components.<Name>.defaultProps in the theme. Controls
// don't need to know which.
function propSource() {
  const info = state.info;
  if (state.scope === "component") {
    const prefix = ["components", info.name, "defaultProps"];
    const leaves = state.theme?.leaves ?? [];
    return {
      get(prop) {
        const p = pendingFor([...prefix, prop]);
        if (p) return p.value === null ? undefined : { value: p.value };
        const l = leaves.find((x) => x.path.length === 4 && prefix.every((k, i) => x.path[i] === k) && x.path[3] === prop);
        if (!l) return undefined;
        return l.kind === "computed" || l.kind === "alias" ? { computed: l.source ?? l.value } : { value: l.value };
      },
      set(prop, value, field) {
        const old = this.get(prop)?.value;
        return themeEdit([...prefix, prop], value, `All ${info.name}s: ${field} ${show(old)} → ${show(value)}`);
      },
      overridden: (prop) => info.attrs.some((a) => a.name === prop),
    };
  }
  return {
    get(prop) {
      const a = info.attrs.find((x) => x.name === prop);
      if (!a) return undefined;
      return a.kind === "computed" ? { computed: a.source } : { value: a.value };
    },
    set(prop, value, field) {
      const old = this.get(prop)?.value;
      return edit({ type: "prop", name: prop, value }, `${selLabel()}: ${field} ${show(old)} → ${show(value)}`);
    },
    overridden: () => false,
  };
}

// ---------- inspector: controls ----------

/** One labelled row, plus an optional warning under it. Always an array. */
function field(label, control, { over = false, warn = null } = {}) {
  const row = h("div", { class: "field" },
    h("label", { class: over ? "over" : "", title: over ? `${label}: this element sets its own value, so it won't follow the default` : label }, label),
    control);
  return warn ? [row, warn] : [row];
}

function locked(src) {
  return h("div", { class: "lock", title: `Set in code: ${src}` }, "🔒 ", h("code", {}, src));
}

/** Token dropdown (xs…xl with px) plus Custom px. Off-scale values are flagged. */
function tokenControl(src, prop, label, kind, { allowZero = true } = {}) {
  const cur = src.get(prop);
  if (cur?.computed) return field(label, locked(cur.computed));
  const scale = tokens(kind);
  const value = cur?.value;
  const isToken = typeof value === "string" && value in scale;
  const isCustom = value !== undefined && !isToken;
  const select = h("select", {},
    h("option", { value: "" }, "Default"),
    allowZero ? h("option", { value: "0" }, "None · 0px") : null,
    ...Object.entries(scale).map(([t, px]) => h("option", { value: t }, `${t} · ${px}px`)),
    h("option", { value: "__custom" }, "Custom…"));
  select.value = value === undefined ? "" : value === 0 ? "0" : isToken ? value : "__custom";
  const px = h("input", {
    type: "number", class: "px", value: typeof value === "number" ? value : "",
    placeholder: "px", hidden: !isCustom,
  });
  if (isCustom && typeof value !== "number") { px.type = "text"; px.value = value; }
  select.addEventListener("change", () => {
    if (select.value === "__custom") { px.hidden = false; px.focus(); return; }
    src.set(prop, select.value === "" ? null : select.value === "0" ? 0 : select.value, label);
  });
  px.addEventListener("change", () => {
    const n = Number(px.value);
    if (px.value.trim() === "") src.set(prop, null, label);
    else if (Number.isFinite(n)) src.set(prop, n, label);
    else src.set(prop, px.value.trim(), label);
  });
  px.addEventListener("keydown", (e) => { if (e.key === "Enter") px.blur(); });
  let warn = null;
  if (typeof value === "number" && value !== 0) {
    const match = Object.entries(scale).find(([, p]) => p === value)?.[0];
    warn = h("div", { class: "warn" },
      match ? `${value}px equals “${match}”.` : `Custom ${value}px · not in the design system.`,
      match ? h("button", { onclick: () => src.set(prop, match, label) }, `Use ${match}`) : null);
  }
  return field(label, h("div", { class: "ctl" }, select, px), { over: src.overridden(prop), warn });
}

function choiceControl(src, prop, label, options) {
  const cur = src.get(prop);
  if (cur?.computed) return field(label, locked(cur.computed));
  const value = cur?.value;
  const known = options.some(([v]) => v === value);
  const short = options.length <= 4 && options.every(([, l]) => l.length <= 7);
  let control;
  if (short) {
    control = h("div", { class: "seg full" },
      ...options.map(([v, l]) => h("button", {
        class: value === v ? "on" : "",
        title: value === v ? "Click again to reset to default" : l,
        onclick: () => src.set(prop, value === v ? null : v, label),
      }, l)));
  } else {
    control = h("select", { onchange: (e) => src.set(prop, e.target.value === "" ? null : coerce(e.target.value, options), label) },
      h("option", { value: "" }, "Default"),
      ...options.map(([v, l]) => h("option", { value: String(v) }, l)),
      !known && value !== undefined ? h("option", { value: String(value) }, `Custom: ${value}`) : null);
    control.value = value === undefined ? "" : String(value);
  }
  return field(label, h("div", { class: "ctl" }, control), { over: src.overridden(prop) });
}
const coerce = (s, options) => options.find(([v]) => String(v) === s)?.[0] ?? s;

function toggleControl(src, prop, label) {
  const cur = src.get(prop);
  if (cur?.computed) return field(label, locked(cur.computed));
  const box = h("input", {
    type: "checkbox", checked: cur?.value === true,
    onchange: () => src.set(prop, box.checked ? true : null, label),
  });
  return field(label, h("div", { class: "ctl" }, box), { over: src.overridden(prop) });
}

/** Width/height: Auto (no prop) · Fill (100%) · Fixed px. */
function sizeControl(src, prop, label, dimension) {
  const cur = src.get(prop);
  if (cur?.computed) return field(label, locked(cur.computed));
  const value = cur?.value;
  const modeOf = value === undefined ? "auto" : value === "100%" ? "fill" : typeof value === "number" ? "fixed" : "custom";
  const rendered = () => {
    const el = state.sel && state.canvas?.describe(state.sel);
    return el ? Math.round(dimension === "w" ? el.width : el.height) : 100;
  };
  const px = h("input", {
    type: modeOf === "custom" ? "text" : "number", class: "px",
    value: modeOf === "fixed" || modeOf === "custom" ? value : "",
    hidden: modeOf !== "fixed" && modeOf !== "custom",
  });
  px.addEventListener("change", () => {
    const n = Number(px.value);
    src.set(prop, px.value.trim() === "" ? null : Number.isFinite(n) ? n : px.value.trim(), label);
  });
  px.addEventListener("keydown", (e) => { if (e.key === "Enter") px.blur(); });
  const seg = h("div", { class: "seg" },
    ...[["auto", "Auto"], ["fill", "Fill"], ["fixed", "Fixed"]].map(([m, l]) => h("button", {
      class: modeOf === m ? "on" : "",
      title: { auto: "Size to content / layout", fill: "Fill the parent (100%)", fixed: "A fixed number of pixels" }[m],
      onclick: () => {
        if (m === "auto") src.set(prop, null, label);
        else if (m === "fill") src.set(prop, "100%", label);
        else src.set(prop, rendered(), label);
      },
    }, l)));
  const warn = dimension === "w" && typeof value === "number" && value > 390
    ? h("div", { class: "warn" }, `Fixed ${value}px is wider than a phone (390px) and will overflow small screens. Try Fill with a Max width.`)
    : null;
  return field(label, h("div", { class: "ctl" }, seg, px, h("span", { class: "unit", hidden: px.hidden }, "px")),
    { over: src.overridden(prop), warn });
}

function swatch(value) {
  const css = colorCss(value);
  return h("span", { class: "swatch" }, h("i", { style: css ? `background:${css}` : "" }));
}

function colorPicker(value, onPick) {
  const wrap = h("div");
  wrap.append(h("div", { class: "chips" },
    h("button", { class: value === undefined ? "on" : "", onclick: () => onPick(null) }, "Default"),
    ...NAMED_COLORS.map((n) => h("button", { class: value === n ? "on" : "", title: n, onclick: () => onPick(n) },
      swatch(n), n))));
  for (const [name, shades] of ramps()) {
    wrap.append(h("div", { class: "mono" }, name));
    wrap.append(h("div", { class: "ramp" },
      ...shades.map((l) => {
        const v = `${name}.${l.path[2]}`;
        return h("button", {
          class: value === v || (value === name && l.path[2] === 6) ? "on" : "",
          title: `${v}  ${l.value}`,
          style: `background:${l.value}`,
          onclick: () => onPick(v),
        });
      })));
  }
  const hex = h("input", { type: "text", class: "textbox", placeholder: "#1a2b3c (custom, not in the design system)" });
  hex.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && /^#[0-9a-f]{3,8}$/i.test(hex.value.trim())) onPick(hex.value.trim());
  });
  wrap.append(hex);
  return wrap;
}

function colorControl(src, prop, label) {
  const cur = src.get(prop);
  if (cur?.computed) return field(label, locked(cur.computed));
  const value = cur?.value;
  const btn = h("button", { class: "colorbtn", "data-popover": true },
    swatch(value), h("span", {}, value === undefined ? "Default" : String(value).replace(".", " ")));
  btn.addEventListener("click", () => openPopover(btn, colorPicker(value, (v) => {
    closePopover();
    src.set(prop, v, label);
  })));
  const warn = isCustomColor(value) ? h("div", { class: "warn" }, "Custom colour · not in the design system.") : null;
  return field(label, h("div", { class: "ctl" }, btn), { over: src.overridden(prop), warn });
}

// Margin/padding as a box diagram. Each side shows its own prop, or the value
// it inherits from the axis (mx/py) or all-sides (m/p) prop as a placeholder.
function boxModel(src) {
  const scale = tokens("spacing");
  const sides = { t: ["t", "y"], r: ["r", "x"], b: ["b", "y"], l: ["l", "x"] };
  const valueOf = (prefix, side) => {
    for (const p of [`${prefix}${sides[side][0]}`, `${prefix}${sides[side][1]}`, prefix]) {
      const c = src.get(p);
      if (c) return { prop: p, ...c };
    }
    return null;
  };
  const input = (prefix, side) => {
    const own = `${prefix}${sides[side][0]}`;
    const v = valueOf(prefix, side);
    const ownVal = v?.prop === own ? v : null;
    const inp = h("input", {
      class: side, list: "ve-space", title: `${prefix === "m" ? "Margin" : "Padding"} ${{ t: "top", r: "right", b: "bottom", l: "left" }[side]}`,
      value: ownVal ? (ownVal.computed ? "ƒ" : String(ownVal.value)) : "",
      placeholder: v && !ownVal ? (v.computed ? "ƒ" : String(v.value)) : "–",
      disabled: Boolean(ownVal?.computed),
    });
    const n = ownVal && typeof ownVal.value === "number" ? ownVal.value : null;
    if (n !== null && n !== 0 && !Object.values(scale).includes(n)) inp.classList.add("off");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    inp.addEventListener("change", () => {
      const raw = inp.value.trim();
      const num = Number(raw);
      const value = raw === "" ? null : Number.isFinite(num) ? num : raw;
      const label = `${prefix === "m" ? "Margin" : "Padding"} ${{ t: "top", r: "right", b: "bottom", l: "left" }[side]}`;
      src.set(own, value, label);
    });
    return inp;
  };
  const d = state.sel && state.canvas?.describe(state.sel);
  return h("div", { class: "box-model" },
    h("span", { class: "tag" }, "margin"),
    input("m", "t"), input("m", "r"), input("m", "b"), input("m", "l"),
    h("div", { class: "pad" },
      h("span", { class: "tag" }, "padding"),
      input("p", "t"), input("p", "r"), input("p", "b"), input("p", "l"),
      h("div", { class: "core" }, d ? `${Math.round(d.width)} × ${Math.round(d.height)}` : "")));
}

// ---------- inspector: sections ----------

const TEXT_SIZE_PROP = new Set(["Text", "Anchor", "Highlight", "Mark"]);
const TEXTY = new Set(["Text", "Title", "Anchor", "Button", "Badge", "Code", "Highlight", "Mark", "Blockquote", "List"]);
const FILLED = new Set(["Button", "Badge", "ActionIcon", "Alert", "ThemeIcon", "Avatar", "Chip"]);
const ROUNDED = new Set(["Button", "Badge", "Card", "Paper", "Alert", "TextInput", "PasswordInput", "Textarea",
  "Select", "MultiSelect", "NumberInput", "ActionIcon", "ThemeIcon", "Avatar", "Image", "Chip", "Code"]);
const SURFACES = new Set(["Card", "Paper"]);
const SIZED = new Set(["Button", "Badge", "TextInput", "PasswordInput", "Textarea", "Select", "MultiSelect",
  "NumberInput", "ActionIcon", "ThemeIcon", "Avatar", "Checkbox", "Switch", "Radio", "Loader", "Chip"]);
const AUTO_LAYOUT = { Stack: "Vertical ↓", Group: "Horizontal →", Flex: "Flex" };
const SPACING_PROPS = ["m", "mt", "mr", "mb", "ml", "mx", "my", "p", "pt", "pr", "pb", "pl", "px", "py"];

function sections(name) {
  const src = propSource();
  const used = new Set();
  const use = (...props) => props.forEach((p) => used.add(p));
  const out = [];
  const section = (title, ...rows) => out.push(h("section", {}, h("h3", {}, title), ...rows.flat()));

  section("Layout",
    sizeControl(src, "w", "Width", "w"),
    sizeControl(src, "h", "Height", "h"),
    tokenControl(src, "maw", "Max width", "spacing", { allowZero: false }));
  use("w", "h", "maw");

  if (AUTO_LAYOUT[name]) {
    section("Auto layout",
      field("Direction", h("div", { class: "note" }, AUTO_LAYOUT[name])),
      tokenControl(src, "gap", "Gap", "spacing"),
      choiceControl(src, "align", "Align", [["flex-start", "Start"], ["center", "Center"], ["flex-end", "End"], ["stretch", "Stretch"]]),
      choiceControl(src, "justify", "Justify", [["flex-start", "Start"], ["center", "Center"], ["flex-end", "End"], ["space-between", "Space between"]]));
    use("gap", "align", "justify");
  }

  if (state.scope === "instance") {
    section("Spacing", boxModel(src));
    use(...SPACING_PROPS);
  }

  if (TEXTY.has(name)) {
    const sizeProp = TEXT_SIZE_PROP.has(name) ? "size" : "fz";
    section("Text",
      tokenControl(src, sizeProp, "Size", "fontSizes", { allowZero: false }),
      choiceControl(src, "fw", "Weight", [[400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"]]),
      colorControl(src, "c", "Colour"),
      choiceControl(src, "ta", "Align", [["left", "Left"], ["center", "Center"], ["right", "Right"]]));
    use(sizeProp, "fw", "c", "ta");
  }

  const appearance = [];
  if (FILLED.has(name)) {
    appearance.push(
      choiceControl(src, "variant", "Style", [["filled", "Filled"], ["light", "Light"], ["outline", "Outline"], ["subtle", "Subtle"], ["default", "Default"], ["transparent", "Transparent"]]),
      colorControl(src, "color", "Accent colour"));
    use("variant", "color");
  }
  if (SIZED.has(name)) {
    appearance.push(choiceControl(src, "size", "Component size", ["xs", "sm", "md", "lg", "xl"].map((t) => [t, t])));
    use("size");
  }
  if (ROUNDED.has(name)) {
    appearance.push(tokenControl(src, "radius", "Corner radius", "radius"));
    use("radius");
  }
  if (SURFACES.has(name)) {
    appearance.push(
      choiceControl(src, "shadow", "Shadow", ["xs", "sm", "md", "lg", "xl"].map((t) => [t, t])),
      toggleControl(src, "withBorder", "Border"));
    use("shadow", "withBorder");
  }
  appearance.push(colorControl(src, "bg", "Background"));
  use("bg");
  section("Appearance", ...appearance);

  return { out, used };
}

function rawPropRow(attr) {
  if (attr.kind === "computed") return field(attr.name, locked(attr.source));
  const input = h("input", { type: "text", value: String(attr.value) });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    const num = Number(raw);
    const value = raw === "" ? null
      : attr.kind === "boolean" ? raw !== "false"
        : attr.kind === "number" && Number.isFinite(num) ? num : raw;
    edit({ type: "prop", name: attr.name, value }, `${selLabel()}: ${attr.name} ${show(attr.value)} → ${show(value)}`);
  });
  return field(attr.name, h("div", { class: "ctl" }, input));
}

function askButton(text) {
  const b = h("button", { class: "linkish", "data-popover": true }, text);
  b.addEventListener("click", () => {
    const label = selLabel();
    const area = h("textarea", { class: "textbox", rows: 4, placeholder: `What should change about ${label}?` });
    const sendQ = h("button", { class: "primary", style: "margin-top:8px;width:100%" }, "Add question");
    sendQ.addEventListener("click", async () => {
      if (!area.value.trim()) { area.focus(); return; }
      try {
        await api("questions", { id: state.sel.id, label, route: state.route, text: area.value });
        toast("Question saved; it goes to the developer with Send for review");
        closePopover();
        refreshChanges();
      } catch (e) {
        toast(e.message, true);
      }
    });
    openPopover(b, h("div", {},
      h("div", { style: "font-weight:600;margin-bottom:4px" }, `Ask a developer about ${label}`),
      h("div", { class: "note" }, "For things the editor can't change. It's pinned to this element and sent with your review."),
      area, sendQ));
    setTimeout(() => area.focus(), 0);
  });
  return b;
}

function accessibilitySection() {
  const c = state.sel && state.canvas?.elementChecks(state.sel);
  if (!c || (!c.text && !c.target)) return null;
  const rows = [];
  const row = (label, value, good) => h("div", { class: "a11y-row" },
    h("span", {}, label), h("span", { class: good ? "ok" : "badge" }, value));
  if (c.text?.ratio) {
    rows.push(row("Text contrast", `${c.text.ratio}:1 ${c.text.ratio >= c.text.required ? "✓ AA" : `· needs ${c.text.required}:1`}`, c.text.ratio >= c.text.required));
  }
  if (c.text) rows.push(row("Text size", `${Math.round(c.text.size * 10) / 10}px${c.text.size < 12 ? " · small" : ""}`, c.text.size >= 12));
  if (c.target) {
    const okT = c.target.width >= 24 && c.target.height >= 24;
    rows.push(row("Click target", `${c.target.width}×${c.target.height}${okT ? " ✓" : " · aim for 24×24"}`, okT));
  }
  return h("section", {}, h("h3", {}, "Accessibility"), ...rows);
}

function renderDesign(panel) {
  const info = state.info;
  if (!state.sel) {
    panel.append(h("div", { class: "empty" },
      "Click anything on the page to edit it.", h("br"), h("br"),
      "Drag to move · double-click text to edit · Esc selects the parent · hold Space to use the app."));
    const ai = claudeSection();
    if (ai) panel.append(ai);
    return;
  }
  if (!info) { panel.append(h("div", { class: "empty" }, "Loading…")); return; }
  if (urlMode()) { renderDesignUrl(panel, info); return; }
  const d = state.canvas?.describe(state.sel);
  const [file, line] = state.sel.id.split(":");

  panel.append(h("div", { class: "head" },
    h("h2", { title: d?.label }, d?.label ?? info.name),
    h("div", { class: "sub" },
      info.mantine ? `${info.name} component` : /^[a-z]/.test(info.name) ? `HTML <${info.name}>` : `Custom component <${info.name}>`,
      d?.count > 1 ? ` · repeated ×${d.count} (edits change all)` : "",
      " · ", h("button", { class: "linkish", onclick: () => window.__veShell.selectParent() }, "Select parent ↑"),
      " · ", askButton("Ask a developer"))));
  const shared = state.scope === "instance" ? sharedSection() : null;
  if (shared) panel.append(shared);
  const ai = state.scope === "instance" ? claudeSection() : null;
  if (ai) panel.append(ai);

  if (info.mantine) {
    const onPage = state.canvas?.countByName(info.name) ?? 0;
    panel.append(h("section", {},
      h("div", { class: "seg full" },
        h("button", { class: state.scope === "instance" ? "on" : "", onclick: () => { state.scope = "instance"; renderPanel(); } }, "This element"),
        h("button", { class: state.scope === "component" ? "on" : "", onclick: () => { state.scope = "component"; renderPanel(); } },
          `All ${info.name}s`)),
      state.scope === "component"
        ? h("div", { class: "note" }, `Changes every ${info.name} in the app (${onPage} on this page). `,
          "Ones marked * set their own value here and keep it.")
        : null));
  }

  if (state.scope === "instance") {
    // Content
    const t = info.text;
    const content = [];
    if (t.editable) {
      const input = h("input", { type: "text", class: "textbox", value: t.value });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      input.addEventListener("change", () =>
        edit({ type: "text", value: input.value }, `${selLabel()}: text → “${input.value.trim()}”`));
      content.push(input, h("div", { class: "note" }, "Or double-click the text on the page."));
    } else if (t.source) {
      content.push(h("div", { class: "lock" }, "🔒 Filled in by the app (", h("code", {}, t.source), ") · ", askButton("Ask to change it")));
    } else if (t.reason === "mixed content" || t.reason === "contains elements") {
      content.push(h("div", { class: "note" }, "Contains other elements — select one of them to edit its text."));
    }
    if (content.length) panel.append(h("section", {}, h("h3", {}, "Text content"), ...content));

    // Position
    const mv = info.move;
    panel.append(h("section", {}, h("h3", {}, "Position"),
      mv.movable
        ? [
          h("div", { class: "btnrow" },
            h("button", { class: "btn", disabled: !mv.order[mv.index - 1],
              onclick: () => edit({ type: "move", targetId: mv.order[mv.index - 1][0], position: "before" }, `${selLabel()}: moved up`) }, "↑ Move up"),
            h("button", { class: "btn", disabled: !mv.order[mv.index + 1],
              onclick: () => edit({ type: "move", targetId: mv.order[mv.index + 1][0], position: "after" }, `${selLabel()}: moved down`) }, "↓ Move down")),
          h("div", { class: "note" }, `${mv.index + 1} of ${mv.order.length} in its container. Drag on the page to reorder; hold ⌘ while dragging to move into another container.`),
        ]
        : h("div", { class: "lock" }, mv.reason.includes("list")
          ? ["🔒 Part of a list the app builds from data — the order comes from code. ", askButton("Ask a developer")]
          : "🔒 This is the outer frame of a component; move it where it's used.")));
  }

  if (!info.mantine) {
    panel.append(h("section", {}, h("div", { class: "note" },
      /^[a-z]/.test(info.name)
        ? "Plain HTML element: style it by selecting the Mantine component around or inside it."
        : `${info.name} is one of the app's own components. Select the parts inside it to style them, or ask a developer to add an option.`)));
  } else {
    const { out, used } = sections(info.name);
    panel.append(...out);
    const a11y = accessibilitySection();
    if (a11y && state.scope === "instance") panel.append(a11y);
    if (state.scope === "instance") {
      const rest = info.attrs.filter((a) => !used.has(a.name));
      if (rest.length) {
        panel.append(h("details", {}, h("summary", {}, `More properties (${rest.length})`), ...rest.map(rawPropRow).flat()));
      }
    }
  }

  panel.append(h("details", {}, h("summary", {}, "Developer info"),
    h("div", { class: "mono" }, `<${info.name}>  ${file}:${line}`),
    ...info.attrs.map((a) => h("div", { class: "mono" }, `${a.name}=${a.kind === "computed" ? `{${a.source}}` : JSON.stringify(a.value)}`))));
}

// URL mode inspector: the element's computed CSS, changed as overrides.
function cssInput(info, prop, label) {
  const value = info.styles[prop] ?? "";
  const isColor = /color$/.test(prop);
  const input = h("input", { type: "text", class: "textbox", value, spellcheck: false });
  const commit = (v) => {
    const next = v.trim();
    if (next === value) return;
    edit({ type: "style", name: prop, value: next === "" ? null : next },
      `${info.description}: ${label.toLowerCase()} ${value || "default"} → ${next || "default"}`);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("change", () => commit(input.value));
  const ctl = [input];
  if (isColor) {
    const sw = h("button", { class: "swatch", style: `background:${value}`, title: "Pick a colour" });
    sw.addEventListener("click", () => {
      const picker = h("input", { type: "color" });
      picker.addEventListener("change", () => commit(picker.value));
      picker.click();
    });
    ctl.unshift(sw);
  }
  return field(label, h("div", { class: "ctl" }, ...ctl));
}

function renderDesignUrl(panel, info) {
  panel.append(h("div", { class: "head" },
    h("h2", { title: info.description }, info.description),
    h("div", { class: "sub" },
      info.mantine ? `${info.name} component (Mantine)` : `HTML <${info.tag}>`,
      " · ", h("button", { class: "linkish", onclick: () => window.__veShell.selectParent() }, "Select parent ↑"),
      " · ", askButton("Ask a developer"))));
  panel.append(h("div", { class: "note", style: "margin:0 12px 12px" },
    "You're editing the live site, not its code. Changes show here and go to a developer as a handoff."));
  if (info.text.editable) {
    const input = h("input", { type: "text", class: "textbox", value: info.text.value });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("change", () =>
      edit({ type: "text", value: input.value }, `${info.description}: text → “${input.value.trim()}”`));
    panel.append(h("section", {}, h("h3", {}, "Text content"), input,
      h("div", { class: "note" }, "Or double-click the text on the page.")));
  }
  const group = (title, rows) => h("section", {}, h("h3", {}, title), ...rows.flatMap(([p, l]) => cssInput(info, p, l)));
  panel.append(
    group("Colour", [["color", "Text"], ["background-color", "Fill"], ["opacity", "Opacity"]]),
    group("Typography", [["font-size", "Size"], ["font-weight", "Weight"], ["line-height", "Line height"],
      ["letter-spacing", "Letter spacing"], ["text-align", "Align"]]),
    group("Spacing", [["padding-top", "Padding top"], ["padding-right", "Padding right"], ["padding-bottom", "Padding bottom"],
      ["padding-left", "Padding left"], ["margin-top", "Margin top"], ["margin-right", "Margin right"],
      ["margin-bottom", "Margin bottom"], ["margin-left", "Margin left"], ["gap", "Gap"]]),
    group("Size", [["width", "Width"], ["height", "Height"], ["border-radius", "Corners"]]),
  );
  const a11y = accessibilitySection();
  if (a11y) panel.append(a11y);
  panel.append(h("details", {}, h("summary", {}, "Developer info"),
    h("div", { class: "mono" }, info.selector),
    info.classes.length ? h("div", { class: "mono" }, `class="${info.classes.join(" ")}"`) : null));
}

// ---------- theme tab, URL mode ----------
// The site's design tokens are the CSS variables on :root (Mantine defines
// several hundred). A change sets variables for every page and goes into the
// handoff with the Mantine theme key each one comes from.

async function themeVarEdit(vars, label, key, before) {
  try {
    const r = await api("theme-vars", { vars, label, key, before });
    toast(r.changed ? label : "No change");
  } catch (e) {
    toast(e.message, true);
  }
  await applyOverrides();
  await refreshChanges();
  renderPanel();
}

const pxLabel = (v) => { const px = toPx(v); return px === null ? v : `${px}`; };

function themeVarInput(t, name, label) {
  if (!(name in t.vars)) return [];
  const value = t.vars[name];
  const px = toPx(value);
  const changed = state.urlTheme && name in state.urlTheme;
  const input = h("input", { type: px === null ? "text" : "number", class: "textbox", value: px === null ? value : String(px), spellcheck: false });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    const next = raw === "" ? null : px !== null && /^[\d.]+$/.test(raw) ? `${raw}px` : raw;
    const site = t.site[name] ?? value;
    themeVarEdit({ [name]: next }, `Theme: ${label} ${pxLabel(value)}${px === null ? "" : "px"} → ${next === null ? "site default" : pxLabel(next) + (px === null ? "" : "px")}`,
      name, { [name]: site });
  });
  const row = field(label,
    h("div", { class: "ctl" }, input, px === null ? null : h("span", { class: "unit" }, "px")),
    { over: changed });
  if (changed) row[0].firstChild.title = `${label}: changed this session (the site has ${pxLabel(t.site[name] ?? value)})`;
  return row;
}

// Changing one shade also moves the variables that were showing that exact
// colour (the colour's "filled" and text variants, the primary colour), so a
// button using it changes too. Translucent "light" variants don't follow.
function shadeVars(t, color, i, next) {
  const name = `--mantine-color-${color}-${i}`;
  const old = (t.vars[name] ?? "").toLowerCase();
  const vars = { [name]: next };
  for (const [n, v] of Object.entries(t.vars)) {
    if (n === name || v.toLowerCase() !== old) continue;
    if (n.startsWith(`--mantine-color-${color}-`) && !/-\d$/.test(n)) vars[n] = next;
    else if (n.startsWith("--mantine-primary-color-") && !/-\d$/.test(n)) vars[n] = next;
    else if (n === `--mantine-primary-color-${i}`) vars[n] = next;
  }
  return vars;
}

function renderThemeUrl(panel) {
  const t = dom()?.themeVars();
  panel.append(h("div", { class: "head" }, h("h2", {}, "Theme"),
    h("div", { class: "sub" }, "Restyles every page of the site · from its CSS variables")));
  if (!t) { panel.append(h("div", { class: "empty" }, "Loading page…")); return; }
  const names = Object.keys(t.vars);
  if (!names.length) {
    panel.append(h("div", { class: "note", style: "margin:0 12px" },
      t.unreadable ? "This site's styles come from another domain, so its design tokens can't be read here."
        : "This site doesn't define design tokens as CSS variables, so there's no theme to edit. Style elements one at a time on the Design tab."));
    return;
  }
  const before = (vars) => Object.fromEntries(Object.keys(vars).map((n) => [n, t.site[n] ?? t.vars[n] ?? null]));
  const section = (title, rows, note) => h("section", {}, h("h3", {}, title), note ? h("div", { class: "note" }, note) : null,
    ...rows.flatMap(([n, l]) => themeVarInput(t, n, l)));
  const SIZES = ["xs", "sm", "md", "lg", "xl"];

  if (!t.mantine) {
    const list = names.slice(0, 200);
    panel.append(section(`Design tokens (${names.length})`, list.map((n) => [n, n.replace(/^--/, "")])));
    return;
  }

  // Colours
  const colors = [...new Set(names.map((n) => (/^--mantine-color-([A-Za-z]+)-6$/.exec(n) ?? [])[1]).filter(Boolean))];
  const p6 = (t.vars["--mantine-primary-color-6"] ?? "").toLowerCase();
  const primary = colors.find((c) => (t.vars[`--mantine-color-${c}-6`] ?? "").toLowerCase() === p6);
  const defined = new Set(names);
  const sel = h("select", { class: "textbox" }, ...colors.map((c) => h("option", { value: c, selected: c === primary }, c)));
  sel.addEventListener("change", () => {
    try {
      const vars = primaryColorVars(sel.value, defined);
      themeVarEdit(vars, `Theme: primary colour ${primary ?? "?"} → ${sel.value}`, "primaryColor", before(vars));
    } catch (e) { toast(e.message, true); }
  });
  const ramps = colors.map((c) => {
    const shades = [...Array(10).keys()].filter((i) => `--mantine-color-${c}-${i}` in t.vars);
    const row = h("div", { class: "chips" }, ...shades.map((i) => {
      const name = `--mantine-color-${c}-${i}`;
      const v = t.vars[name];
      const pick = h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000", title: `${c}.${i} ${v}` });
      pick.addEventListener("change", () => {
        const vars = shadeVars(t, c, i, pick.value);
        themeVarEdit(vars, `Theme: ${c}.${i} ${v} → ${pick.value}`, `colors.${c}.${i}`, before(vars));
      });
      const changed = state.urlTheme && name in state.urlTheme;
      return h("label", { class: "shade", title: `${c}.${i}${changed ? " (changed)" : ""}` },
        h("i", { style: `background:${v}${changed ? ";outline:2px solid #7c3aed" : ""}` }), pick);
    }));
    return h("details", { open: c === primary }, h("summary", {}, c === primary ? `${c} (primary)` : c), row);
  });
  panel.append(h("section", {}, h("h3", {}, "Colours"),
    ...field("Primary colour", sel),
    h("div", { class: "note" }, "Click a shade to change it. Buttons and text showing that exact colour follow."),
    ...ramps));

  panel.append(
    section("Fonts", [["--mantine-font-family", "Body"], ["--mantine-font-family-headings", "Headings"],
      ["--mantine-font-family-monospace", "Code"], ["--mantine-heading-font-weight", "Heading weight"]],
    "Fonts must already be loaded by the site."),
    section("Text sizes", [...SIZES.map((k) => [`--mantine-font-size-${k}`, k]),
      ...[1, 2, 3, 4, 5, 6].map((k) => [`--mantine-h${k}-font-size`, `H${k}`])]),
    section("Spacing scale", SIZES.map((k) => [`--mantine-spacing-${k}`, k])),
    section("Corner radius", [["--mantine-radius-default", "Default"], ...SIZES.map((k) => [`--mantine-radius-${k}`, k])]),
    section("Line heights", SIZES.map((k) => [`--mantine-line-height-${k}`, k])),
  );
  const other = names.filter((n) => !/^--mantine-(color|primary-color|font|spacing|radius|line-height|h\d|heading)/.test(n));
  if (other.length) {
    panel.append(h("details", {}, h("summary", {}, `Other variables (${other.length})`),
      ...other.slice(0, 150).flatMap((n) => themeVarInput(t, n, n.replace(/^--(mantine-)?/, "")))));
  }
}

// ---------- theme tab ----------

function themeValueInput(leaf, label, { removable = false } = {}) {
  if (leaf.kind === "computed" || leaf.kind === "alias") {
    return field(label, leaf.kind === "alias" ? h("div", { class: "note" }, `Same as ${leaf.value}`) : locked(leaf.source));
  }
  const p = pendingFor(leaf.path);
  const input = h("input", { type: leaf.kind === "rem" || leaf.kind === "number" ? "number" : "text", value: String(p ? p.value ?? "" : leaf.value) });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    if (raw === "" && !removable) { input.value = String(leaf.value); toast("Theme values can't be empty", true); return; }
    const value = raw === "" ? null : leaf.kind === "string" ? raw : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    const name = THEME_LABELS[leaf.path.join(".")] ?? leaf.path.filter((k) => k !== "defaultProps").join(" ");
    themeEdit(leaf.path, value, `Theme: ${name} ${show(leaf.value)} → ${show(value)}`);
  });
  return field(label, h("div", { class: "ctl" }, input, leaf.kind === "rem" || leaf.kind === "em" ? h("span", { class: "unit" }, "px") : null));
}

const THEME_LABELS = {
  primaryColor: "Primary colour", primaryShade: "Primary shade", fontFamily: "Body font",
  fontFamilyMonospace: "Code font", "headings.fontFamily": "Heading font", "headings.fontWeight": "Heading weight",
  defaultRadius: "Corner radius",
};

function renderTheme(panel) {
  if (urlMode()) { renderThemeUrl(panel); return; }
  const theme = state.theme;
  if (!theme) { panel.append(h("div", { class: "empty" }, "Loading theme…")); loadTheme().then(renderPanel); return; }
  panel.append(h("div", { class: "head" }, h("h2", {}, "Theme"),
    h("div", { class: "sub" }, `Restyles every page · ${theme.file ?? "no theme file"}`)));
  if (theme.error) { panel.append(h("div", { class: "note" }, theme.error)); return; }
  const leaves = theme.leaves;
  const primary = leaves.find((l) => l.path[0] === "primaryColor")?.value;

  const colours = h("section", {}, h("h3", {}, "Colours"));
  for (const [name, shades] of ramps()) {
    colours.append(h("div", { class: "mono" }, name + (name === primary ? "  · primary" : "")));
    colours.append(h("div", { class: "ramp" }, ...shades.map((l) => {
      const hex = /^#[0-9a-f]{6}$/i.test(l.value) ? l.value : null;
      const input = h("input", { type: "color", value: hex ? hex.toLowerCase() : "#000000", disabled: !hex, title: `${name} ${l.path[2]}  ${l.value}` });
      input.addEventListener("change", () => {
        const next = hex === hex?.toUpperCase() ? input.value.toUpperCase() : input.value;
        themeEdit(l.path, next, `Theme: ${name} ${l.path[2]} ${l.value} → ${next}`);
      });
      return input;
    })));
  }
  for (const l of leaves.filter((x) => x.path[0] === "colors" && x.kind === "alias")) {
    colours.append(h("div", { class: "note" }, `${l.path[1]} = same as ${l.value}`));
  }
  panel.append(colours);

  const brand = h("section", {}, h("h3", {}, "Brand"));
  const pc = leaves.find((l) => l.path.join(".") === "primaryColor");
  if (pc) {
    const sel = h("select", {}, ...[...ramps().keys()].map((n) => h("option", { value: n }, n)));
    sel.value = pendingFor(pc.path)?.value ?? pc.value;
    sel.addEventListener("change", () => themeEdit(pc.path, sel.value, `Theme: primary colour ${pc.value} → ${sel.value}`));
    brand.append(...field("Primary colour", h("div", { class: "ctl" }, sel)));
  }
  const ps = leaves.find((l) => l.path.join(".") === "primaryShade");
  if (ps && typeof ps.value === "number") {
    const sel = h("select", {}, ...[...Array(10).keys()].map((i) => h("option", { value: i }, String(i))));
    sel.value = String(pendingFor(ps.path)?.value ?? ps.value);
    sel.addEventListener("change", () => themeEdit(ps.path, Number(sel.value), `Theme: primary shade ${ps.value} → ${sel.value}`));
    brand.append(...field("Primary shade", h("div", { class: "ctl" }, sel)));
  }
  panel.append(brand);

  const groups = [
    ["Typography", (l) => /^(font|headings|lineHeights)/.test(l.path[0])],
    ["Spacing scale", (l) => l.path[0] === "spacing"],
    ["Corners & shadows", (l) => /radius|shadows/i.test(l.path[0])],
    ["Component defaults", (l) => l.path[0] === "components"],
  ];
  const used = new Set(leaves.filter((l) => l.path[0] === "colors" || ["primaryColor", "primaryShade"].includes(l.path[0])));
  for (const [title, test] of groups) {
    const items = leaves.filter((l) => !used.has(l) && test(l));
    items.forEach((l) => used.add(l));
    if (!items.length) continue;
    const s = h("section", {}, h("h3", {}, title));
    for (const l of items) {
      const p = l.path.join(".");
      const label = THEME_LABELS[p] ??
        (l.path[0] === "components" ? `${l.path[1]} · ${l.path[3]}` : l.path.length === 2 ? l.path[1] : p);
      s.append(...themeValueInput(l, label, { removable: l.path[0] === "components" }));
    }
    panel.append(s);
  }
  panel.append(figmaSection(leaves));
  const other = leaves.filter((l) => !used.has(l));
  if (other.length) {
    panel.append(h("details", {}, h("summary", {}, `Other theme values (${other.length})`),
      ...other.flatMap((l) => themeValueInput(l, l.path.join(".")))));
  }
}

// ---------- changes tab ----------

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function figmaSection(leaves) {
  const s = h("section", {}, h("h3", {}, "Compare with Figma"));
  const file = h("input", { type: "file", accept: ".json,application/json" });
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const { flattenTokens } = await import("/__ve/tokens.js");
      const tokens = flattenTokens(JSON.parse(await f.text()));
      if (!tokens.length) throw new Error("no tokens found in that file");
      state.figma = { name: f.name, tokens };
    } catch (e) {
      toast(`Couldn't read ${f.name}: ${e.message}`, true);
    }
    renderPanel();
  });
  if (!state.figma) {
    s.append(h("div", { class: "note" },
      "Export your Figma variables or tokens as JSON (Variables export, Tokens Studio or W3C format) and pick the file to see where the app and Figma differ."), file);
    return s;
  }
  const holder = h("div", {}, h("div", { class: "note" }, `Comparing with ${state.figma.name}…`));
  s.append(holder);
  import("/__ve/tokens.js").then(({ compareTokens }) => {
    const r = compareTokens(state.figma.tokens, leaves);
    holder.replaceChildren(
      h("div", { class: "note" }, `${state.figma.name}: ${r.same} of ${r.checked} theme values match Figma`,
        r.diffs.length ? `, ${r.diffs.length} differ` : "",
        r.missingInFigma.length ? `, ${r.missingInFigma.length} aren't in Figma` : "",
        ". ", h("button", { class: "linkish", onclick: () => { state.figma = null; renderPanel(); } }, "Clear")),
      ...r.diffs.map((d) => {
        const isColor = d.path[0] === "colors";
        const label = isColor ? `${d.path[1]} ${d.path[2]}` : d.path.join(" ");
        return h("div", { class: "figma-row" },
          h("div", {}, h("div", {}, label),
            h("div", { class: "vals" },
              "app", isColor ? swatch(d.code) : null, h("span", { class: "mono" }, show(d.code)),
              "· Figma", isColor ? swatch(d.figma) : null, h("span", { class: "mono" }, show(d.figma)))),
          h("button", {
            class: "btn",
            onclick: () => themeEdit(d.path, d.figma, `Theme: ${label} ${show(d.code)} → ${show(d.figma)} (from Figma)`),
          }, "Use Figma"));
      }),
      r.missingInFigma.length ? h("details", {}, h("summary", {}, `Not in Figma (${r.missingInFigma.length})`),
        h("div", { class: "mono" }, r.missingInFigma.join(", "))) : "");
  }).catch((e) => holder.replaceChildren(h("div", { class: "note" }, `Comparison failed: ${e.message}`)));
  return s;
}

function refreshCheckCount() {
  try {
    state.checks = state.canvas?.checks() ?? [];
  } catch (e) {
    state.checks = [];
    console.error("[visual-edit] page checks failed", e);
  }
  renderTabs();
}

const CHECK_GROUPS = [
  ["overflow", "Sticks out at this width"],
  ["contrast", "Low text contrast"],
  ["small-text", "Small text"],
  ["target", "Small click targets"],
];

function renderChecks(panel) {
  refreshCheckCount();
  const width = state.canvas?.viewportWidth();
  panel.append(h("div", { class: "head" }, h("h2", {}, "Checks"),
    h("div", { class: "sub" }, `Accessibility (WCAG AA) and layout problems on this page${width ? ` at ${width}px wide` : ""}. Click one to select it.`)));
  if (!state.checks.length) {
    panel.append(h("div", { class: "empty" }, "No problems found on this page. Try other widths and data states too."));
    return;
  }
  for (const [kind, title] of CHECK_GROUPS) {
    const items = state.checks.filter((c) => c.kind === kind);
    if (!items.length) continue;
    panel.append(h("section", {}, h("h3", {}, `${title} (${items.length})`),
      ...items.map((c) => h("div", {
        class: "issue",
        onclick: () => select(c.ref),
        onmouseenter: () => state.canvas?.setLayerHover(c.ref),
        onmouseleave: () => state.canvas?.setLayerHover(null),
      }, h("div", {}, c.label), h("div", { class: "msg" }, c.message)))));
  }
}

function renderChanges(panel) {
  panel.append(h("div", { class: "head" }, h("h2", {}, "Your changes"),
    h("div", { class: "sub" }, "Everything you've changed this session. Revert any one of them.")));
  if (state.review?.dir) {
    const r = state.review;
    panel.append(h("div", { class: "result" },
      h("strong", {}, `Handoff saved (${r.sent} change${r.sent === 1 ? "" : "s"}${r.asked ? `, ${r.asked} question${r.asked === 1 ? "" : "s"}` : ""})`), h("br"),
      h("code", {}, r.dir), h("br"),
      "A developer can give ", h("code", {}, "prompt.md"), " and the screenshots to Claude, or pull it over MCP with get_handoff."));
  } else if (state.review) {
    const r = state.review;
    panel.append(h("div", { class: "result" },
      h("strong", {}, `Sent ${[
        r.sent ? `${r.sent} change${r.sent === 1 ? "" : "s"}` : "",
        r.asked ? `${r.asked} question${r.asked === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" and ")} for review`), h("br"),
      "Branch ", h("code", {}, r.branch), " · commit ", h("code", {}, r.commit), h("br"),
      r.prUrl ? h("a", { href: r.prUrl, target: "_blank" }, "Open pull request")
        : r.pushed ? "Pushed." : h("span", {}, "Saved on this machine. A developer can publish it with ",
          h("code", {}, `git push -u origin ${r.branch}`), ".")));
  }
  if (state.questions.length) {
    panel.append(h("section", {}, h("h3", {}, `Questions for developers (${state.questions.length})`),
      ...state.questions.map((q) => h("div", { class: "question" },
        h("div", {}, h("strong", {}, `#${q.n} ${q.label}: `), q.text),
        h("button", {
          class: "btn danger",
          onclick: async () => {
            try { await api("questions-delete", { n: q.n }); } catch (e) { toast(e.message, true); }
            refreshChanges();
          },
        }, "Delete"),
        h("div", { class: "when" }, `${ago(q.at)} · page ${q.route}`)))));
  }
  if (!state.changes.length && !state.questions.length) {
    panel.append(h("div", { class: "empty" }, "No changes yet."));
    return;
  }
  const list = h("div");
  for (const c of [...state.changes].reverse()) {
    list.append(h("div", { class: "change" },
      h("div", {}, c.label),
      h("button", { class: "btn", disabled: state.showOriginal, onclick: () => revert(c.n) }, "Revert"),
      h("div", { class: "when" }, `${ago(c.at)} · ${c.rel}`),
      c.pages ? h("div", { class: "page-pill" }, `Shows on ${c.pages.list.length} pages (${c.pages.component}) · `,
        h("button", { class: "linkish", onclick: () => startTour(c.pages.component, c.pages.list) }, "Step through them")) : null));
  }
  panel.append(list);

  const title = h("input", { type: "text", class: "textbox", placeholder: "Short title, e.g. Rounder buttons on login" });
  const notes = h("textarea", { class: "textbox", rows: 3, placeholder: "Notes for the reviewer (optional)" });
  const send = h("button", { class: "primary", style: "margin-top:8px;width:100%" }, urlMode() ? "Save handoff" : "Send for review");
  send.addEventListener("click", async () => {
    if (!title.value.trim()) { title.focus(); toast("Give the change a short title", true); return; }
    send.disabled = true;
    try {
      const body = { title: title.value, notes: notes.value };
      if (urlMode()) body.screenshots = await beforeAfterShots();
      state.review = await api("review", body);
      toast(state.review.dir ? `Handoff saved to ${state.review.dir}` : `Sent for review on ${state.review.branch}`);
    } catch (e) {
      toast(`Couldn't send for review: ${e.message}`, true);
    }
    send.disabled = false;
    await refreshChanges();
    renderPanel();
  });
  const dirty = state.dirtyBefore ?? [];
  panel.append(h("section", {}, h("h3", {}, "Send for review"),
    dirty.length ? h("div", { class: "warn", style: "margin:0 0 8px" },
      `${dirty.join(", ")} already had other unsaved edits before this session. They'll be included; ask a developer if that's unexpected.`) : null,
    h("div", { class: "note" }, urlMode()
      ? "Saves a prompt for a developer's Claude, with before and after screenshots of this page, in a folder on this computer."
      : state.config.allowPush
        ? "Commits these changes to a new branch, pushes it and opens a pull request."
        : "Commits these changes (and questions) to a new branch for a developer to review."),
    title, h("div", { style: "height:6px" }), notes, send,
    h("button", { class: "btn", style: "margin-top:8px;width:100%", onclick: copyPrompt }, "Copy as a prompt for Claude")));
}

async function copyPrompt() {
  try {
    const { markdown } = await api("handoff");
    await navigator.clipboard.writeText(markdown);
    toast("Copied. Paste it into Claude to implement or review these changes.");
  } catch (e) {
    toast(`Couldn't copy the prompt: ${e.message}`, true);
  }
}

// The current page without and with the session's overrides.
async function beforeAfterShots() {
  if (!state.canvas || !dom()) throw new Error("The page hasn't loaded yet");
  const after = await state.canvas.shot(null);
  dom().setOverrides([]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    return { before: await state.canvas.shot(null), after };
  } finally {
    await applyOverrides();
  }
}

// ---------- panel + tabs ----------

function renderTabs() {
  for (const b of document.querySelectorAll(".tabs button")) {
    b.classList.toggle("on", b.dataset.tab === state.tab);
    const n = { changes: state.changes.length + state.questions.length, checks: state.checks.length }[b.dataset.tab];
    if (n !== undefined) b.textContent = `${b.dataset.tab[0].toUpperCase()}${b.dataset.tab.slice(1)}${n ? ` (${n})` : ""}`;
  }
}

function renderPanel() {
  renderTabs();
  const panel = $("#panel");
  const scroll = panel.parentElement.scrollTop;
  panel.replaceChildren();
  const bar = pendingBar();
  if (bar) panel.append(bar);
  if (state.tab === "theme") renderTheme(panel);
  else if (state.tab === "checks") renderChecks(panel);
  else if (state.tab === "changes") renderChanges(panel);
  else {
    if (state.scope === "component" && !state.theme) {
      panel.append(h("div", { class: "empty" }, "Loading theme…"));
      loadTheme().then(renderPanel);
      return;
    }
    renderDesign(panel);
  }
  panel.parentElement.scrollTop = scroll;
}

// ---------- toolbar ----------

for (const b of document.querySelectorAll("#mode button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode));
}
function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll("#mode button")) b.classList.toggle("on", b.dataset.mode === mode);
  state.canvas?.setMode(mode);
}

for (const b of document.querySelectorAll("#widths button")) {
  b.addEventListener("click", () => {
    for (const x of document.querySelectorAll("#widths button")) x.classList.toggle("on", x === b);
    frame.style.width = b.dataset.w ? `${b.dataset.w}px` : "100%";
    frame.style.flex = b.dataset.w ? "none" : "";
  });
}

for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => { state.tab = b.dataset.tab; closePopover(); renderPanel(); });
}

$("#route").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const path = e.target.value.trim() || "/";
  frame.contentWindow.location.href = path.startsWith("/") ? path : `/${path}`;
});
$("#reload").addEventListener("click", () => frame.contentWindow.location.reload());
$("#review").addEventListener("click", () => { state.tab = "changes"; renderPanel(); });

$("#original").addEventListener("change", async (e) => {
  try {
    await api("original", { on: e.target.checked });
    if (e.target.checked) select(null);
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
  refreshChanges();
});

$("#demo").addEventListener("click", async () => {
  try {
    const r = await api("demo-login", {});
    toast(`Signed in as ${r.user}`);
    frame.contentWindow.location.href = state.config.demoStart ?? "/";
  } catch (e) {
    toast(e.message, true);
  }
});

const isTextField = (a) => a?.isContentEditable || /^(TEXTAREA|SELECT)$/.test(a?.tagName ?? "") ||
  (a?.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(a.type));

document.addEventListener("keydown", (e) => {
  if (isTextField(document.activeElement)) return;
  if (e.key === "Escape" && !$("#help").hidden) { showHelp(false); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else revert(); }
  else if (e.key === "?") showHelp(true);
  else if (e.key === "Escape") { closePopover(); if (state.sel) window.__veShell.selectParent(); }
});

// ---------- start ----------

document.body.append(h("datalist", { id: "ve-space" },
  ...["0", "xs", "sm", "md", "lg", "xl"].map((t) => h("option", { value: t }))));

$("#helpbtn").addEventListener("click", () => showHelp(true));
$("#helpclose").addEventListener("click", () => showHelp(false));
$("#help").addEventListener("click", (e) => { if (e.target.id === "help") showHelp(false); });

$("#data").addEventListener("change", (e) => {
  try {
    sessionStorage.setItem("ve-data-state", e.target.value);
  } catch (err) {
    toast(`Couldn't switch test data: ${err.message}`, true);
    return;
  }
  renderBanner();
  frame.contentWindow.location.reload();
});
try {
  $("#data").value = sessionStorage.getItem("ve-data-state") || "live";
} catch (e) {
  console.warn("[visual-edit] couldn't read the test-data state", e);
}

(async () => {
  try {
    state.config = await api("config");
  } catch (e) {
    toast(`Couldn't reach the editor server: ${e.message}`, true);
  }
  $("#demo").hidden = !state.config.demoLogin;
  if (state.config.demoUser) $("#demo").textContent = `Sign in as ${state.config.demoUser}`;
  const start = new URLSearchParams(location.search).get("path") ?? "/";
  frame.src = start;
  await loadTheme();
  await refreshChanges();
  // A run started before this page loaded (e.g. the editor was reloaded).
  try {
    const c = await api("claude");
    if (c.job) { state.ai = { job: c.job, status: "running", prompt: "", events: [], next: 0, result: null, startedAt: Date.now() }; pollAi(); }
  } catch (e) {
    console.warn("[visual-edit] couldn't check for a running Claude request", e);
  }
  renderLayers();
  renderPanel();
  connectLive();
})();
