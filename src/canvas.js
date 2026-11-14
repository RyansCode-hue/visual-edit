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
.mbox, .pbox { border-style: solid; z-index: 2147483645; }
.mbox { border-color: rgba(246, 178, 107, .4); }
.pbox { border-color: rgba(147, 196, 125, .45); }
.target { outline: 1px dashed #ef4444; }
.mline { position: fixed; background: #ef4444; pointer-events: none; z-index: 2147483647; display: none; }
.mlabel { position: fixed; background: #ef4444; color: #fff; padding: 0 4px; border-radius: 3px;
  font-size: 10px; pointer-events: none; z-index: 2147483647; display: none; white-space: nowrap; }
.pin { position: fixed; z-index: 2147483646; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 9px 9px 9px 2px; background: #f59e0b; color: #fff; font-size: 10px; font-weight: 600;
  text-align: center; line-height: 18px; cursor: pointer; box-shadow: 0 1px 3px #0005; }
`;

  const host = document.createElement("div");
  host.id = "visual-edit-canvas";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${STYLES}</style>
<div class="box hover"></div>
<div class="box sel"><div class="tag"></div>
  <div class="h e" data-dir="e"></div><div class="h s" data-dir="s"></div><div class="h se" data-dir="se"></div></div>
<div class="readout"></div>
<div class="drop"></div>
<div class="box mbox"></div><div class="box pbox"></div><div class="box target"></div>
${'<div class="mline"></div><div class="mlabel"></div>'.repeat(4)}
<div class="pins"></div>`;
  document.body.appendChild(host);

  const $ = (s) => shadow.querySelector(s);
  const hoverBox = $(".hover");
  const selBox = $(".sel");
  const tag = $(".tag");
  const readout = $(".readout");
  const dropLine = $(".drop");
  const mbox = $(".mbox");
  const pbox = $(".pbox");
  const targetBox = $(".target");
  const mlines = [...shadow.querySelectorAll(".mline")];
  const mlabels = [...shadow.querySelectorAll(".mlabel")];
  const pinsEl = $(".pins");

  let mode = "design";      // "design" | "interact"
  let spaceHeld = false;    // hold Space in design mode to use the app
  let hovered = null;       // Element under the pointer
  let layerHover = null;    // { id, index } highlighted from the layers panel
  let sel = null;           // { id, index }
  let resizing = null;
  let editingText = null;   // { el, original }
  let drag = null;          // { el, x, y, active, target }
  let justDragged = false;  // swallow the click that ends a drag
  let altHeld = false;      // ⌥: measure distances from the selection
  let nudging = null;       // arrow-key nudge being previewed
  let pins = [];            // questions for developers: { n, id, text }

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

  // Figma-style selection: a click selects the group (nearest layout
  // container), clicks inside the current selection's parent select at that
  // level, double-click goes one level in, ⌘-click selects the deepest.
  const GROUPS = new Set([
    "Card", "Paper", "Stack", "Group", "SimpleGrid", "Grid", "Grid.Col", "Flex", "Container", "Table",
    "Alert", "Center", "Box", "Fieldset", "Modal", "Drawer", "Tabs", "Tabs.Panel", "Accordion",
    "Accordion.Item", "AppShell.Navbar", "AppShell.Header", "AppShell.Main", "AppShell.Section",
    "AppShell.Aside", "AppShell.Footer",
  ]);
  const parentOf = (el) => stamped(el?.parentElement);
  function childOnPath(container, deep) {
    let cur = deep;
    let prev = null;
    while (cur && cur !== container) { prev = cur; cur = parentOf(cur); }
    return cur === container ? prev : null;
  }
  function groupOf(el) {
    for (let a = el; a; a = parentOf(a)) if (GROUPS.has(a.dataset.veN)) return a;
    return el;
  }
  const stampedChildren = (p) => [...p.querySelectorAll("[data-ve]")].filter((c) => parentOf(c) === p);

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
  // swallow() cancels the press, which also stops the frame taking focus;
  // take it explicitly so keyboard shortcuts reach the canvas.
  document.addEventListener("pointerdown", (e) => {
    if (designing() && !isOurs(e) && !editingText) window.focus();
  }, true);

  document.addEventListener("mousemove", (e) => {
    hovered = designing() && !resizing && !isOurs(e) ? stamped(e.target) : null;
  }, true);
  document.addEventListener("mouseleave", () => { hovered = null; });

  document.addEventListener("click", (e) => {
    if (!swallow(e)) return;
    if (justDragged) { justDragged = false; return; }
    const target = e.target.closest?.(".pin") ? null : stamped(e.target);
    if (!target) return;
    if (e.metaKey || e.ctrlKey) { shell.pick(ref(target)); return; }
    const S = find(sel);
    if (S && S.contains(target)) return; // stays selected; double-click goes in
    const P = parentOf(S);
    const sibling = P && P.contains(target) ? childOnPath(P, target) : null;
    shell.pick(ref(sibling ?? groupOf(target)));
  }, true);

  document.addEventListener("dblclick", (e) => {
    if (!swallow(e)) return;
    const el = find(sel);
    const target = stamped(e.target);
    if (!el || !target || !el.contains(target)) { if (target) shell.pick(ref(target)); return; }
    if (target !== el) {
      const inner = childOnPath(el, target);
      if (inner) shell.pick(ref(inner));
      return;
    }
    const info = shell.getInfo();
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
    const a = document.activeElement;
    const typing = a?.isContentEditable || /^(TEXTAREA|SELECT)$/.test(a?.tagName ?? "") ||
      (a?.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(a.type));
    if (mode === "design" && e.code === "Space" && !typing) {
      e.preventDefault();
      if (!spaceHeld) { spaceHeld = true; hovered = null; shell.spaceHeld(true); }
      return;
    }
    if (!designing()) return;
    if (e.key === "Alt") { altHeld = true; return; }
    if (typing) return;
    const S = find(sel);
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape" && shell.helpOpen()) {
      e.preventDefault();
      shell.help(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (drag?.active) { endDrag(); justDragged = true; shell.status("Move cancelled"); }
      else shell.selectParent();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) shell.redo(); else shell.undo();
    } else if (e.key === "?") {
      e.preventDefault();
      shell.help();
    } else if (e.key === "Enter" && S) {
      e.preventDefault();
      if (e.shiftKey) shell.selectParent();
      else {
        const first = stampedChildren(S)[0];
        if (first) shell.pick(ref(first)); else shell.status("Nothing inside this layer");
      }
    } else if (e.key === "Tab" && S) {
      e.preventDefault();
      const P = parentOf(S);
      const kids = P ? stampedChildren(P) : [];
      const i = kids.indexOf(S);
      if (kids.length > 1) shell.pick(ref(kids[(i + (e.shiftKey ? -1 : 1) + kids.length) % kids.length]));
    } else if (e.key.startsWith("Arrow") && S && !mod) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudge({ ArrowLeft: -step, ArrowRight: step }[e.key] ?? 0, { ArrowUp: -step, ArrowDown: step }[e.key] ?? 0);
    }
  }, true);

  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && spaceHeld) { spaceHeld = false; shell.spaceHeld(false); }
    if (e.key === "Alt") altHeld = false;
  }, true);
  window.addEventListener("blur", () => {
    altHeld = false;
    if (spaceHeld) { spaceHeld = false; shell.spaceHeld(false); }
  });

  // ---------- arrow-key nudge ----------
  //
  // Arrows move the selection by adjusting its top/left margin: 1px, or 10px
  // with Shift. Presses are previewed inline and written once they pause.

  function nudge(dx, dy) {
    const el = find(sel);
    if (!el) return;
    if (!shell.getInfo()?.mantine) {
      shell.status("Nudging needs a Mantine component", true);
      return;
    }
    if (nudging && nudging.el !== el) commitNudge();
    if (!nudging) {
      const cs = getComputedStyle(el);
      nudging = {
        el, dx: 0, dy: 0, label: labelOf(el),
        baseLeft: Math.round(parseFloat(cs.marginLeft) || 0), baseTop: Math.round(parseFloat(cs.marginTop) || 0),
        prevML: el.style.marginLeft, prevMT: el.style.marginTop,
      };
    }
    const n = nudging;
    n.dx += dx;
    n.dy += dy;
    if (n.dx) el.style.marginLeft = `${n.baseLeft + n.dx}px`;
    if (n.dy) el.style.marginTop = `${n.baseTop + n.dy}px`;
    const r = el.getBoundingClientRect();
    readout.textContent = [n.dy ? `margin top ${n.baseTop + n.dy}px` : "", n.dx ? `margin left ${n.baseLeft + n.dx}px` : ""]
      .filter(Boolean).join(" · ");
    Object.assign(readout.style, { display: "block", left: `${r.left}px`, top: `${r.bottom + 6}px` });
    clearTimeout(n.timer);
    n.timer = setTimeout(commitNudge, 700);
  }

  async function commitNudge() {
    const n = nudging;
    nudging = null;
    if (!n) return;
    clearTimeout(n.timer);
    readout.style.display = "none";
    if (!n.dx && !n.dy) return;
    const left = `${n.baseLeft + n.dx}px`;
    const top = `${n.baseTop + n.dy}px`;
    await shell.nudge({ dx: n.dx, dy: n.dy, baseLeft: n.baseLeft, baseTop: n.baseTop, label: n.label });
    setTimeout(() => {
      if (n.el.style.marginLeft === left) n.el.style.marginLeft = n.prevML;
      if (n.el.style.marginTop === top) n.el.style.marginTop = n.prevMT;
    }, 400);
  }

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

  // ---------- measurement + box model overlays ----------

  function boxModel(el) {
    if (!el) { mbox.style.display = pbox.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = (v) => Math.max(0, parseFloat(v) || 0);
    const m = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(px);
    const p = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px);
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
    if (m.some(Boolean)) {
      Object.assign(mbox.style, {
        display: "block", left: `${r.left - m[3]}px`, top: `${r.top - m[0]}px`,
        width: `${r.width + m[1] + m[3]}px`, height: `${r.height + m[0] + m[2]}px`,
        borderWidth: m.map((v) => `${v}px`).join(" "),
      });
    } else mbox.style.display = "none";
    if (p.some(Boolean)) {
      Object.assign(pbox.style, {
        display: "block", left: `${r.left + bw[3]}px`, top: `${r.top + bw[0]}px`,
        width: `${r.width - bw[1] - bw[3]}px`, height: `${r.height - bw[0] - bw[2]}px`,
        borderWidth: p.map((v) => `${v}px`).join(" "),
      });
    } else pbox.style.display = "none";
  }

  function measure(a, b, inside) {
    const segs = [];
    if (inside) {
      const cy = a.top + a.height / 2;
      const cx = a.left + a.width / 2;
      segs.push([b.left, cy, a.left, cy], [a.right, cy, b.right, cy], [cx, b.top, cx, a.top], [cx, a.bottom, cx, b.bottom]);
    } else {
      const top = Math.max(a.top, b.top);
      const bottom = Math.min(a.bottom, b.bottom);
      const y = top < bottom ? (top + bottom) / 2 : a.top + a.height / 2;
      const left = Math.max(a.left, b.left);
      const right = Math.min(a.right, b.right);
      const x = left < right ? (left + right) / 2 : a.left + a.width / 2;
      if (b.left >= a.right) segs.push([a.right, y, b.left, y]);
      else if (a.left >= b.right) segs.push([b.right, y, a.left, y]);
      if (b.top >= a.bottom) segs.push([x, a.bottom, x, b.top]);
      else if (a.top >= b.bottom) segs.push([x, b.bottom, x, a.top]);
    }
    mlines.forEach((line, i) => {
      const sg = segs[i];
      const len = sg ? Math.round(Math.hypot(sg[2] - sg[0], sg[3] - sg[1])) : 0;
      if (!sg || len < 1) { line.style.display = mlabels[i].style.display = "none"; return; }
      const [x1, y1, x2, y2] = sg;
      const horizontal = y1 === y2;
      Object.assign(line.style, horizontal
        ? { display: "block", left: `${Math.min(x1, x2)}px`, top: `${y1}px`, width: `${Math.abs(x2 - x1)}px`, height: "1px" }
        : { display: "block", left: `${x1}px`, top: `${Math.min(y1, y2)}px`, width: "1px", height: `${Math.abs(y2 - y1)}px` });
      mlabels[i].textContent = `${len}`;
      Object.assign(mlabels[i].style, { display: "block", left: `${(x1 + x2) / 2 + 3}px`, top: `${(y1 + y2) / 2 - 7}px` });
    });
  }
  const clearMeasure = () => {
    mlines.forEach((l, i) => { l.style.display = mlabels[i].style.display = "none"; });
    targetBox.style.display = "none";
  };

  function placePins() {
    const live = pins.map((p) => ({ p, el: find({ id: p.id, index: 0 }) })).filter((x) => x.el);
    pinsEl.replaceChildren(...live.map(({ p, el }) => {
      const r = el.getBoundingClientRect();
      const d = document.createElement("div");
      d.className = "pin";
      d.textContent = String(p.n);
      d.title = p.text;
      Object.assign(d.style, { left: `${r.right - 6}px`, top: `${r.top - 12}px` });
      d.addEventListener("click", (e) => { e.stopPropagation(); shell.pick(ref(el)); });
      return d;
    }));
  }

  let lastRoute = "";
  let pinTick = 0;
  function frame() {
    const lh = layerHover ? find(layerHover) : null;
    const showHover = mode === "design" && !resizing && !drag?.active;
    place(hoverBox, showHover ? lh ?? hovered : null);
    boxModel(showHover && !altHeld ? lh ?? hovered : null);
    const S = find(sel);
    if (altHeld && S && designing()) {
      const other = hovered && hovered !== S && !S.contains(hovered) ? hovered : parentOf(S);
      if (other) {
        measure(S.getBoundingClientRect(), other.getBoundingClientRect(), other.contains(S));
        place(targetBox, other);
      } else clearMeasure();
    } else clearMeasure();
    if (++pinTick % 10 === 0) placePins();
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

  // ---------- accessibility + overflow checks ----------

  function parseColor(c) {
    let m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    }
    m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c);
    if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] === undefined ? 1 : Number(m[4]) };
    return null;
  }
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  function backgroundOf(el) {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // images/gradients: can't tell
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    return layers.reverse().reduce((bg, c) => blend(c, bg), { r: 255, g: 255, b: 255, a: 1 });
  }
  const luminance = ({ r, g, b }) => {
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratioOf = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.opacity !== "0" && cs.display !== "none";
  };
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const INTERACTIVE = "button, a[href], input:not([type=hidden]), select, textarea, [role=button]";

  function textChecks(el) {
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const fg = parseColor(cs.color);
    const bg = backgroundOf(el);
    const ratio = fg && bg ? Math.round(ratioOf(blend(fg, bg), bg) * 100) / 100 : null;
    return { size, large, ratio, required: large ? 3 : 4.5 };
  }

  function checksFor(el) {
    const textEl = hasOwnText(el) ? el
      : el.querySelectorAll("[data-ve]").length <= 3
        ? [...el.querySelectorAll("*")].find((n) => hasOwnText(n) && visible(n)) : null;
    const out = { text: textEl ? textChecks(textEl) : null, target: null };
    const interactive = el.matches(INTERACTIVE) ? el : el.querySelector(INTERACTIVE);
    if (interactive && el.querySelectorAll("[data-ve]").length <= 3) {
      const r = interactive.getBoundingClientRect();
      out.target = { width: Math.round(r.width), height: Math.round(r.height) };
    }
    return out;
  }

  function pageChecks() {
    const issues = [];
    const seen = new Set();
    const push = (el, kind, message) => {
      const owner = el.hasAttribute?.("data-ve") ? el : stamped(el);
      if (!owner || host.contains(owner)) return;
      const r = ref(owner);
      const k = `${kind}|${r.id}|${r.index}`;
      if (seen.has(k)) return;
      seen.add(k);
      issues.push({ kind, ref: r, label: labelOf(owner), message });
    };
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) {
      const over = [...document.querySelectorAll("[data-ve]")]
        .filter((el) => !host.contains(el) && visible(el) && el.getBoundingClientRect().right > vw + 1);
      // Report the cause: the outermost element whose own box sticks out while
      // its parent's doesn't, not every descendant carried along with it.
      const causes = over.filter((el) => !over.includes(parentOf(el)));
      for (const el of causes.slice(0, 25)) {
        push(el, "overflow", `Sticks out ${Math.round(el.getBoundingClientRect().right - vw)}px past the ${vw}px screen`);
      }
    }
    let n = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (++n > 3000) break;
      if (host.contains(el) || !hasOwnText(el) || !visible(el)) continue;
      const t = textChecks(el);
      if (t.ratio !== null && t.ratio < t.required) {
        push(el, "contrast", `Contrast ${t.ratio}:1, needs ${t.required}:1 (WCAG AA)`);
      }
      if (t.size < 12) push(el, "small-text", `Text is ${Math.round(t.size * 10) / 10}px; keep body text at 12px or more`);
    }
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (host.contains(el) || !visible(el)) continue;
      if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue; // links in sentences are exempt
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) {
        push(el, "target", `Click target is ${Math.round(r.width)}×${Math.round(r.height)}px; aim for at least 24×24`);
      }
    }
    return issues;
  }

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
    /** Live theme preview: override Mantine CSS variables until cleared. */
    setPreviewVars(vars) {
      let style = document.getElementById("ve-preview");
      const entries = Object.entries(vars ?? {});
      if (!entries.length) { style?.remove(); return; }
      if (!style) {
        style = document.createElement("style");
        style.id = "ve-preview";
        document.head.append(style);
      }
      style.textContent = `html:root, html:root[data-mantine-color-scheme] { ${entries.map(([k, v]) => `${k}: ${v} !important;`).join(" ")} }`;
    },
    setPins(list) { pins = list ?? []; placePins(); },
    viewportWidth: () => document.documentElement.clientWidth,
    /** Accessibility + overflow issues on the current page. */
    checks: () => pageChecks(),
    /** Contrast, text size and target size for one selection. */
    elementChecks(s) {
      const el = find(s);
      return el ? checksFor(el) : null;
    },
  };
  window.__veCanvas = api;
  shell.canvasReady(api);
}
