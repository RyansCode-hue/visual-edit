# visual-edit (PoC)

A Figma-style editor for a running React + Mantine app. A designer selects and
changes things on the real page; every change is written back to the source as
a small, readable diff and can be sent to a developer as a git branch.
Target: `atticus-backoffice` (Attune).

## Run

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
- **Design mode:** click to select, Esc selects the parent, drag to reorder
  (⌘ to move into another container), double-click text to edit it, resize
  from the handles (live px readout, Shift snaps to 8). Hold **Space** to use
  the app without leaving Design mode; **Interact** turns editing off.
- **Inspector** speaks design, not props:
  Layout (Width/Height as Auto · Fill · Fixed px), Auto layout (gap, align,
  justify for Stack/Group), Spacing (margin/padding box), Text (size, weight,
  colour, align), Appearance (style, accent colour, component size, corner
  radius, shadow, border, background). Raw props are under *More properties*,
  file and line under *Developer info*.
- **Design-system first:** spacing, radius and font sizes are token dropdowns
  showing px (`md · 13px`); colours come from a swatch picker of the theme
  ramps. Custom values are allowed but flagged ("Custom 14px · not in the
  design system", or "14px equals md · Use md").
- **Scope:** *This element* vs *All Buttons* (writes the theme's
  `components.Button.defaultProps`; values this element sets itself are
  starred). **Theme** tab: colour ramps, primary colour/shade, fonts, spacing
  scale, component defaults.
- **Locked, with the reason in plain words:** text filled in by the app, items
  in a data-driven list, a component's outer frame, values computed in code.
- **Changes** tab: every change in plain language ("Button “Sign In”: Corner
  radius default → xl"), each individually revertable; ⌘Z reverts the latest.
  **Show original** serves the pre-session version of every touched file (disk
  untouched) for before/after. **Send for review** commits the session to
  `design/<title>-<date>` with the change list as the message; it warns when a
  touched file already had other uncommitted edits, since whole files are
  committed.

## How

- `src/source.js`: Babel parse + MagicString. Stamps `data-ve="file:line:col"`
  at load time (before other plugins reprint the code), reads one element,
  edits props/text, moves elements.
- `src/theme.js`: reads/writes the `createTheme({...})` object.
- `src/changes.js`: change regions and revert-any-change.
- `src/plugin.js`: Vite plugin (serve only) + `/__ve/` API. Writes limited to
  `.js(x)/.ts(x)` under the app root; POSTs must be JSON from the same origin.
- `src/canvas.js`: runs inside the app iframe (selection, drag, resize, text,
  layer tree). `src/shell/`: the editor page.
- `npm test`: unit tests for source, move, theme and change logic.

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
- `test/fixture-main.tsx.txt` is a snapshot of Attune's `main.tsx`.
