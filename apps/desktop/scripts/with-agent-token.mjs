#!/usr/bin/env node
// Dev launcher: run a command with one FRANKLIN_SERVE_TOKEN that every process
// it starts shares. `franklin serve` refuses sockets without its token, so the
// dev agent (dev:agent) and the Electron preload must agree on it. The token
// travels in the environment only, never on a command line, where other local
// accounts could read it.
//
//   node scripts/with-agent-token.mjs concurrently ...
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: with-agent-token.mjs <command> [args...]");
  process.exit(2);
}

const inherited = !!process.env.FRANKLIN_SERVE_TOKEN;
const token = process.env.FRANKLIN_SERVE_TOKEN || crypto.randomBytes(32).toString("base64url");
if (!inherited) {
  // The browser-only dev page has no preload to inject the token; it reads it
  // from the URL fragment (see browserAgentToken in src/lib/ws.ts).
  const uiPort = process.env.FRANKLIN_DESKTOP_UI_PORT || "5174";
  console.log(`\n  Browser dev UI: http://localhost:${uiPort}/#agentToken=${token}\n`);
}

const child = spawn(cmd, args, {
  stdio: "inherit",
  env: { ...process.env, FRANKLIN_SERVE_TOKEN: token },
  shell: process.platform === "win32",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
