// Real Electron windows, isolated profile, real update manager + IPC + preload.
// Only the release feed/installer bytes and OS installer launch are fixtures;
// no executable is installed and the agent backend cannot spend real funds.
import { _electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qa = await fs.mkdtemp(path.join(os.tmpdir(), "franklin-updates-native-"));
const entry = path.join(qa, "main.cjs");
await fs.writeFile(entry, `
const crypto = require('node:crypto');
const file = ${JSON.stringify(path.join(desktop, "electron/updates.cjs"))};
const original = require(file);
const binary = Buffer.from('Disposable native update fixture. Never execute.');
const digest = crypto.createHash('sha256').update(binary).digest('hex');
const version = '0.2.0-beta.999', tag = 'desktop-v' + version;
const root = 'https://github.com/BlockRunAI/Franklin/releases/download/' + tag + '/';
global.updateQa = { calls: [], opened: [], offline: false };
require.cache[file].exports = { ...original, createDesktopUpdater(options) {
  const manager = original.createDesktopUpdater({ ...options, enabled: true,
    fetchImpl: async (url) => {
      global.updateQa.calls.push(url);
      if (global.updateQa.offline) throw new Error('Simulated offline');
      if (url.startsWith('https://api.github.com/')) {
        const names = ['Franklin-' + version + '-arm64.dmg', 'Franklin.Setup.' + version + '.exe', 'SHA256SUMS.txt'];
        return new Response(JSON.stringify([{tag_name: tag, prerelease: true, draft: false, published_at: '2026-10-27T00:00:00Z',
          assets: names.map(name => ({ name, browser_download_url: root + name, state: 'uploaded', size: binary.length, digest: name.endsWith('.txt') ? undefined : 'sha256:' + digest }))
        }]));
      }
      if (url.endsWith('SHA256SUMS.txt')) return new Response(digest + '  Franklin-' + version + '-arm64.dmg\\n' + digest + '  Franklin.Setup.' + version + '.exe\\n');
      return new Response(binary);
    },
    openInstaller: async (file) => { global.updateQa.opened.push(file); return ''; },
  });
  global.updateQa.manager = manager; return manager;
}};
require(${JSON.stringify(path.join(desktop, "electron/main.cjs"))});
`);
const app = await _electron.launch({ executablePath: require("electron"), args: [entry, `--user-data-dir=${path.join(qa, "profile")}`], env: {
  ...process.env, HOME: qa, USERPROFILE: qa, ELECTRON_RUN_AS_NODE: "", FRANKLIN_DESKTOP_DEV_URL: "", FRANKLIN_USE_MOCK: "1",
  FRANKLIN_AGENT_PORT: "0", FRANKLIN_CLOUD_PORT: "0", FRANKLIN_WORK_DIR: path.join(qa, "workspace"), FRANKLIN_CLOUD_DATA_DIR: path.join(qa, "cloud"),
  FRANKLIN_CLOUD_ENABLE_REAL_AGENT: "0", FRANKLIN_CLOUD_FAKE_AGENT: "1", FRANKLIN_TEAM_FAKE_AGENT: "1", FRANKLIN_TEAM_CLOUD_URL: "http://127.0.0.1:1",
} });
const passed = [];
const check = async (name, run) => { await run(); passed.push(name); console.log("PASS " + name); };
let page;
try {
  await expect.poll(() => app.windows().find((p) => p.url().endsWith("/dist/index.html")), { timeout: 30_000 }).toBeTruthy();
  page = app.windows().find((p) => p.url().endsWith("/dist/index.html"));
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const menu = async () => { await page.getByRole("button", { name: "Settings", exact: true }).click(); return page.locator(".desktop-update-menu"); };
  await check("settings reads the Desktop version and startup automatically prompts for a newer release", async () => {
    const row = await menu(); await expect(row).toContainText("0.2.0-beta.6");
    expect(await app.evaluate(() => global.updateQa.calls.length)).toBe(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect.poll(() => app.evaluate(() => global.updateQa.calls.length), { timeout: 40_000 }).toBe(1);
    await expect(page.getByRole("dialog")).toContainText("0.2.0-beta.999");
    expect(await app.evaluate(() => global.updateQa.calls.length)).toBe(1);
    expect(await app.evaluate(() => global.updateQa.opened.length)).toBe(0);
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await (await menu()).click(); await expect(page.getByRole("dialog")).toBeVisible();
  });
  await check("native dialog downloads and verifies before a separate installer action", async () => {
    await page.getByRole("button", { name: "Download update", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open installer", exact: true })).toBeEnabled();
    expect(await app.evaluate(() => global.updateQa.opened.length)).toBe(0);
    await page.screenshot({ path: path.join(qa, "update-downloaded.png") });
    await page.getByRole("button", { name: "Open installer", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("The installer has been opened");
    expect(await app.evaluate(() => global.updateQa.opened.length)).toBe(1);
  });
  await check("Later persists and settings can reopen a dismissed update", async () => {
    await page.getByRole("button", { name: "Later", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("franklin-dismissed-update-v1"))).toBe("0.2.0-beta.999");
    await (await menu()).click(); await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  });
  await check("offline errors are visible and check again recovers", async () => {
    await app.evaluate(async () => { global.updateQa.offline = true; await global.updateQa.manager.check(); });
    // Opening settings retries a failed check, which is still offline here.
    await (await menu()).click(); await expect(page.getByRole("alert")).toContainText("connection");
    await app.evaluate(() => { global.updateQa.offline = false; });
    await page.getByRole("dialog").getByRole("button", { name: "Check for updates", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open installer", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
  });
  await check("Chinese copy and narrow dark settings retain readable aligned layout", async () => {
    await page.evaluate(() => { localStorage.setItem("franklin-try-ui-lang", "zh"); localStorage.setItem("franklin-webui-theme", "dark"); });
    await page.reload(); await page.setViewportSize({ width: 760, height: 700 });
    const toggle = page.locator(".try-chat-bar").getByRole("button", { name: "Toggle history", exact: true });
    if (!await page.getByRole("button", { name: "设置", exact: true }).isVisible()) await toggle.click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.locator(".desktop-update-menu")).toContainText("有新版本可用");
    await page.locator(".desktop-update-menu").click(); await expect(page.getByRole("dialog")).toContainText("打开安装包");
    const box = await page.getByRole("dialog").boundingBox(); expect(box.width).toBeLessThanOrEqual(480); expect(box.x).toBeGreaterThanOrEqual(20);
    expect(await page.getByRole("dialog").evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
    await page.screenshot({ path: path.join(qa, "update-chinese-dark.png") });
  });
  expect(errors).toEqual([]);
  await fs.writeFile(path.join(qa, "results.json"), JSON.stringify({ passed, errors, externalInstallerExecutions: 0, liveModelCalls: 0 }, null, 2));
  console.log(`Desktop update native QA: ${passed.length} passed; evidence ${qa}`);
} catch (error) { await page?.screenshot({ path: path.join(qa, "failure.png") }).catch(() => {}); console.error(`Evidence: ${qa}`); throw error; }
finally { await app.close(); }
