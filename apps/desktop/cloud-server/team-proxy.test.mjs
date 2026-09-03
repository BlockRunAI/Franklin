import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const walletHome = await fsp.mkdtemp(path.join(os.tmpdir(), ".franklin-team-wallet-"));
const token = "desktop-team-test-token";
const workspace = {
  id: "tw_test", name: "Proxy Test", createdAt: new Date().toISOString(), version: 1,
  runtime: "member-franklin", role: "owner",
  members: [{ userId: "0x1111111111111111111111111111111111111111", name: "0x1111…1111", role: "owner", joinedAt: new Date().toISOString() }],
};
const messages = [];
const files = [{ path: "README.md", content: "# Proxy Test", bytes: 12, version: 1, updatedAt: new Date().toISOString(), updatedBy: workspace.members[0].userId }];
let verifiedAuth = null;

const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};
const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};
const mockCloud = http.createServer(async (req, res) => {
  if (req.url === "/api/try/auth/nonce") return json(res, 200, { nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { "Set-Cookie": "franklin_try_nonce=test; Path=/; HttpOnly" });
  if (req.url === "/api/try/auth/verify") {
    const input = await readBody(req);
    verifiedAuth = input;
    return json(res, 200, { address: input.address }, { "Set-Cookie": "franklin_try_session=test-session; Path=/; HttpOnly" });
  }
  if (req.url !== "/api/try/team" || !String(req.headers.cookie || "").includes("franklin_try_session=test-session")) return json(res, 401, { error: "Not signed in" });
  const input = await readBody(req);
  if (input.action === "workspace.list") return json(res, 200, { workspaces: [workspace], wallet: workspace.members[0].userId });
  if (input.action === "workspace.snapshot") return json(res, 200, { workspace, messages, files });
  if (input.action === "message.append") {
    const message = {
      id: `tm_${messages.length + 1}`, role: input.role, authorId: workspace.members[0].userId,
      authorName: input.role === "assistant" ? "Franklin · 0x1111…1111" : "0x1111…1111",
      content: input.content, createdAt: new Date().toISOString(),
    };
    messages.push(message);
    workspace.version += 1;
    return json(res, 201, { message, version: workspace.version });
  }
  return json(res, 400, { error: "Unknown test action" });
});

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const remotePort = await listen(mockCloud);
let proxyPort = 0;
const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
  cwd: path.join(here, ".."),
  env: {
    ...process.env,
    FRANKLIN_CLOUD_PORT: "0",
    FRANKLIN_CLOUD_TOKEN: token,
    FRANKLIN_TEAM_CLOUD_URL: `http://127.0.0.1:${remotePort}`,
    FRANKLIN_TEAM_FAKE_AGENT: "1",
    HOME: walletHome,
    BLOCKRUN_HOME: walletHome,
    FRANKLIN_RUNTIME_ENTRY: process.env.FRANKLIN_TEST_RUNTIME_ENTRY
      // Mirror the packaged layout: the runtime has no sibling node_modules.
      || path.join(here, ".packaged-layout", "franklin-agent", "dist", "index.js"),
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Team proxy did not report readiness")), 5_000);
  child.on("message", (message) => {
    if (message?.type !== "franklin:cloud-ready" || !Number.isInteger(message.port) || message.port < 1) return;
    clearTimeout(timer);
    proxyPort = message.port;
    resolve();
  });
  child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Team proxy exited before readiness (${code})`)); });
});

try {
  await ready;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${proxyPort}/health`)).ok) break; }
    catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const unauthorized = await fetch(`http://127.0.0.1:${proxyPort}/v1/franklin-team`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "workspace.list" }) });
  assert.equal(unauthorized.status, 401);

  const hostileNullOrigin = await fetch(`http://127.0.0.1:${proxyPort}/v1/franklin-team`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "null", "X-Franklin-Desktop-Token": "wrong" }, body: JSON.stringify({ action: "workspace.list" }) });
  assert.equal(hostileNullOrigin.status, 403);

  const headers = { "Content-Type": "application/json", "X-Franklin-Desktop-Token": token };
  const listed = await fetch(`http://127.0.0.1:${proxyPort}/v1/franklin-team`, { method: "POST", headers, body: JSON.stringify({ action: "workspace.list" }) });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).workspaces[0].id, workspace.id);
  assert.match(verifiedAuth?.message || "", new RegExp(`127\\.0\\.0\\.1 wants you to sign in with your Ethereum account:\\n${verifiedAuth?.address}`));
  assert.match(verifiedAuth?.message || "", new RegExp(`URI: http://127\\.0\\.0\\.1:${remotePort}\\nVersion: 1\\nChain ID: 8453`));
  assert.match(verifiedAuth?.message || "", /Nonce: a{32}\nIssued At: /);
  assert.match(verifiedAuth?.signature || "", /^0x[0-9a-f]{130}$/i);

  const unknown = await fetch(`http://127.0.0.1:${proxyPort}/v1/franklin-team`, { method: "POST", headers, body: JSON.stringify({ action: "wallet.export" }) });
  assert.equal(unknown.status, 400);

  const turn = await fetch(`http://127.0.0.1:${proxyPort}/v1/franklin-team/agent-turn`, { method: "POST", headers, body: JSON.stringify({ workspaceId: workspace.id, content: "Summarize the workspace" }) });
  assert.equal(turn.status, 201);
  const result = await turn.json();
  assert.equal(result.userMessage.content, "Summarize the workspace");
  assert.match(result.assistant.content, /1 shared file/);
  assert.equal(messages.length, 2);
  console.log("team-proxy: token isolation, SIWE bridge, workspace list, and agent turn passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => mockCloud.close(resolve));
  await fsp.rm(walletHome, { recursive: true, force: true });
}
