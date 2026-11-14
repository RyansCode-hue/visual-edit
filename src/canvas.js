// Runs inside the app page when the visual-edit shell loads it in an iframe.
// Owns everything that touches the app's DOM: hover/selection boxes, resize
// handles, drag-to-reorder, in-place text editing and the layer tree. All
// decisions and source edits go through the shell (window.parent.__veShell).
//
// Elements are tracked by their data-ve id ("file:line:col") plus their index
// among elements with the same id, because hot reload replaces DOM nodes and
// one source element can render many times (lists).

const shell = (() => {
  try {
    return window.parent !== window ? window.parent.__veShell ?? null : null;
  } catch {
    return null; // cross-origin parent: not our shell
  }
})();

if (shell) init(shell);

function init(shell) {
  const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font: 11px/1.4 -apple-system, system-ui, sans-serif; }
.box { position: fixed; pointer-events: none; z-index: 2147483646; display: none; }
.hover { outline: 1px solid #a78bfa; }
.sel { outline: 2px solid #7c3aed; }
.tag { position: absolute; left: -2px; top: -19px; background: #7c3aed; color: #fff;
  padding: 1px 6px; border-radius: 3px 3px 0 0; white-space: nowrap; }
.h { position: absolute; width: 10px; height: 10px; background: #fff; border: 2px solid #7c3aed;
  border-radius: 2px; pointer-events: auto; }
.h.e { right: -6px; top: calc(50% - 5px); cursor: ew-resize; }
.h.s { bottom: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.h.se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.readout { position: fixed; z-index: 2147483647; background: #111; color: #fff; padding: 2px 6px;
  border-radius: 3px; display: none; pointer-events: none; }
.drop { position: fixed; z-index: 2147483647; background: #7c3aed; border-radius: 2px;
  pointer-events: none; display: none; box-shadow: 0 0 0 2px #fff; }
`;

  const host = document.createElement("div");
  host.id = "visual-edit-canvas";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${STYLES}</style>
<div class="box hover"></div>
<div class="box sel"><div class="tag"></div>
  <div class="h e" data-dir="e"></div><div class="h s" data-dir="s"></div><div class="h se" data-dir="se"></div></div>
<div class="readout"></div>
<div class="drop"></div>`;
  document.body.appendChild(host);

  const $ = (s) => shadow.querySelector(s);
  const hoverBox = $(".hover");
  const selBox = $(".sel");
  const tag = $(".tag");
  const readout = $(".readout");
  const dropLine = $(".drop");

  let mode = "design";      // "design" | "interact"
  let spaceHeld = false;    // hold Space in design mode to use the app
  let hovered = null;       // Element under the pointer
  let layerHover = null;    // { id, index } highlighted from the layers panel
  let sel = null;           // { id, index }
  let resizing = null;
  let editingText = null;   // { el, original }
  let drag = null;          // { el, x, y, active, target }
  let justDragged = false;  // swallow the click that ends a drag

  // ---------- helpers ----------

  const designing = () => mode === "design" && !spaceHeld;
  const isOurs = (e) => e.composedPath().includes(host);
  const stamped = (el) => el?.closest?.("[data-ve]") ?? null;
  const all = (id) => document.querySelectorAll(`[data-ve="${CSS.escape(id)}"]`);
  const find = (s) => (s ? all(s.id)[s.index] ?? all(s.id)[0] ?? null : null);
  const ref = (el) => {
    const id = el.getAttribute("data-ve");
    return { id, index: [...all(id)].indexOf(el) };
  };

  function ownText(el) {
    if (el.querySelectorAll("[data-ve]").length > 3) return "";
    const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return t.length > 30 ? `${t.slice(0, 29)}…` : t;
  }

  function labelOf(el) {
    const t = ownText(el);
    return t ? `${el.dataset.veN} “${t}”` : el.dataset.veN;
  }

  function place(box, el) {
    if (!el) { box.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block", left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }

  // ---------- page interaction (capture phase, design mode only) ----------

  function swallow(e) {
    if (!designing() || isOurs(e) || editingText) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "submit", "focusin"]) {
    document.addEventListener(type, swallow, true);
  }

  document.addEventListener("mousemove", (e) => {
    hovered = designing() && !resizing && !isOurs(e) ? stamped(e.target) : null;
  }, true);
  document.addEventListener("mouseleave", () => { hovered = null; });

  document.addEventListener("click", (e) => {
    if (!swallow(e)) return;
    if (justDragged) { justDragged = false; return; }
    const el = stamped(e.target);
    if (el) shell.pick(ref(el));
  }, true);

  document.addEventListener("dblclick", (e) => {
    if (!swallow(e)) return;
    const el = find(sel);
    const info = shell.getInfo();
    if (!el || !el.contains(e.target)) return;
    if (!info?.text?.editable) {
      if (info?.text) shell.status(`This text can't be edited here: ${info.text.reason}`, true);
      return;
    }
    const label = labelOf(el);
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
        shell.edit({ type: "text", value }, `${label}: text → “${value.trim()}”`);
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
    if (editingText) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "") ||
      document.activeElement?.isContentEditable;
    if (mode === "design" && e.code === "Space" && !typing) {
      e.preventDefault();
      if (!spaceHeld) { spaceHeld = true; hovered = null; shell.spaceHeld(true); }
      return;
    }
    if (!designing()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (drag?.active) { endDrag(); justDragged = true; shell.status("Move cancelled"); }
      else shell.selectParent();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      shell.undo();
    }
  }, true);

  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && spaceHeld) { spaceHeld = false; shell.spaceHeld(false); }
  }, true);
  window.addEventListener("blur", () => {
    if (spaceHeld) { spaceHeld = false; shell.spaceHeld(false); }
  });

  // ---------- resize ----------

  selBox.addEventListener("mousedown", (e) => {
    const dir = e.target.dataset?.dir;
    const el = find(sel);
    if (!dir || !el || !designing()) return;
    const info = shell.getInfo();
    if (!info?.mantine) {
      shell.status("Resizing needs a Mantine component", true);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    resizing = {
      dir, el, label: labelOf(el), startX: e.clientX, startY: e.clientY,
      w: Math.round(r.width), h: Math.round(r.height),
      prevW: el.style.width, prevH: el.style.height, nextW: null, nextH: null,
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
    readout.textContent = `${z.nextW ?? z.w} × ${z.nextH ?? z.h}` + (e.shiftKey ? "  · snap 8" : "");
    Object.assign(readout.style, { display: "block", left: `${e.clientX + 14}px`, top: `${e.clientY + 14}px` });
  }, true);

  window.addEventListener("mouseup", async () => {
    if (!resizing) return;
    const z = resizing;
    resizing = null;
    readout.style.display = "none";
    if (z.nextW !== null) await shell.edit({ type: "prop", name: "w", value: z.nextW }, `${z.label}: width → ${z.nextW}px`);
    if (z.nextH !== null) await shell.edit({ type: "prop", name: "h", value: z.nextH }, `${z.label}: height → ${z.nextH}px`);
    // The px preview stays until hot reload re-renders from source. Clear it
    // only if it is still ours: React won't re-apply a style it thinks is set.
    setTimeout(() => {
      if (z.nextW !== null && z.el.style.width === `${z.nextW}px`) z.el.style.width = z.prevW;
      if (z.nextH !== null && z.el.style.height === `${z.nextH}px`) z.el.style.height = z.prevH;
    }, 400);
  }, true);

  // ---------- drag to reorder ----------
  //
  // Siblings in the source are the only drop targets by default; holding
  // ⌘/Ctrl allows any movable element in the same file. Pointer events, not
  // mouse events: swallow() cancels pointerdown so the app ignores the press,
  // and that suppresses the compatibility mouse events.

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

  function dropTarget(x, y, anyContainer, move) {
    const allowed = new Set(anyContainer ? move.targets : move.siblings);
    for (let el = stamped(document.elementFromPoint(x, y)); el; el = stamped(el.parentElement)) {
      if (!drag.el.contains(el) && allowed.has(el.dataset.ve)) return targetAt(el, x, y);
    }
    if (anyContainer) return null;
    // Pointer between siblings, or over a part of one that doesn't carry the
    // stamp (Mantine puts an input's props on the <input>, not its label
    // wrapper): use the nearest sibling inside the same container.
    const container = stamped(drag.el.parentElement);
    const pr = container?.getBoundingClientRect();
    if (!pr || x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) return null;
    let best = null;
    for (const el of move.siblings.flatMap((id) => [...all(id)])) {
      if (drag.el.contains(el) || !container.contains(el)) continue;
      const r = el.getBoundingClientRect();
      const dist = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
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

  document.addEventListener("pointerdown", (e) => {
    if (!designing() || isOurs(e) || editingText || resizing || e.button !== 0) return;
    const el = find(sel);
    if (!el || !el.contains(e.target)) return;
    drag = { el, x: e.clientX, y: e.clientY, active: false, target: null };
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const move = shell.getInfo()?.move;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
      if (!move?.movable) {
        shell.status(`Can't move this: ${move?.reason ?? "still loading"}`, true);
        drag = null;
        return;
      }
      drag.active = true;
      drag.prevOpacity = drag.el.style.opacity;
      drag.el.style.opacity = "0.4";
      document.documentElement.style.cursor = "grabbing";
    }
    const t = dropTarget(e.clientX, e.clientY, e.metaKey || e.ctrlKey, move);
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
    readout.textContent = `${t.position} ${labelOf(t.el)}`;
    Object.assign(readout.style, { display: "block", left: `${e.clientX + 14}px`, top: `${e.clientY + 14}px` });
  }, true);

  window.addEventListener("pointerup", async () => {
    if (!drag) return;
    const d = endDrag();
    if (!d.active) return;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 300);
    if (!d.target) {
      shell.status("Not over a valid drop spot; nothing moved");
      return;
    }
    const { el, position } = d.target;
    await shell.edit(
      { type: "move", targetId: el.dataset.ve, position },
      `${labelOf(d.el)}: moved ${position} ${labelOf(el)}`,
    );
  }, true);

  // ---------- frame loop ----------

  let lastRoute = "";
  function frame() {
    const lh = layerHover ? find(layerHover) : null;
    place(hoverBox, mode === "design" && !resizing && !drag?.active ? lh ?? hovered : null);
    const el = find(sel);
    place(selBox, el);
    if (el) {
      const r = el.getBoundingClientRect();
      const n = all(sel.id).length;
      tag.textContent = `${el.dataset.veN}  ${Math.round(r.width)} × ${Math.round(r.height)}` +
        (n > 1 ? `  ×${n}` : "");
    }
    const route = location.pathname + location.search;
    if (route !== lastRoute) {
      lastRoute = route;
      shell.routeChanged(route);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  let domTimer = null;
  new MutationObserver(() => {
    clearTimeout(domTimer);
    domTimer = setTimeout(() => shell.domChanged(), 300);
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- API for the shell ----------

  const api = {
    setMode(m) {
      mode = m;
      hovered = null;
      document.documentElement.style.cursor = "";
    },
    setSelection(s) {
      sel = s;
      const el = find(s);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: "center" });
      }
    },
    setLayerHover(s) { layerHover = s; },
    /** Label for a selection, e.g. Button “Sign In”. */
    describe(s) {
      const el = find(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { label: labelOf(el), name: el.dataset.veN, count: all(s.id).length, width: r.width, height: r.height };
    },
    parentOf(s) {
      const el = find(s);
      const p = stamped(el?.parentElement);
      return p ? ref(p) : null;
    },
    countByName(name) {
      return document.querySelectorAll(`[data-ve-n="${CSS.escape(name)}"]`).length;
    },
    /** Nested layer tree of every stamped element, in document order. */
    tree() {
      const roots = [];
      const nodes = new Map();
      const counts = new Map();
      for (const el of document.querySelectorAll("[data-ve]")) {
        const id = el.dataset.ve;
        const index = counts.get(id) ?? 0;
        counts.set(id, index + 1);
        const node = { id, index, name: el.dataset.veN, label: labelOf(el), children: [] };
        nodes.set(el, node);
        const parent = stamped(el.parentElement);
        (parent && nodes.has(parent) ? nodes.get(parent).children : roots).push(node);
      }
      return roots;
    },
    /** A Mantine CSS variable's value, for drawing swatches in the shell. */
    cssVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    },
  };
  window.__veCanvas = api;
  shell.canvasReady(api);
}
