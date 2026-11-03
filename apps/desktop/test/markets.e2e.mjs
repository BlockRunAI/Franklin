// Runs the compiled file:// renderer in the real Electron shell. Isolated app data,
// an in-memory backend, and intercepted agent messages prevent any real spending.
// --live reads only Kraken public market data; the default uses deterministic fixtures.
import { _electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qa = await fs.mkdtemp(path.join(os.tmpdir(), "franklin-markets-e2e-"));
const live = process.argv.includes("--live");
const app = await _electron.launch({
  executablePath: require("electron"),
  args: [path.join(desktop, "electron/main.cjs"), `--user-data-dir=${path.join(qa, "profile")}`],
  env: {
    ...process.env, ELECTRON_RUN_AS_NODE: "", FRANKLIN_DESKTOP_DEV_URL: "",
    FRANKLIN_USE_MOCK: "1", FRANKLIN_AGENT_PORT: "0", FRANKLIN_CLOUD_PORT: "0",
    FRANKLIN_WORK_DIR: path.join(qa, "workspace"), FRANKLIN_CLOUD_DATA_DIR: path.join(qa, "cloud"),
    FRANKLIN_CLOUD_ENABLE_REAL_AGENT: "0", FRANKLIN_CLOUD_FAKE_AGENT: "1", FRANKLIN_TEAM_FAKE_AGENT: "1",
    FRANKLIN_TEAM_CLOUD_URL: "http://127.0.0.1:1",
  },
});
const passed = [];
const check = async (name, action) => { await action(); passed.push(name); console.log(`PASS ${name}`); };
let sends = 0;
let allowMockTurn = false, mockTurns = 0;
let holdMockTurn = false, pendingTurn;
const sentTurns = [];
const marketSockets = new Set();
const agentMessages = [];
const restRequests = [];
let streamsEnabled = true, restEnabled = true, delayed = false;
let initialHistory = true;
const t = Math.floor(Date.now() / 3_600_000) * 3600;
const values = { BTC: 68000, ETH: 3500 };
const ticker = (symbol, last = values[symbol.split("/")[0]]) => ({ symbol, last, high: last + 300, low: last - 300, volume: 1234.56, change: 100, change_pct: symbol === "BTC/USD" ? 1.25 : -0.5 });
const restQuotes = () => ({ error: [], result: Object.fromEntries(["BTC", "ETH"].map((key) => [key === "BTC" ? "XXBTZUSD" : "XETHZUSD", { c: [String(values[key])], h: ["0", String(values[key] + 300)], l: ["0", String(values[key] - 300)], v: ["0", "1234.56"], o: "1" }])) });
const candles = (market, interval) => {
  const end = Math.floor(t / (interval * 60)) * interval * 60;
  return { error: [], result: { [market === "BTC" ? "XXBTZUSD" : "XETHZUSD"]: Array.from({ length: 80 }, (_, i) => {
    const close = values[market] - (79 - i) * 2;
    return [end - (79 - i) * interval * 60, String(close - 5), String(close + 10), String(close - 10), String(close), String(close), "50", 10];
  }), last: end } };
};

try {
  await expect.poll(() => app.windows().find((page) => page.url().endsWith("/dist/index.html")), { timeout: 25000 }).toBeTruthy();
  // Wait until native startup has shown the renderer before installing routes.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() && window.webContents.getURL().endsWith("/dist/index.html"))), { timeout: 25000 }).toBe(true);
  const page = app.windows().find((page) => page.url().endsWith("/dist/index.html"));
  const openSidebar = async () => {
    if (!await page.locator(".try-sidebar").evaluate((sidebar) => sidebar.classList.contains("is-open"))) await page.locator(".try-chat-bar").getByRole("button", { name: "Toggle history", exact: true }).click();
    await expect(page.locator(".try-sidebar")).toHaveClass(/is-open/);
  };
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:\d+\/agent/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)); agentMessages.push(message.kind);
      if (message.kind === "agent.send") {
        sends++;
        if (!allowMockTurn || live) throw new Error("Unexpected agent execution");
        mockTurns++;
        sentTurns.push(message.payload);
        // Complete a deterministic zero-cost conversation entirely in the test
        // driver. No backend model/tool, key, payment or order is invoked.
        socket.send(JSON.stringify({ id: message.id, kind: "agent.text", payload: { sessionId: "qa-market", text: "QA response: market context received; chart remains open." } }));
        const emit = (kind, payload) => socket.send(JSON.stringify({ id: message.id, kind, payload: { sessionId: "qa-market", ...payload } }));
        if (holdMockTurn) pendingTurn = emit;
        else emit("agent.done", { costUsd: 0 });
        return;
      }
      const payload = message.kind === "wallet.info" ? { address: "0x0000000000000000000000000000000000000001", chain: "base", balanceUsd: 0 }
        : message.kind === "models.list" ? { models: [{ id: "nvidia/nemotron-nano-9b-v2", label: "QA model", free: true, group: "Free" }] }
        : message.kind === "session.list" ? { sessions: [] } : { ok: true };
      socket.send(JSON.stringify({ id: message.id, kind: "response", payload }));
    });
  });
  if (!live) {
    await page.route("https://api.kraken.com/0/public/**", async (route) => {
      const url = new URL(route.request().url()); restRequests.push(url.href);
      if (!restEnabled) { await route.fulfill({ status: 503, body: "unavailable", headers: { "access-control-allow-origin": "*" } }); return; }
      if (initialHistory && url.pathname.endsWith("OHLC")) {
        initialHistory = false;
        // Exercise the real-world ordering: a short stream snapshot arrives
        // before the complete REST history, rather than testing REST alone.
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      if (delayed && url.searchParams.get("pair") === "ETHUSD") await new Promise((resolve) => setTimeout(resolve, 800));
      const body = url.pathname.endsWith("Ticker") ? restQuotes() : candles(url.searchParams.get("pair") === "ETHUSD" ? "ETH" : "BTC", Number(url.searchParams.get("interval")));
      await route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } }).catch(() => {});
    });
    await page.routeWebSocket("wss://ws.kraken.com/v2", (socket) => {
      if (!streamsEnabled) { socket.close(); return; }
      marketSockets.add(socket);
      if (process.env.DEBUG_MARKETS) console.log("market socket routed");
      socket.onClose(() => marketSockets.delete(socket));
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (process.env.DEBUG_MARKETS) console.log("market subscription", message);
        if (message.method !== "subscribe") return;
        socket.send(JSON.stringify({ method: "subscribe", success: true }));
        if (message.params.channel === "ticker") socket.send(JSON.stringify({ channel: "ticker", type: "snapshot", data: [ticker("BTC/USD"), ticker("ETH/USD")] }));
        if (message.params.channel === "ohlc") {
          const symbol = message.params.symbol[0], interval = message.params.interval;
          const market = symbol.split("/")[0];
          const end = Math.floor(t / (interval * 60)) * interval * 60;
          socket.send(JSON.stringify({ channel: "ohlc", type: "snapshot", data: [{ symbol, interval, interval_begin: new Date(end * 1000).toISOString(), open: values[market] - 5, high: values[market] + 10, low: values[market] - 10, close: values[market], volume: 50 }] }));
        }
      });
    });
  }

  await page.reload(); // Apply context routes even if the first renderer connected during startup.
  await page.evaluate(() => {
    const original = document.startViewTransition.bind(document);
    window.__workspaceMotion = [];
    document.startViewTransition = (callback) => {
      const transition = original(callback);
      const entry = { groups: [], error: null, finished: transition.finished };
      window.__workspaceMotion.push(entry);
      transition.ready.then(() => {
        entry.groups = document.getAnimations().flatMap((animation) => {
          const effect = animation.effect;
          return effect?.pseudoElement ? [{ pseudo: effect.pseudoElement, objectFit: getComputedStyle(document.documentElement, effect.pseudoElement).objectFit, duration: effect.getTiming().duration, frames: effect.getKeyframes().map((frame) => ({ width: frame.width, transform: frame.transform, opacity: frame.opacity })) }] : [];
        });
      }).catch((error) => { entry.error = error.name; });
      return transition;
    };
  });
  await check("existing chat and project/agent navigation remain available", async () => {
    await expect(page.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New project", exact: true })).toBeVisible();
    await page.locator("textarea").fill("Keep my existing draft.");
  });
  await check("settings enter a focused Trading Mode and restore the prior creative workspace on exit", async () => {
    await page.getByRole("button", { name: "Video", exact: true }).click();
    const videoModel = await page.locator(".try-select-current").textContent();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /^Trading Mode/ })).toHaveAttribute("aria-checked", "false");
    await page.getByRole("menuitemcheckbox", { name: /^Trading Mode/ }).click();
    await expect(page.locator(".try-shell")).toHaveClass(/is-trading-mode/);
    await expect(page.getByRole("button", { name: "Exit Trading Mode", exact: true })).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("Keep my existing draft.");
    await page.locator(".try-select-btn").click();
    await expect(page.getByRole("option", { name: /QA model/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Seedance|Sora|Music|Image/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await openSidebar();
    for (const name of ["Gallery", "Marketplace", "Agents", "New project", "Install CLI"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /^Trading Mode/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemcheckbox", { name: /^Trading Mode/ }).click();
    await expect(page.locator(".try-shell")).not.toHaveClass(/is-trading-mode/);
    await expect(page.locator(".try-select-current")).toHaveText(videoModel);
    await expect(page.getByRole("button", { name: "Back to chat", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gallery", exact: true })).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("Keep my existing draft.");
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    expect(sends).toBe(0);
  });
  await page.getByRole("button", { name: "Markets", exact: true }).click();
  await check("public BTC and ETH quotes with chart load in packaged file:// renderer", async () => {
    await expect(page.locator(".market-quote-price").first()).not.toHaveText("—", { timeout: 25000 });
    await expect(page.locator(".market-quote-price").last()).not.toHaveText("—", { timeout: 25000 });
    await expect(page.locator(".market-chart canvas").first()).toBeVisible({ timeout: 25000 });
    await expect(page.locator(".market-chart-stage")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".market-source")).toContainText("Kraken spot · USD");
    await expect(page.locator(".market-status")).toHaveText("Live", { timeout: 25000 });
  });
  if (!live) await check("real-time price update and signed 24h movement render", async () => {
    for (const socket of marketSockets) socket.send(JSON.stringify({ channel: "ticker", type: "update", data: [ticker("BTC/USD", 68123)] }));
    await expect(page.locator(".market-quote-price").first()).toHaveText("$68,123.00");
    await expect(page.locator(".market-change").last()).toContainText("-0.50%");
  });
  if (!live) await check("stream candles arriving before history render, then keep updating", async () => {
    for (const socket of marketSockets) socket.send(JSON.stringify({ channel: "ohlc", type: "update", data: [{ symbol: "BTC/USD", interval: 60, interval_begin: new Date(t * 1000).toISOString(), open: 67995, high: 68150, low: 67990, close: 68125, volume: 55 }] }));
    await expect(page.locator(".market-ohlc")).toContainText("$68,125.00");
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
  });
  await check(`ETH selection and ${live ? "two live" : "six"} candle intervals load the correct history`, async () => {
    await page.getByRole("button", { name: /Ethereum/ }).click();
    for (const interval of live ? ["5m", "1h"] : ["1m", "5m", "15m", "1h", "4h", "1D"]) {
      await page.getByRole("button", { name: interval, exact: true }).click();
      await expect(page.locator(".market-chart-toolbar h2")).toHaveText("ETH/USD");
      await expect(page.locator(".market-chart canvas").first()).toBeVisible({ timeout: 20000 });
      if (!live) await expect(page.locator(".market-ohlc")).toContainText("$3,500.00");
    }
  });
  await check("candle data table is readable without using canvas", async () => {
    await page.getByText("View candle data", { exact: true }).click();
    await expect(page.getByRole("table", { name: "Latest 20 candles · UTC" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Latest 20 candles · UTC" }).locator("tbody tr")).toHaveCount(20);
  });
  await check("chart and conversation stay mounted across focus modes and keyboard resize", async () => {
    await expect(page.locator("textarea")).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("Keep my existing draft.");
    await page.getByRole("button", { name: "Market", exact: true }).click();
    await expect(page.locator("textarea")).toBeHidden();
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.locator(".market-chart canvas").first()).toBeHidden();
    await expect(page.locator("textarea")).toHaveValue("Keep my existing draft.");
    await page.getByRole("button", { name: "Side by side", exact: true }).click();
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    const separator = page.getByRole("separator", { name: "Resize conversation and market panels" });
    await separator.focus(); await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "42");
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "40");
    await expect.poll(() => page.locator(".market-quote").evaluateAll((cards) => cards.every((card) => card.scrollWidth <= card.clientWidth))).toBe(true);
    await separator.focus(); await page.keyboard.press("End");
    await expect.poll(() => page.locator(".market-quote").evaluateAll((cards) => cards.every((card) => card.scrollWidth <= card.clientWidth))).toBe(true);
    await separator.focus(); await page.keyboard.press("Home");
    await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "40");
  });
  await check("native pane transitions animate geometry, accept rapid clicks and honor reduced motion", async () => {
    await page.getByRole("button", { name: "Market", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__workspaceMotion.some((entry) => entry.groups.some((group) => group.pseudo === "::view-transition-group(franklin-market)" && group.duration > 0 && group.duration <= 300 && new Set(group.frames.map((frame) => frame.width).filter(Boolean)).size > 1)))).toBe(true);
    await page.evaluate(() => Promise.all(window.__workspaceMotion.map((entry) => entry.finished)));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const count = await page.evaluate(() => window.__workspaceMotion.length);
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.locator(".trading-workspace")).toHaveAttribute("data-layout", "chat");
    expect(await page.evaluate(() => window.__workspaceMotion.length)).toBe(count);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll(".trading-layout-controls button")];
      for (const title of ["Market", "Conversation", "Side by side"]) buttons.find((button) => button.title === title).click();
    });
    await expect(page.locator(".trading-workspace")).toHaveAttribute("data-layout", "split");
    await page.evaluate(() => Promise.all(window.__workspaceMotion.map((entry) => entry.finished)));
    await expect(page.locator("textarea")).toHaveValue("Keep my existing draft.");
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    const transitionErrors = await page.evaluate(() => window.__workspaceMotion.map((entry) => entry.error).filter((error) => error && error !== "AbortError"));
    expect(transitionErrors).toEqual([]);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await expect.poll(() => page.locator(".trading-layout-controls button[aria-pressed=true]").evaluate((button) => getComputedStyle(button).color)).toBe("rgb(231, 189, 98)");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  });
  if (!live) {
    await check("slow abandoned ETH request cannot overwrite a newer BTC chart", async () => {
      delayed = true;
      await page.getByRole("button", { name: "5m", exact: true }).click();
      await page.getByRole("button", { name: /Bitcoin/ }).click();
      await expect(page.locator(".market-chart-toolbar h2")).toHaveText("BTC/USD");
      await expect(page.locator(".market-ohlc")).toContainText("$68,000.00");
      await page.waitForTimeout(1000);
      await expect(page.locator(".market-ohlc")).not.toContainText("$3,500.00");
      delayed = false;
    });
    await check("disconnected stream falls back to REST and recovers after reconnect", async () => {
      streamsEnabled = false;
      for (const socket of [...marketSockets]) socket.close();
      await expect(page.locator(".market-status")).toHaveText("Public API · 15s polling", { timeout: 12000 });
      await expect(page.locator(".market-change").first()).toContainText("Unavailable");
      streamsEnabled = true;
      await page.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect(page.locator(".market-status")).toHaveText("Live");
    });
    await check("complete outage shows errors, retries and no fabricated zero prices", async () => {
      streamsEnabled = false; restEnabled = false;
      await page.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect(page.getByText("Prices could not be refreshed. Reconnecting automatically.")).toBeVisible();
      await expect(page.getByText("No candle data yet. Check your connection and retry.")).toBeVisible();
      await expect(page.locator(".market-quote-price").first()).toHaveText("—");
      streamsEnabled = true; restEnabled = true;
      await page.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    });
  }
  await check("dark theme and minimum Desktop window width do not overflow", async () => {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible()).setContentSize(720, 650));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Market", exact: true }).click();
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
    await page.getByRole("button", { name: "Market", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible()).setContentSize(720, 480));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settingsBounds = await page.getByRole("menu").evaluate((menu) => {
      const rect = menu.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    expect(settingsBounds.left).toBeGreaterThanOrEqual(0);
    expect(settingsBounds.top).toBeGreaterThanOrEqual(0);
    expect(settingsBounds.right).toBeLessThanOrEqual(settingsBounds.width);
    expect(settingsBounds.bottom).toBeLessThanOrEqual(settingsBounds.height);
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await page.keyboard.press("Escape");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible()).setContentSize(720, 650));
    await page.locator(".try-chat-bar").getByRole("button", { name: "Toggle history", exact: true }).click();
    await page.locator(".try-sidebar-scrim").click({ position: { x: 650, y: 100 } });
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible()).setContentSize(1180, 800));
    await page.getByRole("button", { name: "Side by side", exact: true }).click();
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  });
  await check("analysis action appends context to draft without running the agent", async () => {
    await page.getByRole("button", { name: "Reference market", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue(/Keep my existing draft\./);
    await expect(page.locator("textarea")).toHaveValue(/\[Kraken (BTC|ETH)\/USD · /);
    await expect(page.locator("textarea")).toHaveValue(/Do not place orders or sign transactions/);
    expect(sends).toBe(0);
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    await expect(page.locator("textarea")).toBeFocused();
  });
  await check("repeated references preserve the original snapshot and selecting another asset never rewrites it", async () => {
    const original = await page.locator("textarea").inputValue();
    await page.getByRole("button", { name: "View draft reference", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue(original);
    const referencedBTC = original.includes("[Kraken BTC/USD");
    await page.getByRole("button", { name: referencedBTC ? /Ethereum/ : /Bitcoin/ }).click();
    await expect(page.locator(".market-chart-stage")).toHaveAttribute("aria-busy", "false", { timeout: 20000 });
    await expect(page.locator("textarea")).toHaveValue(original);
    await page.getByRole("button", { name: "Reference market", exact: true }).click();
    const combined = await page.locator("textarea").inputValue();
    expect(combined.startsWith(original)).toBe(true);
    expect(combined).toContain("[Kraken BTC/USD");
    expect(combined).toContain("[Kraken ETH/USD");
    await page.getByRole("button", { name: "View draft reference", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue(combined);
    expect(sends).toBe(0);
  });
  await check("Chinese composition Enter does not send a message", async () => {
    const draft = await page.locator("textarea").inputValue();
    await page.locator("textarea").dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(page.locator("textarea")).toHaveValue(draft);
    expect(sends).toBe(0);
  });
  if (!live) await check("a zero-cost mocked conversation completes while the chart stays visible", async () => {
    allowMockTurn = true;
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".try-msg-assistant")).toContainText("QA response: market context received; chart remains open.");
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("");
    expect(mockTurns).toBe(1);
    allowMockTurn = false;
  });
  if (!live) await check("message typography stays compact across split, full conversation and minimum window without snapshot text zoom", async () => {
    const assertText = async () => {
      const sizes = await page.locator(".try-msg-body").evaluateAll((messages) => messages.map((message) => ({ font: getComputedStyle(message).fontSize, leading: getComputedStyle(message).lineHeight })));
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.every(({ font, leading }) => font === "14px" && Number.parseFloat(leading) <= 23)).toBe(true);
      await expect(page.locator("textarea")).toHaveCSS("font-size", "14px");
      const column = await page.evaluate(() => {
        const context = document.querySelector(".trading-composer-context");
        if (!context) return null;
        const messages = document.querySelector(".try-messages");
        const composer = document.querySelector(".try-composer").getBoundingClientRect();
        return { context: context.getBoundingClientRect().left, composer: composer.left, message: messages.getBoundingClientRect().left + parseFloat(getComputedStyle(messages).paddingLeft) };
      });
      if (column) {
        expect(Math.abs(column.context - column.composer)).toBeLessThan(1);
        expect(Math.abs(column.message - column.composer)).toBeLessThan(1);
      }
    };
    await assertText();
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await assertText();
    await page.getByRole("button", { name: "Side by side", exact: true }).click();
    const divider = page.getByRole("separator");
    await divider.focus(); await page.keyboard.press("End");
    await assertText();
    await divider.focus(); await page.keyboard.press("Home");
    await assertText();
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible()).setContentSize(720, 650));
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
    await assertText();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible()).setContentSize(1180, 800));
    await page.getByRole("button", { name: "Exit Trading Mode", exact: true }).click();
    await expect(page.locator(".try-shell")).not.toHaveClass(/is-trading-mode/);
    await assertText();
    await openSidebar();
    await page.locator(".try-sidebar").getByRole("button", { name: "Markets", exact: true }).click();
    await page.getByRole("button", { name: "Side by side", exact: true }).click();
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    await assertText();
    const alignment = await page.evaluate(() => {
      const messages = document.querySelector(".try-messages");
      const composer = document.querySelector(".try-composer").getBoundingClientRect();
      const context = document.querySelector(".trading-composer-context").getBoundingClientRect();
      const messageLeft = messages.getBoundingClientRect().left + parseFloat(getComputedStyle(messages).paddingLeft);
      return { composer: composer.left, context: context.left, messages: messageLeft };
    });
    expect(Math.abs(alignment.composer - alignment.context)).toBeLessThan(1);
    expect(Math.abs(alignment.composer - alignment.messages)).toBeLessThan(1);
    expect(await page.evaluate(() => window.__workspaceMotion.some((entry) => entry.groups.some((group) => group.pseudo === "::view-transition-new(franklin-conversation)" && group.objectFit === "none")))).toBe(true);
  });
  if (!live) await check("streaming allows a next draft; stop and regenerate preserve it and continuation stays in the same conversation", async () => {
    allowMockTurn = true; holdMockTurn = true;
    await page.locator("textarea").fill("Follow-up in the same conversation");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Exit Trading Mode", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /^Trading Mode/ })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.locator("textarea")).toBeEditable();
    await page.locator("textarea").fill("Next question drafted during streaming");
    await page.locator("textarea").press("Enter");
    expect(sends).toBe(2);
    for (const name of ["Market", "Conversation", "Side by side"]) await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: /Bitcoin/ }).click();
    await expect(page.locator("textarea")).toHaveValue("Next question drafted during streaming");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    pendingTurn("agent.text", { text: "LATE-CANCELLED-TEXT" });
    pendingTurn("agent.done", { costUsd: 0 });
    holdMockTurn = false;
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("Next question drafted during streaming");
    await expect(page.locator(".try-msg-assistant").last()).not.toContainText("LATE-CANCELLED-TEXT");
    expect(sends).toBe(3);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    expect(sends).toBe(4);
    expect(new Set(sentTurns.map((turn) => turn.convId)).size).toBe(1);
    expect(sentTurns[2].text).toBe(sentTurns[1].text);
    expect(sentTurns[3].text).toBe("Next question drafted during streaming");
    allowMockTurn = false;
  });
  if (!live) await check("a failed reply can regenerate without losing the next draft or chart", async () => {
    allowMockTurn = true; holdMockTurn = true;
    await page.locator("textarea").fill("Question with a recoverable connection error");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.locator("textarea").fill("Keep my next draft after the error");
    pendingTurn("agent.error", { message: "QA simulated temporary error" });
    await expect(page.locator(".try-error")).toContainText("QA simulated temporary error");
    holdMockTurn = false;
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(page.locator(".try-error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    await expect(page.locator("textarea")).toHaveValue("Keep my next draft after the error");
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    expect(sends).toBe(6);
    expect(sentTurns[5].text).toBe(sentTurns[4].text);
    allowMockTurn = false;
  });
  await check("closing and reopening the market keeps selection and the conversation draft", async () => {
    await page.getByRole("button", { name: /Ethereum/ }).click();
    await page.getByRole("button", { name: "1D", exact: true }).click();
    const draft = await page.locator("textarea").inputValue();
    await page.getByRole("button", { name: "Exit Trading Mode", exact: true }).click();
    await expect(page.locator(".try-shell")).not.toHaveClass(/is-trading-mode/);
    await openSidebar();
    await page.locator(".try-sidebar").getByRole("button", { name: "Markets", exact: true }).click();
    await expect(page.locator(".market-chart-toolbar h2")).toHaveText("ETH/USD");
    await expect(page.getByRole("button", { name: "1D", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".trading-composer-context")).toContainText("ETH/USD · 1D");
    await expect(page.locator("textarea")).toHaveValue(draft);
  });
  if (!live) await check("new conversation and history selection keep the same chart workspace", async () => {
    await page.locator(".trading-rail").getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.locator(".try-msg-assistant")).toHaveCount(0);
    await page.locator(".try-chat-bar").getByRole("button", { name: "Toggle history", exact: true }).click();
    await page.locator(".try-history-item").first().click();
    await page.locator(".try-chat-bar").getByRole("button", { name: "Toggle history", exact: true }).click();
    await expect(page.locator(".try-msg-assistant")).toHaveCount(4);
    await expect(page.locator(".market-chart-toolbar h2")).toHaveText("ETH/USD");
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
  });
  await check("leaving Markets closes its stream and no renderer errors occur", async () => {
    await expect(page.locator(".market-chart canvas").first()).toBeVisible();
    await page.getByRole("button", { name: "Market", exact: true }).click();
    await page.getByRole("button", { name: "Exit Trading Mode", exact: true }).click();
    await expect(page.locator(".try-shell")).not.toHaveClass(/is-trading-mode/);
    await expect(page.locator("textarea")).toBeVisible();
    if (!live) await expect.poll(() => marketSockets.size).toBe(0);
    expect(errors).toEqual([]);
    expect(sends).toBe(live ? 0 : 6);
    expect(mockTurns).toBe(live ? 0 : 6);
  });
  await check("Trading Mode preference restores the focused workspace after a renderer restart", async () => {
    await openSidebar();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: /^Trading Mode/ }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("franklin-desktop-trading-mode-v1"))).toBe("true");
    await page.reload();
    await expect(page.locator(".try-shell")).toHaveClass(/is-trading-mode/);
    await expect(page.locator(".market-chart-toolbar h2")).toHaveText("ETH/USD");
    await expect(page.getByRole("button", { name: "1D", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Gallery", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: /^Trading Mode/ }).click();
    await expect(page.getByRole("button", { name: "Gallery", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("franklin-desktop-trading-mode-v1"))).toBe("false");
    expect(errors).toEqual([]);
    expect(sends).toBe(live ? 0 : 6);
  });
  // Save a clean Chinese preview as a review artifact.
  await page.evaluate(() => { localStorage.setItem("franklin-try-ui-lang", "zh"); localStorage.setItem("franklin-webui-theme", "dark"); localStorage.setItem("franklin-trading-layout-v1", JSON.stringify({ layout: "split", width: 40 })); });
  await page.reload();
  await page.getByRole("button", { name: "市场", exact: true }).click();
  await expect(page.locator(".market-chart-toolbar h2")).toHaveText("ETH/USD");
  await expect(page.getByRole("button", { name: "日线", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".market-chart canvas").first()).toBeVisible({ timeout: 25000 });
  if (live) await expect(page.locator(".market-status")).toHaveText("实时", { timeout: 25000 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.screenshot({ path: path.join(qa, live ? "markets-live.png" : "markets-fixture.png") });
  await fs.writeFile(path.join(qa, "results.json"), JSON.stringify({ live, passed, restRequests, errors, agentSends: sends, mockedAgentTurns: mockTurns, unexpectedAgentSends: sends - mockTurns }, null, 2));
  console.log(JSON.stringify({ passed: passed.length, live, artifacts: qa, agentSends: sends, mockedAgentTurns: mockTurns, unexpectedAgentSends: sends - mockTurns }));
} catch (error) {
  const page = app.windows().find((page) => page.url().endsWith("/dist/index.html"));
  if (page) {
    await page.screenshot({ path: path.join(qa, "failure.png") }).catch(() => {});
    await fs.writeFile(path.join(qa, "failure.txt"), await page.locator("body").innerText());
  }
  console.error(`Artifacts: ${qa}`);
  throw error;
} finally { await app.close(); }
