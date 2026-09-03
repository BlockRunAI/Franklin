const { spawn } = require("node:child_process");

function createStudioRuntimeManager({ spawnProcess = spawn, readyDelayMs = 150 } = {}) {
  const processes = new Map();

  function isRunning(id) {
    const child = processes.get(id);
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  async function start({ id, executable, args, cwd, env }) {
    if (isRunning(id)) return { ok: true, running: true };

    let child;
    try {
      child = spawnProcess(executable, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, running: false, error: String(error?.message || error) };
    }

    processes.set(id, child);
    child.stdout?.resume();
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    child.once("exit", () => {
      if (processes.get(id) === child) processes.delete(id);
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", (error) => {
        if (processes.get(id) === child) processes.delete(id);
        finish({ ok: false, running: false, error: String(error?.message || error) });
      });
      child.once("exit", (code) => {
        finish({
          ok: false,
          running: false,
          error: stderr.trim() || `Runtime exited during startup (${code})`,
        });
      });
      child.once("spawn", () => {
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) finish({ ok: true, running: true });
        }, readyDelayMs);
      });
    });
  }

  async function stop(id) {
    const child = processes.get(id);
    if (!child || child.exitCode !== null) {
      processes.delete(id);
      return { ok: true, running: false };
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    if (child.exitCode === null) child.kill("SIGKILL");
    processes.delete(id);
    return { ok: true, running: false };
  }

  function stopAll() {
    for (const child of processes.values()) {
      if (child.exitCode === null) child.kill();
    }
    processes.clear();
  }

  return { isRunning, start, stop, stopAll };
}

module.exports = { createStudioRuntimeManager };
