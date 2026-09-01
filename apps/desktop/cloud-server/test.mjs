#!/usr/bin/env node

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Colima only bind-mounts user directories by default. Keep Docker-provider
// fixtures inside the checkout; the finally block removes them after each run.
const testRoot = process.env.FRANKLIN_CLOUD_SANDBOX_PROVIDER === "docker" ? process.cwd() : os.tmpdir();
const dataDir = await fsp.mkdtemp(path.join(testRoot, ".franklin-cloud-test-"));
let base = "";
const bootstrapKey = "e2e-private-preview-key";
const server = spawn(process.execPath, [path.join(here, "server.mjs")], {
  env: {
    ...process.env,
    FRANKLIN_CLOUD_PORT: "0",
    FRANKLIN_CLOUD_DATA_DIR: dataDir,
    FRANKLIN_CLOUD_FAKE_AGENT: "1",
    FRANKLIN_CLOUD_BOOTSTRAP_KEY: bootstrapKey,
    FRANKLIN_CLOUD_ALLOWED_ORIGINS: "http://localhost:5174",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Cloud test server did not report readiness: ${stderr}`)), 5_000);
  server.on("message", (message) => {
    if (message?.type !== "franklin:cloud-ready" || !Number.isInteger(message.port) || message.port < 1) return;
    clearTimeout(timer);
    base = `http://127.0.0.1:${message.port}`;
    resolve();
  });
  server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Cloud test server exited before readiness (${code}): ${stderr}`)); });
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Cloud test server did not start: ${stderr}`);
}

function runE2e() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "e2e.mjs")], {
      env: { ...process.env, FRANKLIN_CLOUD_URL: base, FRANKLIN_CLOUD_BOOTSTRAP_KEY: bootstrapKey, FRANKLIN_CLOUD_DATA_DIR: dataDir },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`E2E exited with ${code}`)));
  });
}

try {
  await ready;
  await waitForHealth();
  await runE2e();
} finally {
  server.kill("SIGTERM");
  await fsp.rm(dataDir, { recursive: true, force: true });
}
