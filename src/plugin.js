// visual-edit as a plain Vite plugin, for adding to an app's own vite.config
// instead of running the standalone editor (bin/visual-edit.js):
//
//   import visualEdit from "visual-edit/src/plugin.js";
//   export default defineConfig({ plugins: [visualEdit(), react()] });
//
// Dev server only; the editor is then at /__ve/ on the app's own port.

import { createEditor } from "./editor.js";
import { vitePlugin } from "./adapters/vite.js";

export default function visualEdit(opts = {}) {
  return vitePlugin(createEditor(opts), { mountApi: true });
}
