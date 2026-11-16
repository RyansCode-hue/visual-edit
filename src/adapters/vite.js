// Repo mode: serves the app through its own Vite, inside the editor's server.
//
// The app's vite.config is used as-is (proxy, aliases, plugins); the editor
// adds one plugin that stamps JSX with source locations and injects the
// canvas scripts. Nothing in the app repo is modified.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The Vite plugin that connects an app's Vite to an editor. */
export function vitePlugin(editor, { mountApi = false } = {}) {
  let server = null;
  return {
    name: "visual-edit",
    apply: "serve",
    enforce: "pre",

    configResolved(config) {
      const proxy = config.server.proxy?.["/api"];
      editor.setRepo({
        root: config.root,
        apiTarget: typeof proxy === "string" ? proxy : proxy?.target ?? null,
      });
    },

    load: (id) => editor.load(id),

    transformIndexHtml: () => editor.htmlTags(),

    configureServer(s) {
      server = s;
      editor.setAdapter({
        reload(files) {
          for (const abs of files) {
            for (const m of server.moduleGraph.getModulesByFile(abs) ?? []) server.moduleGraph.invalidateModule(m);
          }
          server.ws.send({ type: "full-reload" });
        },
      });
      // Used as a plain plugin in someone's vite.config, Vite's own server
      // also carries the editor's URLs.
      if (mountApi) server.middlewares.use((req, res, next) => editor.middleware(req, res, next));
    },
  };
}

/** Imports the Vite that the app itself depends on. */
export async function importAppVite(appDir) {
  const viteDir = path.join(appDir, "node_modules", "vite");
  if (!fs.existsSync(viteDir)) {
    throw new Error(`No vite in ${appDir}/node_modules; run npm install there first.`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(viteDir, "package.json"), "utf8"));
  // exports["."] is a path string in Vite 7, a conditions object in older majors.
  let entry = pkg.exports["."];
  while (typeof entry === "object") entry = entry.import ?? entry.default;
  return import(pathToFileURL(path.join(viteDir, entry)).href);
}

/**
 * Starts the app's Vite in middleware mode on the editor's HTTP server.
 * @returns {{ middleware: (req, res, next) => void, close: () => Promise<void> }}
 */
export async function startViteAdapter({ appDir, editor, httpServer }) {
  const vite = await importAppVite(appDir);
  // The app's config reads .env files relative to cwd.
  process.chdir(appDir);
  const server = await vite.createServer({
    root: appDir,
    appType: "spa",
    plugins: [vitePlugin(editor)],
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  return {
    middleware: (req, res, next) => server.middlewares(req, res, next),
    close: () => server.close(),
  };
}
