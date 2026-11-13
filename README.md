# visual-edit (PoC spike)

Edit a running React + Mantine app in the browser; edits are written back to
the JSX source as minimal diffs. Target: `atticus-backoffice` (Attune).

## Run

```bash
cd src/web-app && npm install          # in the target app, once
VITE_API_PROXY_URL=http://localhost:8080 node bin/run.js <path>/src/web-app
```

Starts the app's own Vite config with the plugin added (default port 5390,
next free if taken). The target repo is never modified except by edits you make.
Click **✎ Edit** bottom-left.

## What works

- Click any element → panel shows component, `file:line`, parent breadcrumb,
  props from source, text. Repeated (`.map`) elements show `×N`.
- Edit/add/remove props (`c`, `mb`, `w`, `fz`, …) with token suggestions.
- Edit literal text in the panel or by double-clicking in place.
- Resize via bottom/right handles with live `W × H px` readout (Shift snaps
  to 8) → writes `w`/`h`.
- Reorder: drag a selected element; a drop line shows where it lands. Siblings
  only by default; hold ⌘/Ctrl to drop into another container (same file).
  Also ↑/↓ buttons in the panel. Conditionals (`{x && <A/>}`) move with their
  condition; elements are re-indented to their new depth. Elements from
  `.map` callbacks or a component's root can't be moved (panel says why).
- Scope: for Mantine components the panel has **This element / All <Button>**.
  "All" edits `components.<Name>.defaultProps` in the theme; props this element
  sets itself are starred (they won't follow the default).
- **◐ Theme** panel: colour ramps as swatches (edits land in the ramp's const),
  primary colour/shade, fonts, spacing (px, written as `rem()`), radius,
  component defaults. Aliases and computed values are read-only.
  Theme file = the one file calling `createTheme()`. Editing it reloads the
  page; editor state is kept in sessionStorage.
- Undo (server-side stack, refuses if file changed since). Covers theme edits.
- Computed props / text from variables are shown read-only, never rewritten.

## How

- `src/source.js`: Babel parse + MagicString. Stamps `data-ve="file:line:col"`
  in the dev transform only; reads and edits one element by location.
- `src/plugin.js`: Vite plugin (serve only): transform, overlay injection,
  `/__ve/inspect|edit|undo`. Writes limited to `.jsx/.tsx` under app root,
  JSON + same-origin POSTs only.
- `src/overlay.js`: vanilla DOM in a shadow root.
- `npm test`: source-edit unit tests.

## Known gaps

- Moving between files/components not supported.
- JSX comments directly above a moved element stay behind.
- No "apply to this page/section only" scope (would need a shared wrapper or
  CSS module); scopes are element, component-wide, theme.
- Compound components (`Card.Section`) and in-house components have no
  component-wide scope.
- `test/fixture-main.tsx.txt` is a snapshot of attune's `main.tsx`.
- Panel can cover the right-edge resize handle.
- No formatter pass after writes (repo targets ~80 cols).
- Plain HTML elements: text only, no style props/resize.
- Editing an element shifts the `col` of later elements on the same line
  until reload.
