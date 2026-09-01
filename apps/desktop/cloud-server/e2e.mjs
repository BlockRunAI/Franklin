#!/usr/bin/env node

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const base = process.env.FRANKLIN_CLOUD_URL || "http://127.0.0.1:3740";
const expectArtifact = process.env.FRANKLIN_CLOUD_EXPECT_ARTIFACT !== "0";
const bootstrapKey = process.env.FRANKLIN_CLOUD_BOOTSTRAP_KEY || "";
const allowedOrigin = process.env.FRANKLIN_CLOUD_TEST_ORIGIN || "http://localhost:5174";

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
}

async function call(path, { token, method = "GET", body, expected } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(bootstrapKey ? { "X-Franklin-Bootstrap-Key": bootstrapKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (expected !== undefined) {
    assert(response.status === expected, `${method} ${path}: expected ${expected}, got ${response.status}`);
    return result;
  }
  if (!response.ok) throw new Error(`${method} ${path}: ${result.error || response.status}`);
  return result;
}

const stamp = Date.now().toString(36);
const allowedCors = await fetch(`${base}/health`, { headers: { Origin: allowedOrigin } });
assert(allowedCors.ok && allowedCors.headers.get("access-control-allow-origin") === allowedOrigin, "configured browser origin should be allowed");
const deniedCors = await fetch(`${base}/health`, { headers: { Origin: "https://untrusted.example" } });
assert(deniedCors.status === 403, "unknown browser origin should be rejected");
const disabledDesktopProxy = await fetch(`${base}/v1/franklin-team`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "workspace.list" }),
});
assert(disabledDesktopProxy.status === 404, "desktop wallet proxy must be disabled without a per-process token");
if (bootstrapKey) {
  const deniedBootstrap = await fetch(`${base}/v1/demo/devices`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Unprovisioned" }),
  });
  assert(deniedBootstrap.status === 401, "remote device provisioning should require the private-preview key");
}
const owner = await call("/v1/demo/devices", { method: "POST", body: { name: `Owner-${stamp}` } });
const guest = await call("/v1/demo/devices", { method: "POST", body: { name: `Member-${stamp}` } });
const sameNameDevice = await call("/v1/demo/devices", { method: "POST", body: { name: `Owner-${stamp}` } });
const created = await call("/v1/workspaces", { token: owner.token, method: "POST", body: { name: `E2E Workspace ${stamp}` } });
const workspaceId = created.workspace.id;
const sameNameWorkspaces = await call("/v1/workspaces", { token: sameNameDevice.token });
assert(sameNameWorkspaces.workspaces.length === 0, "display names must not be usable for identity impersonation");

const firstWrite = await call(`/v1/workspaces/${workspaceId}/files`, {
  token: owner.token, method: "PUT", body: { path: "brief.md", content: "# Shared brief\n\nVisible to every member.\n" },
});
await call(`/v1/workspaces/${workspaceId}/files`, {
  token: owner.token, method: "PUT", body: { path: "brief.md", content: "stale overwrite", expectedVersion: firstWrite.version - 1 }, expected: 409,
});
const dataDir = process.env.FRANKLIN_CLOUD_DATA_DIR;
if (dataDir) {
  const link = path.join(dataDir, "workspaces", workspaceId, "shared", "escape-link");
  await fsp.symlink(os.tmpdir(), link);
  await call(`/v1/workspaces/${workspaceId}/files`, {
    token: owner.token, method: "PUT", body: { path: "escape-link/franklin-cloud-escape-probe.txt", content: "must not escape" }, expected: 400,
  });
  await fsp.unlink(link);
}
const invite = await call(`/v1/workspaces/${workspaceId}/invites`, { token: owner.token, method: "POST", body: { role: "member" } });
await call("/v1/workspaces/join", { token: guest.token, method: "POST", body: { code: invite.invite.code } });

const joined = await call(`/v1/workspaces/${workspaceId}`, { token: guest.token });
assert(joined.workspace.members.length === 2, "owner and member should share the workspace");
assert(joined.workspace.role === "member", "joined user should receive member role");

await call(`/v1/workspaces/${workspaceId}/invites`, { token: guest.token, method: "POST", body: {}, expected: 403 });

const firstTurn = await call(`/v1/workspaces/${workspaceId}/messages`, {
  token: guest.token, method: "POST", body: { content: "Read the shared brief and prepare a status artifact." },
});
assert(firstTurn.task.status === "completed", "member task should complete");
if (expectArtifact) assert(firstTurn.task.changes.length === 1, "sandbox should contain one staged artifact");

const beforeApply = await call(`/v1/workspaces/${workspaceId}/files`, { token: owner.token });
let afterApply = beforeApply;
if (expectArtifact) {
  assert(!beforeApply.files.some((file) => file.path === firstTurn.task.changes[0].path), "sandbox artifact must not leak into shared files before approval");
  await call(`/v1/workspaces/${workspaceId}/tasks/${firstTurn.task.id}/apply`, { token: owner.token, method: "POST", body: {} });
  afterApply = await call(`/v1/workspaces/${workspaceId}/files`, { token: guest.token });
  assert(afterApply.files.some((file) => file.path === firstTurn.task.changes[0].path), "approved artifact should become shared");
}

const secondTurn = await call(`/v1/workspaces/${workspaceId}/messages`, {
  token: owner.token, method: "POST", body: { content: "Create a second independent workspace artifact." },
});
assert(secondTurn.task.id !== firstTurn.task.id, "every turn should have a distinct sandbox task id");
if (expectArtifact) {
  const conflictingPath = secondTurn.task.changes[0].path;
  await call(`/v1/workspaces/${workspaceId}/files`, {
    token: guest.token, method: "PUT", body: { path: conflictingPath, content: "Member-authored content wins until a conflict is resolved.\n" },
  });
  const conflict = await call(`/v1/workspaces/${workspaceId}/tasks/${secondTurn.task.id}/apply`, {
    token: owner.token, method: "POST", body: {}, expected: 409,
  });
  assert(conflict.error.includes(conflictingPath), "stale sandbox apply should report the conflicting shared file");
  const preserved = await call(`/v1/workspaces/${workspaceId}/files?path=${encodeURIComponent(conflictingPath)}`, { token: owner.token });
  assert(preserved.content.startsWith("Member-authored content"), "conflicting shared content must not be overwritten");
}
const messages = await call(`/v1/workspaces/${workspaceId}/messages`, { token: guest.token });
assert(messages.messages.length === 4, "both members should see both user and Franklin messages");

console.log(JSON.stringify({
  ok: true,
  workspaceId,
  memberCount: joined.workspace.members.length,
  messageCount: messages.messages.length,
  sandboxTasks: [firstTurn.task.id, secondTurn.task.id],
  stagedThenApplied: firstTurn.task.changes?.[0]?.path || null,
  sharedVersion: afterApply.version,
}, null, 2));
