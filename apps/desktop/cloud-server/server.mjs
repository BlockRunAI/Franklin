#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = parsePort(process.env.FRANKLIN_CLOUD_PORT || 3740);
const host = process.env.FRANKLIN_CLOUD_HOST || "127.0.0.1";
const dataRoot = path.resolve(
  process.env.FRANKLIN_CLOUD_DATA_DIR || path.join(os.homedir(), ".blockrun", "franklin-cloud-demo"),
);
const statePath = path.join(dataRoot, "state.json");
const runtimeEntry = process.env.FRANKLIN_RUNTIME_ENTRY || path.resolve(here, "..", "..", "..", "dist", "index.js");
const runtimeModel = process.env.FRANKLIN_CLOUD_MODEL || "nvidia/nemotron-nano-9b-v2";
const teamCloudConfigPath = path.join(os.homedir(), ".blockrun", "franklin-team-cloud-url");
const configuredTeamCloud = (() => {
  try { return fs.readFileSync(teamCloudConfigPath, "utf8").trim(); }
  catch { return ""; }
})();
const teamCloudUrl = parseTeamCloudUrl(process.env.FRANKLIN_TEAM_CLOUD_URL || configuredTeamCloud || process.env.FRANKLIN_CLOUD_URL || "https://franklin.run");
const teamCloudBase = teamCloudUrl.href.replace(/\/$/, "");
const desktopToken = process.env.FRANKLIN_CLOUD_TOKEN || "";
const teamFakeAgent = process.env.FRANKLIN_TEAM_FAKE_AGENT === "1";
// Safe by default: the packaged prototype uses the deterministic runtime and
// never touches a local wallet. A production worker must opt in explicitly
// after wiring an isolated identity + wallet broker.
const realAgent = process.env.FRANKLIN_CLOUD_ENABLE_REAL_AGENT === "1";
const fakeAgent = !realAgent || process.env.FRANKLIN_CLOUD_FAKE_AGENT === "1";
const sandboxProvider = process.env.FRANKLIN_CLOUD_SANDBOX_PROVIDER === "docker" ? "docker" : "directory";
const sandboxImage = process.env.FRANKLIN_CLOUD_SANDBOX_IMAGE || "franklin-cloud-sandbox:local";
const bootstrapKey = process.env.FRANKLIN_CLOUD_BOOTSTRAP_KEY || "";
const allowedOrigins = new Set(
  (process.env.FRANKLIN_CLOUD_ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:5174")
    .split(",").map((value) => value.trim()).filter(Boolean),
);

if (!isLoopbackHost(host) && bootstrapKey.length < 32) {
  throw new Error("A non-loopback cloud bind requires FRANKLIN_CLOUD_BOOTSTRAP_KEY with at least 32 characters");
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error("FRANKLIN_CLOUD_PORT must be an integer from 0 to 65535");
  return parsed;
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function parseTeamCloudUrl(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error("Franklin Team Cloud URL is invalid"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Franklin Team Cloud URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Franklin Team Cloud URL must not include credentials, query, or fragment");
  return url;
}

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
const tokenHash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const inviteCode = () => `FW-${crypto.randomBytes(12).toString("base64url").toUpperCase()}`;
const rateBuckets = new Map();

function rateLimit(req, scope, limit, windowMs) {
  const remote = req.socket.remoteAddress || "unknown";
  const key = `${scope}:${remote}`;
  const time = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || time - bucket.startedAt >= windowMs) {
    bucket = { startedAt: time, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) throw new HttpError(429, "Too many requests; try again later");
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (time - value.startedAt >= windowMs) rateBuckets.delete(bucketKey);
    }
  }
}

function enforceCount(items, predicate, limit, message) {
  if (items.filter(predicate).length >= limit) throw new HttpError(507, message);
}

function initialState() {
  return { version: 1, users: [], devices: [], workspaces: [], memberships: [], invites: [], messages: [], tasks: [] };
}

await fsp.mkdir(dataRoot, { recursive: true, mode: 0o700 });
await fsp.chmod(dataRoot, 0o700);
let state = initialState();
try {
  const parsed = JSON.parse(await fsp.readFile(statePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Cloud state root must be an object");
  state = { ...initialState(), ...parsed };
  for (const key of ["users", "devices", "workspaces", "memberships", "invites", "messages", "tasks"]) {
    if (!Array.isArray(state[key])) throw new Error(`Cloud state ${key} must be an array`);
  }
  await fsp.chmod(statePath, 0o600);
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error(`Refusing to discard invalid Franklin Cloud state: ${error.message || error}`);
}

let writeQueue = Promise.resolve();
function saveState() {
  const write = async () => {
    const tmp = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
      await fsp.rename(tmp, statePath);
      await fsp.chmod(statePath, 0o600);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };
  writeQueue = writeQueue.then(write, write);
  return writeQueue;
}

function workspaceRoot(workspaceId) {
  return path.join(dataRoot, "workspaces", workspaceId);
}
function sharedRoot(workspaceId) {
  return path.join(workspaceRoot(workspaceId), "shared");
}
function sandboxRoot(workspaceId, taskId) {
  return path.join(workspaceRoot(workspaceId), "sandboxes", taskId, "work");
}
function cleanRelative(value) {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new HttpError(400, "A safe relative file path is required");
  }
  return normalized;
}
function within(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new HttpError(400, "Path escapes workspace");
  return resolved;
}

async function safeWritablePath(root, relative) {
  const absolute = within(root, relative);
  await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const [realRoot, realParent] = await Promise.all([fsp.realpath(root), fsp.realpath(path.dirname(absolute))]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new HttpError(400, "Path traverses a symbolic link outside the workspace");
  }
  const existing = await fsp.lstat(absolute).catch(() => null);
  if (existing?.isSymbolicLink()) throw new HttpError(400, "Symbolic-link files are not supported");
  return absolute;
}

async function safeReadableFile(root, relative) {
  const absolute = within(root, relative);
  const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(absolute).catch(() => null)]);
  if (!realFile || (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`))) {
    throw new HttpError(realFile ? 400 : 404, realFile ? "Path escapes workspace through a symbolic link" : "File not found");
  }
  const stat = await fsp.stat(realFile);
  if (!stat.isFile()) throw new HttpError(404, "File not found");
  return { absolute: realFile, stat };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function auth(req) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  const device = state.devices.find((item) => item.tokenHash === tokenHash(token) && !item.revokedAt);
  if (!device) throw new HttpError(401, "Invalid or expired device session");
  const user = state.users.find((item) => item.id === device.userId);
  if (!user) throw new HttpError(401, "Device user not found");
  return { user, device };
}
function workspaceById(workspaceId) {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");
  return workspace;
}
function membership(workspaceId, userId) {
  const member = state.memberships.find((item) => item.workspaceId === workspaceId && item.userId === userId && !item.revokedAt);
  if (!member) throw new HttpError(403, "You are not a member of this workspace");
  return member;
}
function publicWorkspace(workspace, userId) {
  const members = state.memberships
    .filter((item) => item.workspaceId === workspace.id && !item.revokedAt)
    .map((item) => ({
      userId: item.userId,
      name: state.users.find((user) => user.id === item.userId)?.name || "Unknown",
      role: item.role,
      joinedAt: item.joinedAt,
    }));
  return { ...workspace, role: membership(workspace.id, userId).role, members };
}

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2_000_000) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Invalid JSON body"); }
}

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Franklin-Bootstrap-Key, X-Franklin-Desktop-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function desktopAuth(req) {
  // Browser-only development can run without a token. Electron always injects
  // one into both preload and this process, making wallet operations private to
  // this Franklin window instead of merely trusting the loopback interface.
  if (!desktopToken) throw new HttpError(404, "Route not found");
  if (!secureEqual(req.headers["x-franklin-desktop-token"], desktopToken)) {
    throw new HttpError(401, "Invalid Franklin Desktop session");
  }
}

function originAllowed(req, origin) {
  if (allowedOrigins.has(origin)) return true;
  if (origin !== "null" || !desktopToken) return false;
  if (req.method === "OPTIONS") {
    return String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map((value) => value.trim()).includes("x-franklin-desktop-token");
  }
  return secureEqual(req.headers["x-franklin-desktop-token"], desktopToken);
}

const NONCE_COOKIE = "franklin_try_nonce";
const SESSION_COOKIE = "franklin_try_session";
const TEAM_TIMEOUT = 20_000;
let teamSessionCookie = null;
let runtimeModulesPromise = null;
let signingModulesPromise = null;
const runningTeamWorkspaces = new Set();
const TEAM_ACTIONS = new Set([
  "workspace.list", "workspace.create", "workspace.get", "workspace.snapshot", "workspace.invite", "workspace.join",
  "member.role", "message.list", "message.append", "file.list", "file.read", "file.save",
]);

function setCookie(res, name) {
  const values = res.headers.getSetCookie?.() || [];
  const value = values.find((item) => item.startsWith(`${name}=`));
  if (value) return value.split(";")[0];
  const fallback = res.headers.get("set-cookie");
  if (!fallback) return null;
  const match = fallback.match(new RegExp(`(?:^|,\\s*)(${name}=[^;]+)`));
  return match?.[1] || null;
}

async function responseJson(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(502, "Franklin Cloud response is too large");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(502, "Franklin Cloud response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8") || "{}"); }
  catch { throw new HttpError(502, "Franklin Cloud returned invalid JSON"); }
}

function teamPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Team request must be an object");
  const action = String(input.action || "");
  if (!TEAM_ACTIONS.has(action)) throw new HttpError(400, "Unknown Franklin Team action");
  return { ...input, action };
}

async function runtimeModules() {
  if (!runtimeModulesPromise) runtimeModulesPromise = (async () => {
    if (!runtimeEntry || !fs.existsSync(runtimeEntry)) throw new Error("Franklin runtime is not installed");
    const distRoot = path.dirname(runtimeEntry);
    const [llm, config] = await Promise.all([
      import(pathToFileURL(path.join(distRoot, "agent", "llm.js")).href),
      import(pathToFileURL(path.join(distRoot, "config.js")).href),
    ]);
    return { llm, config };
  })();
  return runtimeModulesPromise;
}

async function signingModules() {
  if (!signingModulesPromise) {
    signingModulesPromise = Promise.all([
      import("@noble/curves/secp256k1.js"),
      import("@noble/hashes/sha3.js"),
    ]).then(([curves, hashes]) => ({ secp256k1: curves.secp256k1, keccak256: hashes.keccak_256 }));
  }
  return signingModulesPromise;
}

async function localWallet() {
  const { secp256k1, keccak256 } = await signingModules();
  // Team Cloud uses an EVM SIWE identity even when the active payment chain is
  // Solana. The SDK creates the same local Base wallet Franklin uses elsewhere
  // without changing the user's selected payment chain.
  const { getOrCreateWallet } = await import("@blockrun/llm");
  const { privateKey } = getOrCreateWallet();
  const privateBytes = Buffer.from(privateKey.replace(/^0x/, ""), "hex");
  if (privateBytes.length !== 32) throw new Error("Franklin wallet key is invalid");
  const publicKey = secp256k1.getPublicKey(privateBytes, false);
  const address = `0x${Buffer.from(keccak256(publicKey.slice(1))).subarray(-20).toString("hex")}`;
  const signMessage = (message) => {
    const messageBytes = Buffer.from(message, "utf8");
    const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${messageBytes.length}`, "utf8");
    const digest = keccak256(Buffer.concat([prefix, messageBytes]));
    // Noble v1 returns a Signature object; v2 returns bytes and requires the
    // recovered format to include the recovery id. Support both because the
    // Desktop app can reuse a Franklin runtime installed by an older release.
    const signed = secp256k1.sign(digest, privateBytes, { format: "recovered", prehash: false });
    const byteResult = signed instanceof Uint8Array;
    const recoveryId = byteResult ? (signed.length === 65 ? signed[0] : 0) : (signed.recovery ?? 0);
    const compact = byteResult
      ? Buffer.from(signed.length === 65 ? signed.slice(1) : signed).toString("hex")
      : signed.toCompactHex();
    return `0x${compact}${(recoveryId + 27).toString(16).padStart(2, "0")}`;
  };
  return { address, signMessage };
}

async function teamLogin() {
  const nonceRes = await fetch(`${teamCloudBase}/api/try/auth/nonce`, { redirect: "manual", signal: AbortSignal.timeout(TEAM_TIMEOUT) });
  if (!nonceRes.ok) throw new HttpError(502, `Franklin Cloud nonce failed (${nonceRes.status})`);
  const nonceCookie = setCookie(nonceRes, NONCE_COOKIE);
  const { nonce } = await responseJson(nonceRes, 64 * 1024);
  if (!/^[a-f0-9]{32}$/i.test(String(nonce || "")) || !nonceCookie) throw new HttpError(502, "Franklin Cloud did not return a valid nonce");

  const { address, signMessage } = await localWallet();
  const message =
    `${teamCloudUrl.hostname} wants you to sign in with your Ethereum account:\n${address}\n\n` +
    `Sign in to Franklin Desktop Team Workspace.\n\n` +
    `URI: ${teamCloudUrl.origin}\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const signature = signMessage(message);
  const verifyRes = await fetch(`${teamCloudBase}/api/try/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: nonceCookie },
    body: JSON.stringify({ address, message, signature }),
    redirect: "manual",
    signal: AbortSignal.timeout(TEAM_TIMEOUT),
  });
  if (!verifyRes.ok) throw new HttpError(502, `Franklin Cloud wallet verification failed (${verifyRes.status})`);
  const verified = await responseJson(verifyRes, 64 * 1024);
  if (!secureEqual(String(verified.address || "").toLowerCase(), address.toLowerCase())) throw new HttpError(502, "Franklin Cloud verified an unexpected wallet");
  teamSessionCookie = setCookie(verifyRes, SESSION_COOKIE);
  if (!teamSessionCookie) throw new HttpError(502, "Franklin Cloud did not return a session");
}

async function teamFetch(payload) {
  payload = teamPayload(payload);
  if (!teamSessionCookie) await teamLogin();
  const request = () => fetch(`${teamCloudBase}/api/try/team`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teamSessionCookie },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(TEAM_TIMEOUT),
  });
  let response = await request();
  if (response.status === 401) {
    teamSessionCookie = null;
    await teamLogin();
    response = await request();
  }
  const result = await responseJson(response, 4 * 1024 * 1024);
  if (!response.ok) {
    const message = response.status === 404
      ? "Franklin Cloud Team API is not deployed on this server yet"
      : (result.error || `Franklin Cloud request failed (${response.status})`);
    throw new HttpError(response.status, message);
  }
  return result;
}

async function runTeamAgentTurn(input) {
  const workspaceId = String(input.workspaceId || "");
  const content = String(input.content || "").trim().slice(0, 20_000);
  if (!workspaceId || !content) throw new HttpError(400, "Workspace and message are required");
  if (runningTeamWorkspaces.has(workspaceId)) throw new HttpError(409, "Team Franklin is already working in this workspace");
  runningTeamWorkspaces.add(workspaceId);
  try {
    const snapshot = await teamFetch({ action: "workspace.snapshot", workspaceId });
    const userResult = await teamFetch({ action: "message.append", workspaceId, role: "user", content });
    let reply;
    if (teamFakeAgent) {
      reply = `Team Franklin received your message in ${snapshot.workspace.name}. This test turn used ${snapshot.files.length} shared file(s) and ${snapshot.messages.length} earlier message(s).`;
    } else {
      const { llm, config } = await runtimeModules();
      const chain = config.loadChain();
      const client = new llm.ModelClient({ apiUrl: config.API_URLS[chain], chain });
      const sharedFiles = snapshot.files.slice(0, 30).map((file) => `--- ${file.path} ---\n${String(file.content || "").slice(0, 12_000)}`).join("\n\n");
      const recent = snapshot.messages.slice(-20).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: `${message.authorName}: ${message.content}`,
      }));
      const response = await client.complete({
        model: runtimeModel,
        system: [
          `You are Team Franklin for the shared workspace \"${snapshot.workspace.name}\".`,
          "Answer for the whole team. Use the shared files as context and clearly state when information is missing.",
          sharedFiles ? `Shared workspace files:\n${sharedFiles}` : "There are no shared files yet.",
        ].join("\n\n"),
        messages: [...recent, { role: "user", content }],
        max_tokens: 4096,
        stream: false,
      });
      reply = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
      if (!reply) throw new Error("Team Franklin returned no text response");
    }
    const assistantResult = await teamFetch({ action: "message.append", workspaceId, role: "assistant", content: reply });
    return { userMessage: userResult.message, assistant: assistantResult.message, workspaceVersion: assistantResult.version };
  } finally {
    runningTeamWorkspaces.delete(workspaceId);
  }
}

async function listFiles(root) {
  const files = [];
  let totalBytes = 0;
  async function walk(dir, prefix = "") {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, rel);
      if (entry.isFile()) {
        if (files.length >= 2_000) throw new HttpError(413, "Workspace contains too many files");
        const stat = await fsp.stat(absolute);
        if (stat.size > 10 * 1024 * 1024) throw new HttpError(413, `Workspace file is too large: ${rel}`);
        totalBytes += stat.size;
        if (totalBytes > 100 * 1024 * 1024) throw new HttpError(413, "Workspace exceeds 100 MiB");
        const data = await fsp.readFile(absolute);
        files.push({ path: rel, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function snapshotWorkspace(workspaceId, taskId) {
  const from = sharedRoot(workspaceId);
  const to = sandboxRoot(workspaceId, taskId);
  await listFiles(from);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: false });
  return to;
}

function stripAnsi(value) {
  return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "").trim();
}

async function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxOutput = 2 * 1024 * 1024;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const remember = (kind, chunk) => {
      const text = chunk.toString();
      if (kind === "stdout") stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutput) {
        child.kill("SIGKILL");
        finish(new Error("Cloud Franklin output exceeded 2 MiB"));
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000).unref();
      finish(new Error("Cloud Franklin task exceeded 120 seconds"));
    }, 120_000);
    child.stdout.on("data", (chunk) => remember("stdout", chunk));
    child.stderr.on("data", (chunk) => remember("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(stripAnsi(stderr || stdout).slice(0, 4_000) || `Franklin exited with code ${code}`));
    });
    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

async function runDockerSandbox({ root, task, user, content }) {
  if (realAgent) throw new Error("Real Franklin requires a dedicated remote worker and wallet broker; it cannot run in the preview container");
  const mountRoot = await fsp.realpath(root);
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const result = await runProcess("docker", [
    "run", "--rm", "-i", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
    "--user", `${uid}:${gid}`,
    "--mount", `type=bind,src=${mountRoot},dst=/workspace`,
    "--workdir", "/workspace", sandboxImage,
  ], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    input: JSON.stringify({ taskId: task.id, memberName: user.name, prompt: content }),
  });
  const parsed = JSON.parse(result.stdout || "{}");
  if (!parsed.reply) throw new Error("Sandbox worker returned no reply");
  return parsed.reply;
}

async function runAgentTurn({ workspace, user, content, task }) {
  const root = sandboxRoot(workspace.id, task.id);
  if (sandboxProvider === "docker") return runDockerSandbox({ root, task, user, content });
  if (fakeAgent) {
    const proofName = `artifacts/${task.id}.md`;
    const proofPath = within(root, proofName);
    await fsp.mkdir(path.dirname(proofPath), { recursive: true });
    await fsp.writeFile(proofPath, `# Franklin Cloud task\n\nMember: ${user.name}\n\nPrompt: ${content}\n`, { encoding: "utf8", mode: 0o600 });
    return `Cloud Franklin received the task from ${user.name}. I worked inside isolated sandbox ${task.id} and prepared ${proofName}.`;
  }
  throw new Error("In-process real-agent execution is disabled; use a dedicated remote worker with an isolated identity and wallet broker");
}

async function taskChanges(workspaceId, taskId, baseFiles = []) {
  const before = new Map(baseFiles.map((file) => [file.path, file]));
  const after = await listFiles(sandboxRoot(workspaceId, taskId));
  return after.filter((file) => before.get(file.path)?.sha256 !== file.sha256);
}

async function handle(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin) {
    if (!originAllowed(req, origin)) throw new HttpError(403, "Origin is not allowed");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true, service: "franklin-cloud-workspace", mode: fakeAgent ? "test" : "franklin",
      sandboxProvider, authMode: bootstrapKey ? "private-preview" : "demo-device",
      desktopProtected: Boolean(desktopToken),
    });
  }

  // Product Team Mode: Desktop owns wallet access and proxies only this
  // explicit command surface to the existing SIWE-authenticated Franklin Cloud.
  // The legacy demo routes below remain for the standalone cloud-server tests.
  if (req.method === "POST" && url.pathname === "/v1/franklin-team") {
    rateLimit(req, "team-proxy", 240, 60_000);
    desktopAuth(req);
    return json(res, 200, await teamFetch(await body(req)));
  }
  if (req.method === "POST" && url.pathname === "/v1/franklin-team/agent-turn") {
    rateLimit(req, "team-turn", 20, 60_000);
    desktopAuth(req);
    return json(res, 201, await runTeamAgentTurn(await body(req)));
  }

  // Development device bootstrap. The token is random and only its hash is persisted.
  // Production replaces this route with browser OAuth + PKCE/DPoP.
  if (req.method === "POST" && url.pathname === "/v1/demo/devices") {
    rateLimit(req, "device-bootstrap", 20, 60 * 60_000);
    if (bootstrapKey && !secureEqual(req.headers["x-franklin-bootstrap-key"], bootstrapKey)) {
      throw new HttpError(401, "A valid private-preview access key is required");
    }
    const input = await body(req);
    const name = String(input.name || "").trim().slice(0, 80);
    if (!name) throw new HttpError(400, "Member name is required");
    enforceCount(state.devices, () => true, 10_000, "This preview has reached its device limit");
    // A display name is not an identity proof. Always create a distinct demo
    // principal so entering somebody else's name cannot impersonate them.
    const user = { id: id("usr"), name, createdAt: now() };
    state.users.push(user);
    const token = crypto.randomBytes(32).toString("base64url");
    const device = { id: id("dev"), userId: user.id, name: String(input.deviceName || "Franklin Desktop").slice(0, 120), tokenHash: tokenHash(token), createdAt: now() };
    state.devices.push(device);
    await saveState();
    return json(res, 201, { user, device: { ...device, tokenHash: undefined }, token, authMode: "demo-device" });
  }

  const { user, device } = auth(req);

  if (req.method === "GET" && url.pathname === "/v1/me") {
    return json(res, 200, { user, device: { id: device.id, name: device.name, createdAt: device.createdAt } });
  }
  if (req.method === "GET" && url.pathname === "/v1/workspaces") {
    const memberships = state.memberships.filter((item) => item.userId === user.id && !item.revokedAt);
    return json(res, 200, { workspaces: memberships.map((item) => publicWorkspace(workspaceById(item.workspaceId), user.id)) });
  }
  if (req.method === "POST" && url.pathname === "/v1/workspaces") {
    const input = await body(req);
    const name = String(input.name || "").trim().slice(0, 100);
    if (!name) throw new HttpError(400, "Workspace name is required");
    enforceCount(state.memberships, (item) => item.userId === user.id && !item.revokedAt, 100, "Workspace limit reached");
    const workspace = { id: id("ws"), name, createdBy: user.id, createdAt: now(), version: 1, runtime: "isolated-directory" };
    state.workspaces.push(workspace);
    state.memberships.push({ workspaceId: workspace.id, userId: user.id, role: "owner", joinedAt: now() });
    await fsp.mkdir(sharedRoot(workspace.id), { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(sharedRoot(workspace.id), "README.md"), `# ${name}\n\nShared Franklin Cloud workspace.\n`, { encoding: "utf8", mode: 0o600 });
    await saveState();
    return json(res, 201, { workspace: publicWorkspace(workspace, user.id) });
  }
  if (req.method === "POST" && url.pathname === "/v1/workspaces/join") {
    rateLimit(req, `workspace-join:${device.id}`, 60, 60 * 60_000);
    const input = await body(req);
    const code = String(input.code || "").trim().toUpperCase();
    const invite = state.invites.find((item) => item.code === code && !item.usedBy && Date.parse(item.expiresAt) > Date.now());
    if (!invite) throw new HttpError(404, "Invite code is invalid, used, or expired");
    if (!state.memberships.some((item) => item.workspaceId === invite.workspaceId && item.userId === user.id && !item.revokedAt)) {
      state.memberships.push({ workspaceId: invite.workspaceId, userId: user.id, role: invite.role, joinedAt: now() });
    }
    invite.usedBy = user.id;
    invite.usedAt = now();
    await saveState();
    return json(res, 200, { workspace: publicWorkspace(workspaceById(invite.workspaceId), user.id) });
  }

  if (parts[0] !== "v1" || parts[1] !== "workspaces" || !parts[2]) throw new HttpError(404, "Route not found");
  const workspaceId = parts[2];
  const workspace = workspaceById(workspaceId);
  const member = membership(workspaceId, user.id);

  if (req.method === "GET" && parts.length === 3) {
    return json(res, 200, { workspace: publicWorkspace(workspace, user.id) });
  }
  if (req.method === "POST" && parts[3] === "invites") {
    if (member.role !== "owner" && member.role !== "admin") throw new HttpError(403, "Only owners and admins can invite members");
    rateLimit(req, `workspace-invite:${device.id}`, 30, 60 * 60_000);
    enforceCount(state.invites, (item) => item.workspaceId === workspaceId && !item.usedBy && Date.parse(item.expiresAt) > Date.now(), 100, "Too many active invites");
    const input = await body(req);
    const invite = {
      id: id("inv"), workspaceId, code: inviteCode(), role: input.role === "viewer" ? "viewer" : "member",
      createdBy: user.id, createdAt: now(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    state.invites.push(invite);
    await saveState();
    return json(res, 201, { invite });
  }
  if (req.method === "GET" && parts[3] === "messages") {
    return json(res, 200, { messages: state.messages.filter((item) => item.workspaceId === workspaceId) });
  }
  if (req.method === "POST" && parts[3] === "messages") {
    if (member.role === "viewer") throw new HttpError(403, "Viewers cannot send messages");
    rateLimit(req, `workspace-message:${device.id}`, 30, 60_000);
    enforceCount(state.messages, (item) => item.workspaceId === workspaceId, 500, "Workspace message limit reached; archive this preview before continuing");
    enforceCount(state.tasks, (item) => item.workspaceId === workspaceId, 100, "Workspace task limit reached; archive this preview before continuing");
    const input = await body(req);
    const content = String(input.content || "").trim().slice(0, 20_000);
    if (!content) throw new HttpError(400, "Message is required");
    const userMessage = { id: id("msg"), workspaceId, role: "user", authorId: user.id, authorName: user.name, content, createdAt: now() };
    state.messages.push(userMessage);
    const task = { id: id("task"), workspaceId, createdBy: user.id, prompt: content, status: "running", createdAt: now(), baseVersion: workspace.version };
    state.tasks.push(task);
    await snapshotWorkspace(workspaceId, task.id);
    task.baseFiles = await listFiles(sandboxRoot(workspaceId, task.id));
    await saveState();
    try {
      const reply = await runAgentTurn({ workspace, user, content, task });
      task.status = "completed";
      task.completedAt = now();
      task.changes = await taskChanges(workspaceId, task.id, task.baseFiles);
      const assistant = { id: id("msg"), workspaceId, role: "assistant", authorId: "franklin-cloud", authorName: "Franklin Cloud", content: reply, taskId: task.id, createdAt: now() };
      state.messages.push(assistant);
      await saveState();
      return json(res, 201, { userMessage, assistant, task });
    } catch (error) {
      task.status = "failed";
      task.completedAt = now();
      task.error = error instanceof Error ? error.message : String(error);
      await saveState();
      throw new HttpError(502, `Cloud Franklin failed: ${task.error}`);
    }
  }
  if (req.method === "GET" && parts[3] === "files") {
    const requested = url.searchParams.get("path");
    if (!requested) return json(res, 200, { files: await listFiles(sharedRoot(workspaceId)), version: workspace.version });
    const rel = cleanRelative(requested);
    const { absolute, stat } = await safeReadableFile(sharedRoot(workspaceId), rel);
    if (stat.size > 500_000) throw new HttpError(413, "File is too large to preview");
    return json(res, 200, { path: rel, content: await fsp.readFile(absolute, "utf8"), bytes: stat.size, version: workspace.version });
  }
  if (req.method === "PUT" && parts[3] === "files") {
    if (member.role === "viewer") throw new HttpError(403, "Viewers cannot edit files");
    rateLimit(req, `workspace-file:${device.id}`, 120, 60_000);
    const input = await body(req);
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== workspace.version)) {
      throw new HttpError(409, "Workspace changed since this file was opened; refresh before saving");
    }
    const rel = cleanRelative(input.path);
    const content = String(input.content ?? "");
    if (Buffer.byteLength(content) > 500_000) throw new HttpError(413, "File is too large");
    const absolute = await safeWritablePath(sharedRoot(workspaceId), rel);
    await fsp.writeFile(absolute, content, { encoding: "utf8", mode: 0o600 });
    await fsp.chmod(absolute, 0o600);
    workspace.version += 1;
    await saveState();
    return json(res, 200, { ok: true, path: rel, version: workspace.version });
  }
  if (req.method === "GET" && parts[3] === "tasks") {
    return json(res, 200, { tasks: state.tasks.filter((item) => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  if (req.method === "POST" && parts[3] === "tasks" && parts[5] === "apply") {
    if (member.role !== "owner" && member.role !== "admin") throw new HttpError(403, "Only owners and admins can apply task changes");
    const task = state.tasks.find((item) => item.id === parts[4] && item.workspaceId === workspaceId);
    if (!task || task.status !== "completed") throw new HttpError(404, "Completed task not found");
    if (task.appliedAt) throw new HttpError(409, "Task changes were already applied");
    const baseFiles = new Map((task.baseFiles || []).map((file) => [file.path, file]));
    const currentFiles = new Map((await listFiles(sharedRoot(workspaceId))).map((file) => [file.path, file]));
    const conflicts = (task.changes || [])
      .filter((file) => (baseFiles.get(file.path)?.sha256 || null) !== (currentFiles.get(file.path)?.sha256 || null))
      .map((file) => file.path);
    if (conflicts.length) {
      throw new HttpError(409, `Shared files changed after sandbox snapshot: ${conflicts.join(", ")}`);
    }
    for (const file of task.changes || []) {
      const rel = cleanRelative(file.path);
      const { absolute: from } = await safeReadableFile(sandboxRoot(workspaceId, task.id), rel);
      const to = await safeWritablePath(sharedRoot(workspaceId), rel);
      await fsp.copyFile(from, to);
      await fsp.chmod(to, 0o600);
    }
    task.appliedAt = now();
    task.appliedBy = user.id;
    workspace.version += 1;
    await saveState();
    return json(res, 200, { ok: true, version: workspace.version, changes: task.changes || [] });
  }
  throw new HttpError(404, "Route not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    // Keep the HTTP parser aligned for a reused loopback connection when an
    // auth/origin check rejects a POST before body() has consumed its payload.
    req.resume();
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error("[franklin-cloud] request failed", error);
    json(res, status, { error: error instanceof HttpError ? error.message : "Internal server error" });
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  const address = server.address();
  const readyPort = address && typeof address !== "string" ? address.port : port;
  console.log(`[franklin-cloud] http://${host}:${readyPort} data=${dataRoot} runtime=${fakeAgent ? "test" : runtimeEntry} sandbox=${sandboxProvider}`);
  if (typeof process.send === "function") process.send({ type: "franklin:cloud-ready", port: readyPort });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await writeQueue.catch(() => {});
    process.exit(0);
  });
}
