const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createStudioRuntimeManager } = require("../electron/studio-runtime.cjs");

test("studio runtime manager starts, reuses, and stops a long-running adapter", async () => {
  const manager = createStudioRuntimeManager({ readyDelayMs: 20 });
  const input = {
    id: "codex",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: process.env,
  };

  const started = await manager.start(input);
  assert.deepEqual(started, { ok: true, running: true });
  assert.equal(manager.isRunning("codex"), true);
  assert.deepEqual(await manager.start(input), { ok: true, running: true });
  assert.deepEqual(await manager.stop("codex"), { ok: true, running: false });
  assert.equal(manager.isRunning("codex"), false);
});

test("studio runtime manager reports startup failures", async () => {
  const manager = createStudioRuntimeManager({ readyDelayMs: 20 });
  const result = await manager.start({
    id: "codex",
    executable: `${process.execPath}.missing`,
    args: [],
    cwd: process.cwd(),
    env: process.env,
  });
  assert.equal(result.ok, false);
  assert.equal(result.running, false);
  assert.match(result.error, /ENOENT|spawn/);
});
