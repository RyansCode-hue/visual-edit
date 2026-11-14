#!/usr/bin/env node
// Starts a target app's own Vite dev server with the visual-edit plugin added.
// The app's vite.config is used as-is; nothing in the app repo is modified.
//
//   node bin/run.js <app-dir> [port]

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import visualEdit from "../src/plugin.js";

const appDir = path.resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 5390);
const viteDir = path.join(appDir, "node_modules", "vite");
if (!fs.existsSync(viteDir)) {
  console.error(`No vite in ${appDir}/node_modules; run npm install there first.`);
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(viteDir, "package.json"), "utf8"));
// exports["."] is a path string in Vite 7, a conditions object in older majors.
let entry = pkg.exports["."];
while (typeof entry === "object") entry = entry.import ?? entry.default;
const vite = await import(pathToFileURL(path.join(viteDir, entry)).href);

// The app's config reads .env files relative to cwd.
process.chdir(appDir);
// Editor options come from the environment so credentials stay out of code:
//   VE_DEMO_USER / VE_DEMO_PASSWORD  MFA-exempt login for "Sign in as demo user"
//   VE_DEMO_START                    page to open after that login (default /)
//   VE_ALLOW_PUSH=1                  "Send for review" also pushes and opens a PR
const server = await vite.createServer({
  root: appDir,
  plugins: [visualEdit({
    demoUser: process.env.VE_DEMO_USER,
    demoPassword: process.env.VE_DEMO_PASSWORD,
    demoStart: process.env.VE_DEMO_START,
    allowPush: process.env.VE_ALLOW_PUSH === "1",
  })],
  server: { port, strictPort: false }, // next free port if taken
});
await server.listen();
server.printUrls();
const local = server.resolvedUrls?.local?.[0];
if (local) console.log(`\n  \x1b[35m➜  Editor:\x1b[0m  ${new URL("/__ve/", local)}\n`);
