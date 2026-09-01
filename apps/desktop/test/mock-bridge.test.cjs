const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const WebSocket = require("ws");

function connect(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    const timer = setTimeout(() => { ws.terminate(); resolve({ opened: false, status: "timeout" }); }, 3_000);
    ws.once("open", () => { clearTimeout(timer); resolve({ opened: true, ws }); });
    ws.once("unexpected-response", (_request, response) => { clearTimeout(timer); resolve({ opened: false, status: response.statusCode }); });
    ws.once("error", () => {});
  });
}

test("mock bridge uses an ephemeral loopback port and rejects hostile browser origins", async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "dev-server", "mock.mjs")], {
    env: { ...process.env, FRANKLIN_AGENT_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => child.kill("SIGTERM"));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock readiness timeout")), 5_000);
    child.on("message", (message) => {
      if (message?.type !== "franklin:server-ready") return;
      clearTimeout(timer);
      resolve(message.port);
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`mock exited before readiness (${code})`)); });
  });
  assert.ok(Number.isInteger(port) && port > 0);
  const endpoint = `ws://127.0.0.1:${port}/agent`;
  const hostile = await connect(endpoint, "https://evil.example");
  assert.equal(hostile.opened, false);
  assert.equal(hostile.status, 401);
  const allowed = await connect(endpoint, "http://localhost:5174");
  assert.equal(allowed.opened, true);
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock RPC timeout")), 3_000);
    allowed.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== "m1") return;
      clearTimeout(timer);
      resolve(message);
    });
    allowed.ws.send(JSON.stringify({ id: "m1", kind: "session.list" }));
  });
  allowed.ws.close();
  assert.equal(response.kind, "response");
  assert.ok(Array.isArray(response.payload.sessions));
});
