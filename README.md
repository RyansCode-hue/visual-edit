# visual-edit (PoC)

A Figma-style editor for a running React + Mantine app. A designer selects and
changes things on the real page; every change is written back to the source as
a small, readable diff and can be sent to a developer as a git branch.
Target: `atticus-backoffice` (Attune).

## Run

Needs Node 20+.

```bash
cd <app>/src/web-app && npm install        # in the target app, once
VITE_API_PROXY_URL=http://localhost:8080 \
VE_DEMO_USER=admin VE_DEMO_PASSWORD='…' VE_DEMO_START=/dashboard \
  node bin/run.js <app>/src/web-app
```

Open the **Editor** URL it prints (`http://localhost:5390/__ve/`; next free
port if taken). The app's own Vite config is used as-is with the plugin added.

| Env var | Purpose |
|---|---|
| `VE_DEMO_USER` / `VE_DEMO_PASSWORD` | MFA-exempt local login behind **Sign in as …** (server-side; the password never reaches the browser). Locally: the seeded test user. |
| `VE_DEMO_START` | Page to open after that login (Attune: `/dashboard`). |
| `VE_ALLOW_PUSH=1` | **Send for review** also pushes the branch and opens a PR with `gh`. Off by default. |

## The editor

- **Layout:** layers (left) · the app in an iframe (middle) · inspector (right).
  Toolbar: Design / Interact mode, page path, viewport widths, demo sign-in,
  Show original, Send for review.
- **Selecting (Figma rules):** click selects the outermost group under the
  pointer; click again inside it to reach siblings; double-click goes one
  level in (or edits text on a leaf); ⌘-click selects the deepest layer.
  Esc / ⇧Enter → parent, Enter → first child, Tab / ⇧Tab → siblings.
- **Editing on the canvas:** drag to reorder (⌘ to move into another
  container), resize from the handles (live px readout, Shift snaps to 8),
  arrow keys nudge 1px (Shift 10px; previewed live, written after a pause and
  snapped to a spacing token when the value matches one). Margin and padding
  are shaded on the selection. Hold **Alt** to measure the distance to the
  hovered layer. Hold **Space** to use the app without leaving Design mode;
  **Interact** turns editing off. Press **?** for every shortcut.
- **Inspector** speaks design, not props:
  Layout (Width/Height as Auto · Fill · Fixed px; warns when a fixed width
  won't fit a 390px phone), Auto layout (gap, align, justify for
  Stack/Group), Spacing (margin/padding box), Text (size, weight, colour,
  align), Appearance (style, accent colour, component size, corner radius,
  shadow, border, background), Accessibility (contrast ratio, text size,
  click-target size for the selection). Raw props are under *More
  properties*, file and line under *Developer info*.
- **Design-system first:** spacing, radius and font sizes are token dropdowns
  showing px (`md · 13px`); colours come from a swatch picker of the theme
  ramps. Custom values are allowed but flagged ("Custom 14px · not in the
  design system", or "14px equals md · Use md").
- **Scope:** *This element* vs *All Buttons* (writes the theme's
  `components.Button.defaultProps`; values this element sets itself are
  starred). **Theme** tab: colour ramps, primary colour/shade, fonts, spacing
  scale, component defaults.
- **Preview before applying:** theme and component-wide edits are held as
  pending, shown live on the page where a Mantine CSS variable carries them
  (colours, primary colour, spacing, radius, fonts, heading weight), with how
  far they reach ("used in 111 places across 32 files"). **Apply** writes
  them; **Discard** drops them. Component defaults have no live preview.
- **Checks** tab (count in the tab): overflow on the current viewport
  (reports the element causing it, not everything inside), WCAG AA contrast
  (4.5:1, 3:1 for large text), text under 12px, click targets under 24×24.
  Click an issue to select its element.
- **Test data:** the *Data* menu shows the page with live data, empty lists,
  loading forever, a server error, long text, or 25+ rows. Only GET `/api/`
  requests inside the editor are reshaped; sign-in, `/api/me` and the
  user's own `/api/my*` data stay real so access checks pass.
- **Ask a developer:** attaches a question to an element, shown as a
  numbered pin on the page; questions go into the review commit message with
  the file:line and page.
- **Figma tokens:** pick a Figma token export (W3C, Tokens Studio, Figma
  variables, or a flat list) on the Theme tab to list colour, spacing, radius
  and font-size values that differ from the code, with a *Use Figma* button.
- **Locked, with the reason in plain words:** text filled in by the app, items
  in a data-driven list, a component's outer frame, values computed in code.
- **Changes** tab: every change in plain language ("Button “Sign In”: Corner
  radius default → xl"), each individually revertable; ⌘Z reverts the latest,
  ⇧⌘Z redoes. **Show original** serves the pre-session version of every
  touched file (disk untouched) for before/after. **Send for review** commits
  the session to `design/<title>-<date>` with the change list and questions as
  the message; it warns when a touched file already had other uncommitted
  edits, since whole files are committed.

## How

- `src/source.js`: Babel parse + MagicString. Stamps `data-ve="file:line:col"`
  at load time (before other plugins reprint the code), reads one element,
  edits props/text, moves elements.
- `src/theme.js`: reads/writes the `createTheme({...})` object.
- `src/changes.js`: change regions and revert-any-change.
- `src/usage.js`: textual count of where a token/component is used (reach).
- `src/data.js`: fetch wrapper for the test-data states (classic script,
  first in `<head>`, active only inside the editor iframe).
- `src/shell/tokens.js`: Figma token export parsing and comparison.
- `src/plugin.js`: Vite plugin (serve only) + `/__ve/` API. Writes limited to
  `.js(x)/.ts(x)` under the app root; POSTs must be JSON from the same origin.
- `src/canvas.js`: runs inside the app iframe (selection, drag, resize, text,
  layer tree). `src/shell/`: the editor page.
- `npm test`: unit tests for source, move, theme, change, usage, test-data
  and token logic.

## Known gaps

- Change log lives in server memory; restarting the editor forgets it (files
  keep their edits).
- Moving between files/components isn't supported; JSX comments directly above
  a moved element stay behind.
- Mantine inputs (`TextInput` etc.) carry the stamp on the `<input>`, so the
  selection outline excludes their label.
- No "this page/section only" scope; compound (`Card.Section`) and in-house
  components have no component-wide scope.
- No formatter pass after writes (repo targets ~80 cols).
- No screenshots in the review; reviewers use Show original.
- Reach counts are regex over source, not a type-checked reference search.
- Test-data states reshape JSON generically; endpoints the app needs to
  render at all (beyond session and `/api/my*`) may need adding to the
  exemptions in `src/data.js`.
- Questions live in server memory with the change log.
- `test/fixture-main.tsx.txt` is a snapshot of Attune's `main.tsx`.
