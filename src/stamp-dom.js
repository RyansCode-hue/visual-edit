// URL mode, injected into the proxied site: gives elements the data-ve ids
// the canvas works with, from the live DOM instead of the source, and applies
// the session's style and text overrides.
//
// An id is "dom:" + a CSS selector path from the nearest stable anchor (id,
// data-testid, name) down through :nth-of-type steps, so the same element gets
// the same id after a reload as long as the page's structure is the same.
// The name (data-ve-n) is the Mantine component when the element is a Mantine
// root (class "mantine-Button-root" → Button), otherwise the tag.
(function () {
  "use strict";
  if (window.__veDom) return;

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "BR", "HEAD", "HTML"]);
  const SEMANTIC = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "A", "BUTTON", "IMG", "INPUT", "TEXTAREA",
    "SELECT", "LABEL", "LI", "UL", "OL", "TABLE", "TR", "TD", "TH", "SECTION", "HEADER", "FOOTER", "NAV", "MAIN",
    "ASIDE", "FORM", "ARTICLE", "SVG", "VIDEO"]);
  const ANCHORS = ["id", "data-testid", "data-test", "name"];
  const cssId = (s) => (window.CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));

  function mantineName(el) {
    for (const c of el.classList) {
      const m = /^mantine-([A-Z][A-Za-z]*)-root$/.exec(c);
      if (m) return m[1];
    }
    return null;
  }

  function hasOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  }

  function worthStamping(el) {
    if (SKIP.has(el.tagName) || el.id === "visual-edit-canvas") return false;
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") return false;
    if (mantineName(el) || SEMANTIC.has(el.tagName) || hasOwnText(el)) return true;
    return el.children.length >= 2; // containers that lay out several things
  }

  // Ids that libraries generate per render (Mantine's "mantine-u5nw0r5ot",
  // React's ":r1:") change on every load, so they can't anchor a path.
  function looksStable(v) {
    if (/^(mantine|radix|headlessui|react-aria|chakra|mui)[-_]/i.test(v) || /^[:«]/.test(v)) return false;
    return !v.split(/[-_:.]/).some((seg) =>
      (seg.length >= 5 && /\d/.test(seg) && /[a-z]/i.test(seg)) || /^\d{3,}$/.test(seg));
  }

  function anchorSelector(el) {
    for (const a of ANCHORS) {
      const v = el.getAttribute(a);
      if (!v || !looksStable(v)) continue;
      const sel = a === "id" ? `#${cssId(v)}` : `${el.tagName.toLowerCase()}[${a}="${v.replace(/"/g, '\\"')}"]`;
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch { /* not a valid selector; keep walking up */ }
    }
    return null;
  }

  /** Selector path for an element: anchored where possible, else from body. */
  function pathOf(el) {
    const steps = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const anchor = anchorSelector(e);
      if (anchor) { steps.unshift(anchor); break; }
      if (e === document.body) { steps.unshift("body"); break; }
      const tag = e.tagName.toLowerCase();
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      steps.unshift(`${tag}:nth-of-type(${i})`);
    }
    return steps.join(" > ");
  }

  /** Stamps the page; true when any element's id or name changed. */
  function stampAll() {
    let changed = false;
    const all = document.body ? document.body.querySelectorAll("*") : [];
    for (const el of all) {
      if (!worthStamping(el)) {
        if (el.hasAttribute("data-ve")) { el.removeAttribute("data-ve"); el.removeAttribute("data-ve-n"); changed = true; }
        continue;
      }
      const id = `dom:${pathOf(el)}`;
      if (el.getAttribute("data-ve") !== id) { el.setAttribute("data-ve", id); changed = true; }
      const name = mantineName(el) ?? el.tagName.toLowerCase();
      if (el.getAttribute("data-ve-n") !== name) { el.setAttribute("data-ve-n", name); changed = true; }
    }
    return changed;
  }

  // A variable's value without the session's theme changes.
  function siteValue(name) {
    const was = themeEl.textContent;
    themeEl.textContent = "";
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    themeEl.textContent = was;
    return v;
  }

  // ---------- overrides ----------
  let overrides = []; // [{ page, selector, styles: {prop: value}, text }]
  let themeVars = {}; // { "--mantine-spacing-xs": "12px" }, every page
  const styleEl = document.createElement("style");
  styleEl.id = "ve-overrides";
  const themeEl = document.createElement("style");
  themeEl.id = "ve-theme";
  const originalText = new WeakMap();

  const onThisPage = (o) => o.page === location.pathname;
  const declarations = (styles) =>
    Object.entries(styles).map(([k, v]) => `${k}: ${v} !important;`).join(" ");

  function applyOverrides() {
    const mine = overrides.filter(onThisPage);
    const css = mine.filter((o) => Object.keys(o.styles ?? {}).length)
      .map((o) => `${o.selector} { ${declarations(o.styles)} }`).join("\n");
    if (styleEl.textContent !== css) styleEl.textContent = css;
    if (!styleEl.isConnected && document.head) document.head.append(styleEl);
    // Matches Mantine's own :root[data-mantine-color-scheme] rules, which
    // define some variables per colour scheme.
    const vars = Object.entries(themeVars);
    const theme = vars.length
      ? `html:root, html:root[data-mantine-color-scheme] { ${vars.map(([k, v]) => `${k}: ${v} !important;`).join(" ")} }`
      : "";
    if (themeEl.textContent !== theme) themeEl.textContent = theme;
    if (!themeEl.isConnected && document.head) document.head.append(themeEl);
    for (const o of mine) {
      if (typeof o.text !== "string") continue;
      let el;
      try { el = document.querySelector(o.selector); } catch { el = null; }
      if (!el || el.isContentEditable) continue;
      if (!originalText.has(el)) originalText.set(el, el.textContent);
      if (el.textContent !== o.text) el.textContent = o.text;
    }
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const changed = stampAll();
      applyOverrides();
      // The editor's layers and selection read the stamps.
      if (changed) {
        try {
          if (window.parent !== window) window.parent.__veShell?.domChanged?.();
        } catch (e) {
          console.warn("[visual-edit] couldn't tell the editor the page changed", e);
        }
      }
    });
  };

  const observer = new MutationObserver(schedule);
  const start = () => {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
  // SPA navigation changes which overrides apply.
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) { const r = orig.apply(this, args); schedule(); return r; };
  }
  addEventListener("popstate", schedule);

  const PROPS = ["color", "background-color", "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "width", "height", "border-radius", "gap", "opacity"];

  window.__veDom = {
    setOverrides(list, vars) {
      themeVars = vars && typeof vars === "object" ? vars : {};
      // Text overrides that went away: put the page's own text back.
      const before = overrides;
      overrides = Array.isArray(list) ? list : [];
      for (const o of before) {
        if (typeof o.text !== "string" || overrides.some((n) => n.selector === o.selector && typeof n.text === "string")) continue;
        let el;
        try { el = document.querySelector(o.selector); } catch { el = null; }
        if (el && originalText.has(el)) el.textContent = originalText.get(el);
      }
      applyOverrides();
    },
    /** What the inspector shows for a selection in URL mode. */
    describe(id) {
      const el = document.querySelector(`[data-ve="${cssId(id)}"]`);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const styles = {};
      for (const p of PROPS) styles[p] = cs.getPropertyValue(p);
      const leaf = el.children.length === 0;
      // The site's own text, not an override showing in its place.
      const own = originalText.get(el) ?? el.textContent;
      const text = (leaf ? own : el.innerText ?? own).replace(/\s+/g, " ").trim();
      return {
        id,
        selector: id.slice(4),
        name: el.getAttribute("data-ve-n"),
        tag: el.tagName.toLowerCase(),
        mantine: Boolean(mantineName(el)),
        classes: [...el.classList].filter((c) => !/^m_[0-9a-f]+$/.test(c)).slice(0, 8),
        text: leaf && text
          ? { editable: true, value: own }
          : { editable: false, reason: text ? "contains elements" : "no text" },
        styles,
        description: `${mantineName(el) ? `${mantineName(el)} (Mantine)` : `<${el.tagName.toLowerCase()}>`}` +
          `${text ? ` “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”` : ""}`,
      };
    },
    restamp: schedule,
    /**
     * The design tokens the page defines as CSS variables on :root, with
     * their current values: { mantine, vars: { name: value } }. Read from the
     * page's own stylesheets; ones on other origins can't be read.
     */
    themeVars() {
      const names = new Set();
      let unreadable = 0;
      const visit = (rules) => {
        for (const r of rules) {
          if (r.cssRules && !r.selectorText) { visit(r.cssRules); continue; }
          if (!r.selectorText || !/:root|^html\b/.test(r.selectorText)) continue;
          for (const p of r.style) if (p.startsWith("--")) names.add(p);
        }
      };
      for (const sheet of document.styleSheets) {
        if (sheet.ownerNode?.id === "ve-theme" || sheet.ownerNode?.id === "ve-preview") continue;
        try { visit(sheet.cssRules); } catch { unreadable++; }
      }
      const cs = getComputedStyle(document.documentElement);
      const vars = {};
      for (const n of [...names].sort()) vars[n] = cs.getPropertyValue(n).trim();
      // The site's own values of the ones this session changed.
      const site = {};
      for (const n of Object.keys(themeVars)) site[n] = siteValue(n);
      return { mantine: names.has("--mantine-spacing-md"), vars, site, unreadable };
    },
  };
})();
