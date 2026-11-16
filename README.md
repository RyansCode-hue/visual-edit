# visual-edit (PoC)

A Figma-style editor for running web apps, as a standalone local app with two
modes:

- **Repo mode** (point it at an app folder): edits a React + Mantine app's
  source. Every change is a small, readable diff, and the session can go to a
  developer as a git branch. Target: `atticus-backoffice` (Attune).
- **URL mode** (point it at a URL): edits any running site, UAT included,
  without its code. Changes are kept as style and text overrides on a local
  copy of the site. They go to a developer as a **handoff**: a prompt for
  their Claude plus before/after screenshots.

Either way, anyone's own Claude Code can connect over **MCP** to see what is
selected, take screenshots, make edits through the editor, and pull the
handoff.

## Run

Needs Node 20+. `npm install` here once; `npm link` puts `visual-edit` on
your PATH.

```bash
# Repo mode: the app's own Vite (and vite.config) runs inside the editor
cd <app>/src/web-app && npm install        # in the target app, once
VITE_API_PROXY_URL=http://localhost:8080 \
VE_DEMO_USER=admin VE_DEMO_PASSWORD='…' VE_DEMO_START=/dashboard \
  visual-edit open <app>/src/web-app

# URL mode: any site, through a local proxy
visual-edit open https://uat.example.com
```

It opens the editor in your browser (`http://localhost:5390/__ve/`, or the
next free port; `--port N` to choose, `--no-open` not to open it). The
server only listens on 127.0.0.1. `node bin/run.js <folder> [port]` still
works.

| Env var | Purpose |
|---|---|
| `VE_DEMO_USER` / `VE_DEMO_PASSWORD` | MFA-exempt local login behind **Sign in as …** (server-side; the password never reaches the browser). Locally: the seeded test user. |
| `VE_DEMO_START` | Page to open after that login (Attune: `/dashboard`). |
| `VE_ALLOW_PUSH=1` | **Send for review** also pushes the branch and opens a PR with `gh`. Off by default. |
| `VE_CLAUDE=0` | Turns off **Ask Claude** (on whenever the `claude` command is installed). |
| `VE_CLAUDE_MODEL` / `VE_CLAUDE_BIN` | Model and command for **Ask Claude** (defaults: your Claude Code default, `claude`). |

## MCP: use the editor from your own Claude

The editor serves an MCP endpoint, and prints the command to add it at start:

```bash
claude mcp add --transport http visual-edit http://localhost:5390/__ve/mcp --header "Authorization: Bearer $(cat ~/.visual-edit/token)"
```

The token is created on first run in `~/.visual-edit/token` (mode 0600). The
endpoint also refuses any host other than localhost (DNS rebinding) and any
non-local browser origin. With the editor open in a browser:

| Tool | What it does |
|---|---|
| `get_status` | Mode, what's being edited, whether the editor is open, page, selection, number of changes. |
| `get_selection` | The selected element. Repo mode: component, file:line, props, text, and every page that renders it. URL mode: computed styles, text, DOM path. |
| `get_page_elements` | The page's layer tree (ids to pass to `select` / `edit_element`). |
| `list_pages` | The app's routes (repo mode). |
| `get_changes` | The change list with a diff per change (repo) or before → after values (URL). |
| `get_handoff` | The session as a prompt for implementing or reviewing it, plus a screenshot. |
| `screenshot` | The visible page or the selected element, as the user sees it. |
| `navigate`, `select` | Drive the editor; the user sees it happen. |
| `edit_element` | Repo: a JSX prop or text. URL: a CSS property or text. Logged and revertible. |
| `get_theme` | Theme values: the theme file (repo) or the page's CSS variables (URL). |
| `set_theme_value` | One theme value for every page, by Mantine key (`["spacing","md"]`, `["primaryColor"]`). Repo mode writes the theme file; URL mode sets the variables. |
| `revert_change` | Revert one change, or the newest. |

In repo mode, files that your Claude edits directly with its own tools also
show in the change list as "Edited outside the editor", so they can be
reverted like any other change. The same goes for an IDE.

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
- **Shared components:** selecting something inside a component that more
  than one page renders (a layout, a shared card) shows "Shared across N
  pages" with the list, and *Step through them* opens each page in turn
  (Prev/Next bar over the canvas; the selection stays on the shared
  element). Page-only elements say "Only used on this page". The Changes tab
  keeps the same *Step through them* link on every change to a shared
  component, for checking the result afterwards.
- **Ask Claude:** describe a change in words ("make this more compact") for
  the selection, or for the page when nothing is selected. It runs the
  person's own `claude` CLI (`claude -p`, their own Claude subscription;
  Anthropic sales approved this use), shows progress, then Claude's plain-
  language summary. Each changed file lands in the Changes list like any
  other edit; **Undo this** reverts the whole run. Other edits wait while it
  runs; Cancel stops it. Setup per person: install Claude Code and run
  `claude` once to sign in.
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
- **URL mode** inspector: the selection's computed CSS (colour, typography,
  spacing, size, corners) and its text. Edits are overrides on the local
  copy, kept per page and re-applied after reloads and in-app navigation.
  Selection, layers, measuring, nudging, checks, pins and Show original work
  as in repo mode. Not available, with the reason shown: reordering, Ask
  Claude, shared-page detection.
- **URL mode Theme tab:** the site's design tokens, read from the CSS
  variables it defines on `:root`. A change applies to every page. For
  Mantine sites:
  - primary colour;
  - colour ramps (click a shade; the colour's filled and text variables and
    the primary colour follow when they showed that exact colour);
  - fonts and heading weight;
  - text and heading sizes, spacing scale, corner radius and line heights,
    in px;
  - the remaining variables under *Other*.

  Other sites get a plain list of their variables. The handoff gives each
  change with the Mantine theme key it belongs to (`theme.spacing.md`,
  `theme.primaryColor` → `"teal"`), so the developer edits the theme, not
  the variable. **Save handoff** writes
  `~/.visual-edit/handoffs/<title>-<date>/` with `prompt.md`, `before.png`
  and `after.png`; **Copy as a prompt for Claude** (both modes) copies the
  same prompt.
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
- `src/claude.js`: runs `claude -p` fenced in: `dontAsk` permissions with
  Read/Edit/Glob/Grep limited to the app folder (`./**`), no shell, new
  files, web, subagents or MCP servers, project settings only (personal
  settings can grant shell commands and other folders), and a minimal
  environment (an `ANTHROPIC_API_KEY` would override the subscription
  login). What changed is found by comparing the folder before and after,
  not from Claude's own report; git changes outside the app folder are
  flagged.
- `src/pages.js`: route → component graph (react-router object routes or
  `<Route>` JSX, `ROUTES.X` constants, layout nesting) to find the pages
  that render a component.
- `src/usage.js`: textual count of where a token/component is used (reach).
- `src/data.js`: fetch wrapper for the test-data states (classic script,
  first in `<head>`, active only inside the editor iframe).
- `src/shell/tokens.js`: Figma token export parsing and comparison.
- `bin/visual-edit.js`: the CLI. `src/server.js`: one local HTTP server
  (127.0.0.1) for the editor and the app.
- `src/editor.js`: the editor's core. Session state and every operation
  (edit, revert, theme, overrides, review, Ask Claude) as plain functions
  shared by the `/__ve/` JSON API and MCP. Writes limited to `.js(x)/.ts(x)`
  under the app root; POSTs must be JSON from the same origin.
- `src/adapters/vite.js`: repo mode. The app's own Vite in middleware mode,
  plus a plugin that stamps JSX and injects the canvas. `src/plugin.js` is
  the same as a plain Vite plugin, for adding to an app's `vite.config`
  instead.
- `src/adapters/proxy.js`: URL mode. A reverse proxy that injects the
  scripts into HTML, drops CSP and X-Frame-Options, and rewrites cookies
  (no Domain or Secure) and redirects so the site works on localhost. It
  pipes WebSockets through.
- `src/stamp-dom.js`: URL mode, in the page. Gives elements
  `data-ve="dom:<selector path>"` ids, anchored on stable ids or test ids and
  skipping generated ones like `mantine-x1y2z3`, names Mantine roots, and
  applies the overrides.
- `src/mcp.js`: the MCP tools (Streamable HTTP, stateless) and their access
  check. `src/live.js`: SSE channel to the open editor page for commands
  (navigate, select, screenshot, describe) and live change notices.
- `src/watch.js`: logs edits made outside the editor (repo mode).
- `src/handoff.js`: the handoff prompt and per-change diffs.
- `src/mantine-vars.js`: Mantine theme keys ↔ the CSS variables Mantine
  sets on `:root` (URL-mode theme, MCP, handoff).
- `src/canvas.js`: runs inside the app iframe (selection, drag, resize, text,
  layer tree, screenshots via `modern-screenshot`, with cross-origin web fonts
  inlined so text renders as on the page). `src/shell/`: the editor page.
- `npm test`: unit tests for source, move, theme, change, usage, test-data,
  token, proxy, override, theme-variable, handoff, MCP and watcher logic.

## Security

- **Network:** listens on 127.0.0.1 only.
- **MCP:** needs the bearer token from `~/.visual-edit/token`, a localhost
  `Host` and a local (or no) `Origin`. Its writes go through the same path
  checks as the UI.
- **URL mode:** the proxy strips the site's CSP and framing protection, and
  makes its cookies work on `http://localhost`. This only affects the local
  copy. Sign in with test accounts on UAT, not with production credentials;
  the editor and its MCP endpoint can read what the page shows.
- **Overrides:** CSS property names must be plain identifiers and values
  can't contain `;{}<>`, so an override can't inject other rules.
- **Dependencies:** `@babel/parser`, `magic-string`,
  `@modelcontextprotocol/sdk`, `zod` and `modern-screenshot`; `npm audit` is
  clean as of 2026-11-16.

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
- Repo-mode review branches carry no screenshots (the MCP handoff and URL
  mode do).
- Reach counts are regex over source, not a type-checked reference search.
- Shared-page detection follows `<Component />` JSX through relative
  imports only: components rendered by reference (`lazy()`, props holding a
  component), path aliases, and routes needing `:params` aren't followed or
  opened. Pages taking an id in the query string open without one.
- Test-data states reshape JSON generically; endpoints the app needs to
  render at all (beyond session and `/api/my*`) may need adding to the
  exemptions in `src/data.js`.
- Questions live in server memory with the change log.
- Ask Claude edits existing files only (no new components), runs one request
  at a time, stops after 5 minutes, and keeps no conversation between
  requests. Anything else edited in the app folder during a run (e.g. in an
  IDE) is attributed to the run.
- URL mode: element ids are DOM paths, so an override drops off if the page's
  structure changes above the element. Sites that call an API on another
  origin need that API to allow `http://localhost` (CORS). A sign-in that
  redirects through another domain (SSO) won't come back to the local copy.
  URL-mode theme editing only reaches what the site styles through CSS
  variables. Mantine's translucent "light" colour variants don't follow a
  changed shade, and fonts must already be loaded by the site. Variables in
  stylesheets from another origin can't be read. Overrides live in server
  memory.
- MCP commands go to the most recently opened editor tab; screenshots are
  drawn from the DOM (close to, but not exactly, the browser's own
  rendering).
- `test/fixture-main.tsx.txt` is a snapshot of Attune's `main.tsx`.
