// Isolated interactive preview: real public prices, in-memory agent/wallet only.
import { _electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileArgument = process.argv.indexOf("--profile");
const profile = profileArgument < 0 ? await fs.mkdtemp(path.join(os.tmpdir(), "franklin-market-preview-")) : await fs.realpath(process.argv[profileArgument + 1]);
// Reuse only this harness's temporary profiles, never a real Desktop profile.
if (path.dirname(await fs.realpath(profile)) !== await fs.realpath(os.tmpdir()) || !/^franklin-market-preview-[A-Za-z0-9]+$/.test(path.basename(profile))) throw new Error("Expected an isolated market-preview profile in the temporary directory");
const app = await _electron.launch({
  executablePath: require("electron"),
  args: [path.join(desktop, "electron/main.cjs"), `--user-data-dir=${path.join(profile, "profile")}`],
  env: {
    ...process.env, ELECTRON_RUN_AS_NODE: "", FRANKLIN_DESKTOP_DEV_URL: "",
    FRANKLIN_USE_MOCK: "1", FRANKLIN_AGENT_PORT: "0", FRANKLIN_CLOUD_PORT: "0",
    FRANKLIN_WORK_DIR: path.join(profile, "workspace"), FRANKLIN_CLOUD_DATA_DIR: path.join(profile, "cloud"),
    FRANKLIN_CLOUD_ENABLE_REAL_AGENT: "0", FRANKLIN_CLOUD_FAKE_AGENT: "1", FRANKLIN_TEAM_FAKE_AGENT: "1",
    FRANKLIN_TEAM_CLOUD_URL: "http://127.0.0.1:1",
  },
});
const startupLogs = [];
app.process().stdout?.on("data", (chunk) => startupLogs.push(String(chunk)));
app.process().stderr?.on("data", (chunk) => startupLogs.push(String(chunk)));
try {
  await expect.poll(() => app.windows().find((page) => page.url().endsWith("/dist/index.html")), { timeout: 25000 }).toBeTruthy();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() && window.webContents.getURL().endsWith("/dist/index.html"))), { timeout: 25000 }).toBe(true);
  const page = app.windows().find((page) => page.url().endsWith("/dist/index.html"));
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:\d+\/agent/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.kind === "agent.send") {
        socket.send(JSON.stringify({ id: message.id, kind: "agent.text", payload: { sessionId: "preview", text: "【界面演示 · 未调用模型】已收到你的消息。你可以继续切换 BTC / ETH、引用行情并追问，图表会一直保留在旁边。当前回复用于体验对话布局，没有执行分析工具、支付或交易。" } }));
        socket.send(JSON.stringify({ id: message.id, kind: "agent.done", payload: { sessionId: "preview", costUsd: 0 } }));
        return;
      }
      const payload = message.kind === "wallet.info" ? { address: "0x0000000000000000000000000000000000000001", chain: "base", balanceUsd: 0 }
        : message.kind === "models.list" ? { models: [{ id: "anthropic/claude-opus-4.8", label: "演示模式 · 未调用模型", free: true, group: "Preview" }] }
        : message.kind === "session.list" ? { sessions: [] } : { ok: true };
      socket.send(JSON.stringify({ id: message.id, kind: "response", payload }));
    });
  });
  await page.evaluate(() => { localStorage.setItem("franklin-try-ui-lang", "zh"); localStorage.setItem("franklin-webui-theme", "dark"); });
  await page.reload();
  await page.getByRole("button", { name: "市场", exact: true }).click();
  // The retained profile may have been left in conversation-only layout.
  // Open a visible chart for this review without changing any conversation.
  const split = page.getByRole("button", { name: "双栏", exact: true });
  if (await split.isVisible()) await split.click();
  else await page.getByRole("button", { name: "看盘", exact: true }).click();
  await page.evaluate(() => {
    document.title = "Franklin · 本地行情预览（交易关闭）";
    const note = document.createElement("div");
    note.textContent = "本地预览 · 真实行情 / 模拟 Agent · 交易关闭";
    note.style.cssText = "flex-shrink:0;font-size:11px;color:var(--fg-muted);background:var(--bg-alt);border-bottom:1px solid var(--border);padding:5px 18px;text-align:right;";
    document.querySelector(".try-chat-bar")?.insertAdjacentElement("afterend", note);
  });
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows().find((window) => window.isVisible());
    window?.setTitle("Franklin · 本地行情预览（交易关闭）");
    window?.show(); window?.focus();
  });
  await expect(page.locator(".market-chart canvas").first()).toBeVisible({ timeout: 25000 });
  console.log(`Desktop preview ready; isolated profile: ${profile}`);
  await new Promise((resolve) => app.once("close", resolve));
} catch (error) {
  console.error(`Preview startup exit: ${app.process().exitCode}; ${startupLogs.join("").slice(-4000)}`);
  await app.close();
  throw error;
}
