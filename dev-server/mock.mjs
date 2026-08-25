// Mock CLI agent server for UI development. Speaks the same wire protocol
// (src/lib/wire.ts) the real Franklin CLI server will speak, so the UI is
// developed against the contract from day one.
//
// Behavior:
//   - In-memory session list (3 fake conversations on startup)
//   - agent.send fakes a streaming reply: 3 step events, then text streamed
//     char-by-char with ~20 ms delay, then agent.done
//   - wallet.info returns a fake Base address + balance
//   - models.list returns the same lineup franklin-run uses
//   - permission asks: 50% of "Bash" tool calls trigger a permissionAsk so
//     the UI's allow/always/deny flow is exercised

import { WebSocketServer } from "ws";
import http from "node:http";

const PORT = Number(process.env.FRANKLIN_AGENT_PORT) || 3737;

// ── Fake state ─────────────────────────────────────────────────────────────

const sessions = [
  mkSession("BTC research brief", "Pull a live BTC research brief with cited on-chain sources"),
  mkSession("Polymarket smart money", "Show me where smart money is positioning on Polymarket"),
  mkSession("Coffee brand photos", "Generate premium product photos for my coffee brand"),
];

const wallet = {
  address: "0xC8DA56C0a16E6E9b4eFc1F84d50B5F9b9b21F59c6",
  chain: "base",
  balanceUsd: 12.43,
};

const models = [
  { id: "nvidia/deepseek-v4-flash", label: "DeepSeek V4 Flash", free: true, group: "Free" },
  { id: "nvidia/qwen3-coder-480b", label: "Qwen3 Coder 480B", free: true, group: "Free" },
  { id: "nvidia/llama-4-maverick", label: "Llama 4 Maverick", free: true, group: "Free" },
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", free: false, group: "Premium frontier" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", free: false, group: "Premium frontier" },
  { id: "openai/gpt-5.5", label: "GPT-5.5", free: false, group: "Premium frontier" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", free: false, group: "Reasoning" },
  { id: "anthropic/claude-haiku-4.5-20251001", label: "Claude Haiku 4.5", free: false, group: "Budget" },
];

function mkSession(title, lastUser) {
  const id = `sess-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  return {
    id,
    title,
    createdAt: now - Math.floor(Math.random() * 86_400_000),
    updatedAt: now - Math.floor(Math.random() * 3_600_000),
    messageCount: 2,
    lastModel: "anthropic/claude-sonnet-4.6",
    messages: [
      { role: "user", content: lastUser, kind: "text" },
      { role: "assistant", content: "Mock CLI: this is what the real Franklin agent would have answered.", kind: "text" },
    ],
  };
}

// ── HTTP shell (for /api routes the CLI server will host) ──────────────────

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});

// ── WebSocket router ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: "/agent" });

wss.on("connection", (ws) => {
  console.log("[mock] client connected");
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handle(ws, msg);
  });
  ws.on("close", () => console.log("[mock] client disconnected"));
});

function send(ws, id, kind, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ id, kind, payload }));
}

function handle(ws, msg) {
  const { id, kind, payload } = msg;
  switch (kind) {
    case "session.list":
      return send(ws, id, "response", { sessions: sessions.map(stripMessages) });
    case "session.load": {
      const s = sessions.find((x) => x.id === payload.id);
      return send(ws, id, "response", { messages: s ? s.messages : [] });
    }
    case "session.delete": {
      const idx = sessions.findIndex((x) => x.id === payload.id);
      if (idx >= 0) sessions.splice(idx, 1);
      send(ws, id, "response", { ok: true });
      broadcastSessionEvent(ws);
      return;
    }
    case "session.rename": {
      const s = sessions.find((x) => x.id === payload.id);
      if (s) { s.title = payload.title; s.updatedAt = Date.now(); }
      send(ws, id, "response", { ok: true });
      broadcastSessionEvent(ws);
      return;
    }
    case "wallet.info":
      return send(ws, id, "response", wallet);
    case "models.list":
      return send(ws, id, "response", { models });
    case "agent.send":
      return fakeAgentTurn(ws, id, payload);
    case "agent.cancel":
      console.log("[mock] cancel", payload);
      return;
    case "agent.permissionResponse":
      console.log("[mock] permission response", payload);
      return;
    default:
      send(ws, id, "error", { message: `Unknown kind: ${kind}` });
  }
}

function stripMessages(s) {
  const { messages: _m, ...rest } = s;
  return rest;
}

function broadcastSessionEvent(ws) {
  send(ws, `broadcast-${Date.now()}`, "session.event", {});
}

async function fakeAgentTurn(ws, id, payload) {
  let sessionId = payload.sessionId;
  if (!sessionId) {
    const s = mkSession(payload.text.slice(0, 40) || "New chat", payload.text);
    s.messages = [{ role: "user", content: payload.text, kind: "text" }];
    sessions.unshift(s);
    sessionId = s.id;
    broadcastSessionEvent(ws);
  }

  let stepIdSeq = 0;
  const stepId = ++stepIdSeq;
  send(ws, id, "agent.step", { sessionId, stepId, label: `${labelFor(payload.model || "anthropic/claude-sonnet-4.6")} · thinking`, state: "thinking" });
  await sleep(400);
  send(ws, id, "agent.step", { sessionId, stepId, label: `${labelFor(payload.model || "anthropic/claude-sonnet-4.6")} · thinking`, state: "done" });

  // Media generation (image / video mode) — emit a tool_result artifact so the
  // chat renders a media bubble and the Gallery picks it up.
  if (payload.mode === "image" || payload.mode === "video") {
    const genStep = ++stepIdSeq;
    const toolName = payload.mode === "image" ? "generate_image" : "generate_video";
    send(ws, id, "agent.step", { sessionId, stepId: genStep, label: toolName, state: "run" });
    await sleep(1200);
    const artifact =
      payload.mode === "image"
        ? { path: mockImageDataUri(payload.text), mediaType: "image/svg+xml" }
        : { path: "https://www.w3schools.com/html/mov_bbb.mp4", mediaType: "video/mp4" };
    send(ws, id, "agent.tool_result", { sessionId, toolCallId: `t${genStep}`, preview: "", artifacts: [artifact] });
    send(ws, id, "agent.step", { sessionId, stepId: genStep, label: toolName, state: "done" });
    const usd = payload.mode === "image" ? 0.04 : 0.3;
    send(ws, id, "agent.payment", { sessionId, phase: "settle", model: payload.model || toolName, usd, chain: "base" });
    send(ws, id, "agent.done", { sessionId, costUsd: usd });
    return;
  }

  // Demo tool step if the prompt mentions price / search / file
  if (/price|search|files?|read|bash|cmd/i.test(payload.text)) {
    const toolStep = ++stepIdSeq;
    const toolName = /bash|cmd|run/i.test(payload.text) ? "Bash" : /file|read/i.test(payload.text) ? "Read" : "WebSearch";
    send(ws, id, "agent.step", { sessionId, stepId: toolStep, label: toolName, state: "run" });
    if (toolName === "Bash") {
      const askId = `ask-${Date.now()}`;
      send(ws, id, "agent.permissionAsk", { sessionId, askId, toolName: "Bash", description: `Run: ls -la` });
      await sleep(2000);
    } else {
      await sleep(800);
    }
    send(ws, id, "agent.step", { sessionId, stepId: toolStep, label: toolName, state: "done" });
  }

  const reply = `This is a mock reply from the dev server. The real Franklin CLI would have:\n\n` +
    `1. Routed your prompt to ${labelFor(payload.model || "anthropic/claude-sonnet-4.6")}\n` +
    `2. Executed any tools the model called (Read / Write / Edit / Bash / WebSearch / MarketPrice / PredictionMarkets / MusicGen)\n` +
    `3. Signed any required x402 payments from your local wallet — no popup\n` +
    `4. Streamed the answer back through this same WebSocket\n\n` +
    `Wire up the real \`franklin webui\` command in the CLI to replace this mock.`;

  for (const chunk of chunkText(reply, 8)) {
    send(ws, id, "agent.text", { sessionId, text: chunk });
    await sleep(20);
  }

  // Paid (non-free) chat models settle a small x402 charge so the Wallet panel
  // populates with receipts.
  const m = models.find((x) => x.id === (payload.model || ""));
  const usd = m && !m.free ? 0.002 : 0;
  if (usd) send(ws, id, "agent.payment", { sessionId, phase: "settle", model: payload.model, usd, chain: "base" });
  send(ws, id, "agent.done", { sessionId, costUsd: usd });
}

function labelFor(modelId) {
  return models.find((m) => m.id === modelId)?.label ?? modelId;
}

// A self-contained SVG data URI so image mode demos without any network/file IO.
function mockImageDataUri(prompt) {
  const caption = String(prompt || "Franklin").slice(0, 28).replace(/[<>&]/g, " ");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='%23caa24a'/><stop offset='1' stop-color='%238a6d2f'/></linearGradient></defs>` +
    `<rect width='100%' height='100%' fill='url(%23g)'/>` +
    `<text x='50%' y='46%' fill='white' font-family='sans-serif' font-size='26' text-anchor='middle'>Franklin · mock image</text>` +
    `<text x='50%' y='56%' fill='%23fff8e7' font-family='sans-serif' font-size='18' text-anchor='middle'>${caption}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${svg}`;
}
function chunkText(s, size) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

server.listen(PORT, () => {
  console.log(`[mock] franklin agent server on http://localhost:${PORT}`);
  console.log(`[mock] WebSocket: ws://localhost:${PORT}/agent`);
  console.log(`[mock] Vite dev server proxies /agent → here. Run \`npm run dev:vite\` in another terminal,`);
  console.log(`[mock] then open http://localhost:5173.`);
});
