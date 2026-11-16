#!/usr/bin/env node
// Older entry point, kept for existing commands: `node bin/run.js <app-dir> [port]`.
// Same as `visual-edit open <app-dir> --port <port> --no-open`.
process.argv.push("--no-open");
await import("./visual-edit.js");
