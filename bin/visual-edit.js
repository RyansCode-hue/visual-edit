#!/usr/bin/env node
// visual-edit open <app folder | https://site> [--port 5390] [--no-open]
//
// Repo mode (a folder): the app runs through its own Vite with source-mapped
// editing; changes are written to the code.
// URL mode (a URL): any running site, proxied locally; changes are kept as
// overrides and handed off as a prompt with screenshots.
//
// Editor options come from the environment so credentials stay out of code:
//   VE_DEMO_USER / VE_DEMO_PASSWORD  MFA-exempt login for "Sign in as demo user"
//   VE_DEMO_START                    page to open after that login (default /)
//   VE_ALLOW_PUSH=1                  "Send for review" also pushes and opens a PR
//   VE_CLAUDE=0                      turn off "Ask Claude" (uses the local `claude` CLI login)
//   VE_CLAUDE_MODEL / VE_CLAUDE_BIN  model and command for "Ask Claude"

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { startServer } from "../src/server.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`visual-edit needs Node 20 or newer; this is Node ${process.versions.node}.`);
  process.exit(1);
}

const USAGE = "Usage: visual-edit open <app folder | https://site> [--port 5390] [--no-open]";
const args = process.argv.slice(2);
if (args[0] === "open") args.shift();
const flags = { port: 5390, open: true };
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") flags.port = Number(args[++i]);
  else if (args[i] === "--no-open") flags.open = false;
  else if (args[i] === "-h" || args[i] === "--help") { console.log(USAGE); process.exit(0); }
  else positional.push(args[i]);
}
const target = positional[0] ?? ".";
if (positional[1] && /^\d+$/.test(positional[1])) flags.port = Number(positional[1]); // old run.js form
if (!Number.isInteger(flags.port) || flags.port <= 0) {
  console.error(USAGE);
  process.exit(1);
}

const isUrl = /^https?:\/\//i.test(target);
const appDir = isUrl ? null : path.resolve(target);
if (appDir && !fs.existsSync(appDir)) {
  console.error(`No such folder: ${appDir}\n${USAGE}`);
  process.exit(1);
}

let started;
try {
  started = await startServer({
    appDir,
    url: isUrl ? target : null,
    port: flags.port,
    options: {
      demoUser: process.env.VE_DEMO_USER,
      demoPassword: process.env.VE_DEMO_PASSWORD,
      demoStart: process.env.VE_DEMO_START,
      allowPush: process.env.VE_ALLOW_PUSH === "1",
      claude: process.env.VE_CLAUDE !== "0",
      claudeModel: process.env.VE_CLAUDE_MODEL || undefined,
      claudeBin: process.env.VE_CLAUDE_BIN || "claude",
    },
  });
} catch (e) {
  console.error(`visual-edit couldn't start: ${e.message}`);
  process.exit(1);
}

const editorUrl = `${started.url}/__ve/`;
console.log(`\n  \x1b[35m➜  Editor:\x1b[0m  ${editorUrl}`);
if (started.mcpCommand) console.log(`  \x1b[35m➜  MCP:\x1b[0m     ${started.mcpCommand}`);
console.log("");
if (flags.open && process.platform === "darwin") {
  execFile("open", [editorUrl], (err) => {
    if (err) console.error(`Couldn't open the browser: ${err.message}. Open ${editorUrl} yourself.`);
  });
}

const stop = async () => {
  await started.close().catch((e) => console.error(e.message));
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
