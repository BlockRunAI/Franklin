/**
 * Franklin agent server (local WebSocket — drives the desktop app & browser UI).
 *
 * Serves the local React WebUI (franklin-webui / the desktop app) over a single
 * WebSocket using the envelope wire protocol the UI already speaks:
 *
 *   client → { id, kind, payload }      (agent.send / session.* / wallet.info / …)
 *   server → { id, kind, payload }      (agent.text / agent.step / agent.done / …)
 *
 * Unlike `franklin panel` (a read-only dashboard), this actually runs agent
 * turns: it drives the real `interactiveSession` loop from src/agent/loop.ts —
 * same tools, wallet, routing and signing as the CLI. The browser/desktop is
 * just a different head on the same agent.
 *
 * Single-window assumption: one long-lived agent session per server process,
 * fed by a getUserInput queue. Good enough for the desktop app; multi-session
 * fan-out can come later.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { loadChain, API_URLS, BLOCKRUN_DIR } from '../config.js';
import { loadConfig, setConfigValue } from '../commands/config.js';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { getModelsByCategory } from '../gateway-models.js';
import { listSessions, loadSessionHistory } from '../session/storage.js';
import { loadSdkSettlements } from '../stats/cost-log.js';
import { readSwaps } from '../stats/swap-log.js';
import { isCloudSyncEnabled, cloudList, cloudSync, type CloudConversation } from './cloud-sync.js';
import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import { retryFetchBalance } from '../commands/balance-retry.js';
import type { AgentConfig, StreamEvent, Dialogue, ContentPart, UserContentPart } from '../agent/types.js';

const FREE_DEFAULT_MODEL = 'nvidia/deepseek-v4-flash';

// Curated Base (chainId 8453) tokens for the wallet "holdings" view. Plain RPC
// can't enumerate every token an address holds (no on-chain "list all"), so we
// balanceOf a known set and show the non-zero ones. `stable` → USD ≈ amount.
const BASE_PUBLIC_RPCS = ['https://base.publicnode.com', 'https://mainnet.base.org', 'https://base.meowrpc.com'];
const BASE_TOKENS: Array<{ symbol: string; address: string; decimals: number; stable?: boolean; cg?: string }> = [
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, stable: true },
  { symbol: 'USDbC', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6, stable: true },
  { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, stable: true },
  { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, stable: true },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, cg: 'ethereum' },
  { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8, cg: 'bitcoin' },
  { symbol: 'cbETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, cg: 'ethereum' },
  { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18, cg: 'aerodrome-finance' },
  { symbol: 'DEGEN', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18, cg: 'degen-base' },
];

// USD prices via CoinGecko (free, no key). Best-effort: on failure, tokens just
// show without a USD value rather than blocking the holdings list.
async function fetchCgPrices(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent([...new Set(ids)].join(','))}&vs_currencies=usd`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await r.json() as Record<string, { usd?: number }>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v?.usd === 'number') out[k] = v.usd;
    return out;
  } catch { return {}; }
}

async function baseRpc(method: string, params: unknown[]): Promise<string | null> {
  for (const url of BASE_PUBLIC_RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json() as { result?: string };
      if (j && typeof j.result === 'string') return j.result;
    } catch { /* try next rpc */ }
  }
  return null;
}

function hexToAmount(hex: string | null, decimals: number): number {
  if (!hex || hex === '0x') return 0;
  try {
    const v = BigInt(hex);
    if (v === 0n) return 0;
    // Scale down with enough precision for display.
    return Number(v) / 10 ** decimals;
  } catch { return 0; }
}

/** Best-effort list of an address's holdings (native ETH + curated ERC-20s). */
async function listBaseHoldings(address: string): Promise<Array<{ symbol: string; amount: number; usd?: number }>> {
  const out: Array<{ symbol: string; amount: number; usd?: number }> = [];
  const addr = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const DUST = 1e-6; // hide negligible dust (e.g. post-swap leftovers) that'd render as "0"
  // Collect raw balances (amount + which coingecko id to price it with).
  const raw: Array<{ symbol: string; amount: number; stable?: boolean; cg?: string }> = [];
  const ethHex = await baseRpc('eth_getBalance', [address, 'latest']);
  const eth = hexToAmount(ethHex, 18);
  if (eth >= DUST) raw.push({ symbol: 'ETH', amount: eth, cg: 'ethereum' });
  await Promise.all(BASE_TOKENS.map(async (t) => {
    const data = '0x70a08231' + addr; // balanceOf(address)
    const hex = await baseRpc('eth_call', [{ to: t.address, data }, 'latest']);
    const amt = hexToAmount(hex, t.decimals);
    if (amt >= DUST) raw.push({ symbol: t.symbol, amount: amt, stable: t.stable, cg: t.cg });
  }));
  // Price the non-stable holdings (stable ≈ $1) and compute USD value per token.
  const prices = await fetchCgPrices(raw.filter((r) => !r.stable && r.cg).map((r) => r.cg!));
  for (const r of raw) {
    const usd = r.stable ? r.amount : (r.cg && prices[r.cg] != null ? r.amount * prices[r.cg] : undefined);
    out.push({ symbol: r.symbol, amount: r.amount, ...(usd != null ? { usd } : {}) });
  }
  return out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.amount - a.amount);
}

// Friendly, provider-tagged labels for the activity log (mirrors franklin-run),
// so a finished step reads "Checking prediction markets · Predexon" instead of
// the raw tool name. Unknown tools fall back to their own name.
const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web · Exa',
  search_prediction_markets: 'Checking prediction markets · Predexon',
  get_market_price: 'Fetching live price',
  generate_music: 'Composing music',
  make_phone_call: 'Placing phone call',
};
function labelFor(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

// Model list grouping — by provider (company), like OpenRouter/Together. The
// provider is the id's vendor prefix (e.g. "anthropic/claude-…"); PROVIDER_ORDER
// puts the most-wanted vendors first, the rest fall in alphabetically.
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', azure: 'OpenAI', google: 'Google', 'google-vertex': 'Google',
  xai: 'xAI', deepseek: 'DeepSeek', meta: 'Meta', 'meta-llama': 'Meta', nvidia: 'NVIDIA',
  moonshot: 'Moonshot', moonshotai: 'Moonshot', qwen: 'Qwen', alibaba: 'Qwen', mistral: 'Mistral',
  mistralai: 'Mistral', minimax: 'MiniMax', zhipu: 'Zhipu', bytedance: 'ByteDance', cohere: 'Cohere',
  perplexity: 'Perplexity', amazon: 'Amazon', microsoft: 'Microsoft', '01-ai': 'Yi', ai21: 'AI21',
};
const PROVIDER_ORDER = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Qwen', 'Moonshot', 'Meta', 'Mistral', 'MiniMax', 'NVIDIA'];
function providerLabel(id: string, ownedBy?: string): string {
  const p = (id.split('/')[0] || ownedBy || '').toLowerCase();
  return PROVIDER_LABEL[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Other');
}

// ─── Browser-attack surface gate ────────────────────────────────────────────
// Loopback binding alone is NOT an auth boundary: any web page the user has
// open can reach 127.0.0.1 (the browser attaches an Origin header but happily
// completes the request — WS handshakes aren't blocked by CORS, and a wallet-
// bearing agent in trust mode must not be drivable by a drive-by page).
//
// Policy: requests WITHOUT an Origin header are local processes (Electron main,
// curl, native clients — browsers can't strip Origin) → allowed. Browser
// origins are allowed only for Electron renderers (file:// / app://), local
// UIs (localhost / 127.0.0.1), the hosted web UI, and anything listed in
// FRANKLIN_SERVE_ALLOWED_ORIGINS (comma-separated). The literal "null" origin
// is REJECTED by default — sandboxed iframes on hostile pages also serialize
// to "null" — set FRANKLIN_SERVE_ALLOW_NULL_ORIGIN=1 if a renderer needs it.
// Defense-in-depth: when FRANKLIN_SERVE_TOKEN is set, every WS upgrade and
// /file request must also carry it (?token=…).
const DEFAULT_ALLOWED_ORIGINS = ['https://franklin.run'];
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser local client
  if (origin === 'null') return process.env.FRANKLIN_SERVE_ALLOW_NULL_ORIGIN === '1';
  if (origin.startsWith('file://') || origin.startsWith('app://')) return true; // Electron renderer
  let host = '';
  try { host = new URL(origin).hostname; } catch { return false; }
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') return true;
  const extra = (process.env.FRANKLIN_SERVE_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra].includes(origin);
}
function tokenOk(url: URL): boolean {
  const required = process.env.FRANKLIN_SERVE_TOKEN;
  if (!required) return true;
  return url.searchParams.get('token') === required;
}

interface ServerOptions {
  port: number;
  workDir: string;
  debug?: boolean;
}

// ─── Wire envelope ──────────────────────────────────────────────────────────

interface ClientMsg {
  id: string;
  kind: string;
  payload?: unknown;
}

function send(ws: WebSocket, id: string, kind: string, payload?: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ id, kind, payload }));
}

// Flatten a stored Dialogue into the {role, content, kind:'text'} shape the UI
// renders. Tool calls / images are dropped here (the live stream carries those
// for the active turn); history replay just needs the text.
function dialogueText(content: Dialogue['content']): string {
  if (typeof content === 'string') return content;
  const parts = content as Array<ContentPart | UserContentPart>;
  return parts
    .map((p) => (p && typeof p === 'object' && 'type' in p && p.type === 'text' ? (p as { text: string }).text : ''))
    .filter(Boolean)
    .join('');
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const { port, workDir, debug } = opts;
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const userConfig = loadConfig();

  // ── Single long-lived agent session ──
  // interactiveSession owns the loop; we feed it user turns via a queue and
  // fan its StreamEvents out to the connected socket.
  let sessionStarted = false;
  let currentModel: string | null = null;
  // Live config ref + the cost-saver (research-bloat compaction) toggle. The UI
  // flips this; we mutate the running config so the loop picks it up next turn.
  let agentConfig: AgentConfig | null = null;
  let costSaver = userConfig['cost-saver'] !== 'false';
  let inputQueue: string[] = [];
  let inputResolver: ((v: string | null) => void) | null = null;
  let abortFn: (() => void) | null = null;

  // The socket + correlation id for the in-flight turn (single-window).
  let activeWs: WebSocket | null = null;
  let activeTurnId: string | null = null;
  // We sometimes inject helper commands (`/model …`, `/clear`) as their own
  // turns ahead of the real prompt. Each ends with its own turn_done — which
  // would emit agent.done and clear activeTurnId, killing the real prompt's
  // stream. This counter swallows each injected turn's events (text + turn_done)
  // so the real prompt streams next under the same activeTurnId. It's a counter,
  // not a bool, because a single send can inject more than one command.
  let suppressTurns = 0;
  // The client conversation id the running agent history belongs to. When a turn
  // arrives for a different conversation we /clear the history so separate
  // sidebar chats don't bleed context (the server runs one long-lived session).
  let currentConvId: string | null = null;
  const stepIds = new Map<string, number>();
  const stepLabels = new Map<string, string>();
  const stepDetails = new Map<string, string>();
  let stepSeq = 0;

  function getUserInput(): Promise<string | null> {
    return new Promise((resolve) => {
      if (inputQueue.length > 0) {
        resolve(inputQueue.shift()!);
        return;
      }
      inputResolver = resolve;
    });
  }
  function pushInput(text: string): void {
    if (inputResolver) {
      const r = inputResolver;
      inputResolver = null;
      r(text);
    } else {
      inputQueue.push(text);
    }
  }

  function emit(kind: string, payload: unknown): void {
    if (activeWs && activeTurnId) send(activeWs, activeTurnId, kind, payload);
  }

  // ── Wallet balance (cached client) + post-turn broadcast ──
  let walletClient: Awaited<ReturnType<typeof setupAgentSolanaWallet>> | ReturnType<typeof setupAgentWallet> | null = null;
  async function getWallet() {
    if (walletClient) return walletClient;
    const c = chain === 'solana'
      ? await setupAgentSolanaWallet({ silent: true })
      : setupAgentWallet({ silent: true });
    walletClient = c;
    return c;
  }
  async function fetchBalanceUsd(): Promise<number | undefined> {
    try {
      const client = await getWallet();
      return await retryFetchBalance(() => client.getBalance());
    } catch { return undefined; }
  }
  // After each turn, push the fresh balance to the UI (settlement may have
  // changed it) so the sidebar pill + wallet page update live and stay in sync.
  // Broadcast with a non-turn id so it reaches the client's global listeners.
  function broadcastWalletAfterTurn(): void {
    const ws = activeWs;
    if (!ws) return;
    void fetchBalanceUsd().then((balanceUsd) => {
      if (balanceUsd != null) send(ws, 'wallet', 'wallet.event', { balanceUsd });
    });
  }

  function onEvent(event: StreamEvent): void {
    // Injected helper turn (/model, /clear): drop its output and end-of-turn so
    // it neither shows in the chat nor closes the real prompt's stream.
    if (suppressTurns > 0) {
      if (event.kind === 'turn_done') suppressTurns--;
      return;
    }
    switch (event.kind) {
      case 'text_delta':
        // Drop internal compaction status lines (🗜 …) — they're CLI ops noise,
        // not part of the answer, and shouldn't render in the desktop chat.
        if (/^\s*\*?🗜/.test(event.text)) break;
        emit('agent.text', { sessionId: '', text: event.text });
        break;
      case 'capability_start': {
        let sid = stepIds.get(event.id);
        if (sid == null) { sid = ++stepSeq; stepIds.set(event.id, sid); }
        const label = labelFor(event.name);
        stepLabels.set(event.id, label);
        // The per-call detail (the tool's key argument — query, prompt, symbol…)
        // shown as small text next to the tool so you see WHAT it's doing.
        const detail = event.preview?.trim() || '';
        if (detail) stepDetails.set(event.id, detail);
        emit('agent.step', { sessionId: '', stepId: sid, label, detail, state: 'run' });
        break;
      }
      case 'capability_done': {
        const sid = stepIds.get(event.id) ?? ++stepSeq;
        // Keep the original label on completion — sending '' here is what made
        // finished steps render as a bare checkmark with no text.
        emit('agent.step', { sessionId: '', stepId: sid, label: stepLabels.get(event.id) ?? '', detail: stepDetails.get(event.id) ?? '', state: 'done' });
        const images = event.result?.images;
        if (images && images.length) {
          emit('agent.tool_result', {
            sessionId: '',
            toolCallId: event.id,
            preview: event.result.output ?? '',
            isError: event.result.isError,
            artifacts: images.map((im) => ({
              path: `data:${im.mediaType};base64,${im.base64}`,
              mediaType: im.mediaType,
            })),
          });
        }
        // MusicGen / media tools save a local file and report its path in the
        // output text. Surface generated audio (and stand-alone video/image
        // files) as a playable artifact served over the /file route.
        const out = event.result?.output ?? '';
        const fileMatch = out.match(/(\/[^\s'"]*\.(?:mp3|wav|m4a|ogg|flac|mp4|webm))/i);
        if (fileMatch) {
          const filePath = fileMatch[1];
          const ext = filePath.toLowerCase().split('.').pop() || '';
          const mediaType =
            ext === 'mp4' || ext === 'webm' ? `video/${ext}` :
            ext === 'mp3' ? 'audio/mpeg' :
            ext === 'm4a' ? 'audio/mp4' : `audio/${ext}`;
          emit('agent.tool_result', {
            sessionId: '',
            toolCallId: event.id,
            preview: '',
            artifacts: [{ path: `http://127.0.0.1:${port}/file?path=${encodeURIComponent(filePath)}`, mediaType }],
          });
        }
        break;
      }
      case 'turn_done':
        if (event.reason === 'completed') {
          emit('agent.done', { sessionId: '', costUsd: 0 });
        } else if (event.error) {
          emit('agent.error', { sessionId: '', message: event.error });
        } else {
          emit('agent.done', { sessionId: '', costUsd: 0 });
        }
        activeTurnId = null;
        stepIds.clear();
        stepLabels.clear();
        stepDetails.clear();
        broadcastWalletAfterTurn();
        break;
      // thinking_delta / capability_input_delta / capability_progress / usage:
      // not surfaced to the UI yet.
      default:
        break;
    }
  }

  async function ensureSession(model: string): Promise<void> {
    if (sessionStarted) return;
    sessionStarted = true;
    currentModel = model;
    const systemInstructions = assembleInstructions(workDir, model);
    const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities, model);
    try {
      const { registerMoAConfig } = await import('../tools/moa.js');
      registerMoAConfig(apiUrl, chain, model);
    } catch { /* MoA optional */ }
    const capabilities = [...allCapabilities, subAgent];

    const config: AgentConfig = {
      model,
      apiUrl,
      chain,
      systemInstructions,
      capabilities,
      maxTurns: 100,
      workingDir: workDir,
      permissionMode: 'trust', // the desktop UI has no permission prompt yet
      debug: !!debug,
      showPrefetchStatus: false,
      costSaver,
    };
    agentConfig = config;

    interactiveSession(config, getUserInput, onEvent, (abort) => { abortFn = abort; })
      .catch((err) => {
        if (activeWs && activeTurnId) {
          send(activeWs, activeTurnId, 'agent.error', { sessionId: '', message: err instanceof Error ? err.message : String(err) });
        }
      })
      .finally(() => { sessionStarted = false; abortFn = null; });
  }

  // ── RPC handlers ──
  async function handle(ws: WebSocket, msg: ClientMsg): Promise<void> {
    const { id, kind, payload } = msg;
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (kind) {
      case 'session.list': {
        const metas = listSessions();
        send(ws, id, 'response', {
          sessions: metas.map((m) => ({
            id: m.id,
            title: `${m.model} · ${m.id.slice(0, 6)}`,
            createdAt: m.createdAt,
            updatedAt: m.updatedAt,
            messageCount: m.messageCount ?? 0,
            lastModel: m.model,
          })),
        });
        break;
      }
      case 'session.load': {
        const history = loadSessionHistory(String(p.id ?? ''));
        const messages = history
          .filter((d) => d.role === 'user' || d.role === 'assistant')
          .map((d) => ({ role: d.role as 'user' | 'assistant', content: dialogueText(d.content), kind: 'text' as const }))
          .filter((m) => m.content);
        send(ws, id, 'response', { messages });
        break;
      }
      case 'wallet.info': {
        try {
          const client = await getWallet();
          const address = client.getWalletAddress();
          const balanceUsd = await fetchBalanceUsd(); // best-effort; undefined on failure
          send(ws, id, 'response', { address, chain, balanceUsd });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'wallet error' });
        }
        break;
      }
      case 'wallet.tokens': {
        // Holdings: native ETH + curated Base ERC-20s with a non-zero balance.
        // Public RPC can't enumerate ALL tokens, so this is a known-token sweep.
        try {
          if (chain !== 'base') { send(ws, id, 'response', { tokens: [] }); break; }
          const client = await getWallet();
          const address = await client.getWalletAddress();
          const tokens = await listBaseHoldings(address);
          send(ws, id, 'response', { tokens });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'tokens error' });
        }
        break;
      }
      case 'history.load': {
        // History is wallet-synced to the cloud (franklin.run, same as the web)
        // with a local file (~/.blockrun) as cache + offline fallback. Cloud is
        // the source of truth when reachable; otherwise we serve the local file.
        const file = path.join(BLOCKRUN_DIR, 'franklin-desktop-history.json');
        const readLocal = (): unknown[] => {
          try {
            if (fs.existsSync(file)) { const p2 = JSON.parse(fs.readFileSync(file, 'utf-8')); if (Array.isArray(p2)) return p2; }
          } catch { /* ignore */ }
          return [];
        };
        const writeLocal = (c: unknown[]) => {
          try { fs.mkdirSync(BLOCKRUN_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 }); } catch { /* ignore */ }
        };
        try {
          const local = readLocal();
          if (isCloudSyncEnabled()) {
            try {
              const cloud = await cloudList();
              if (cloud.length > 0) {
                writeLocal(cloud);            // refresh local cache
                send(ws, id, 'response', { conversations: cloud });
                break;
              }
              // Cloud empty but we have local history → migrate it up.
              if (local.length > 0) void cloudSync(local as CloudConversation[]).catch(() => {});
            } catch { /* offline / not-deployed → fall back to local */ }
          }
          send(ws, id, 'response', { conversations: local });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'history load error' });
        }
        break;
      }
      case 'history.save': {
        try {
          const conversations = Array.isArray(p.conversations) ? p.conversations : [];
          // Local file = instant durable cache; cloud = best-effort wallet sync.
          fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
          fs.writeFileSync(path.join(BLOCKRUN_DIR, 'franklin-desktop-history.json'), JSON.stringify(conversations), { mode: 0o600 });
          if (isCloudSyncEnabled()) void cloudSync(conversations as CloudConversation[]).catch(() => {});
          send(ws, id, 'response', { ok: true });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'history save error' });
        }
        break;
      }
      case 'wallet.swaps': {
        try {
          send(ws, id, 'response', { swaps: readSwaps(100) });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'swaps error' });
        }
        break;
      }
      case 'wallet.spend': {
        // Real spend, sourced from the x402 settlement ledger (cost_log.jsonl) —
        // the same truth the CLI dashboard uses. Covers BOTH model calls and
        // paid tools (web search, image gen, …), not a token estimate.
        try {
          const rows = loadSdkSettlements();
          const byModel: Record<string, { usd: number; count: number }> = {};
          let totalUsd = 0;
          for (const r of rows) {
            const key = r.model || r.endpoint || 'unknown';
            const b = byModel[key] ?? { usd: 0, count: 0 };
            b.usd += r.costUsd;
            b.count += 1;
            byModel[key] = b;
            totalUsd += r.costUsd;
          }
          const receipts = [...rows]
            .sort((a, b) => b.ts - a.ts)
            .slice(0, 100)
            .map((r) => ({ ts: r.ts, model: r.model || r.endpoint || 'unknown', usd: r.costUsd }));
          send(ws, id, 'response', { totalUsd, requests: rows.length, byModel, receipts });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'spend error' });
        }
        break;
      }
      case 'models.list': {
        try {
          const models = await getModelsByCategory('chat');
          const mapped = models.map((m) => {
            const provider = providerLabel(m.id, m.owned_by);
            return {
              id: m.id,
              label: m.name,
              free: m.billing_mode === 'free',
              group: provider,
              provider,
              contextWindow: m.context_window,
            };
          });
          // Group by provider (PROVIDER_ORDER first, then alphabetical); free
          // models surface first within each provider. The picker renders
          // consecutive same-`group` items as one section, so sort accordingly.
          const rank = (g: string) => { const i = PROVIDER_ORDER.indexOf(g); return i < 0 ? 999 : i; };
          mapped.sort((a, b) =>
            rank(a.group) - rank(b.group) ||
            a.group.localeCompare(b.group) ||
            (a.free === b.free ? 0 : a.free ? -1 : 1) ||
            a.label.localeCompare(b.label),
          );
          send(ws, id, 'response', { models: mapped });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'models error' });
        }
        break;
      }
      case 'agent.send': {
        const text = String(p.text ?? '').trim();
        if (!text) { send(ws, id, 'agent.error', { sessionId: '', message: 'empty input' }); break; }
        activeWs = ws;
        activeTurnId = id;
        stepIds.clear();
        // A non-empty model means "switch the chat model". Media turns send no
        // model (the image/video model is a TOOL parameter baked into the
        // prompt, NOT the chat model — switching the chat model to an image
        // model breaks the turn), so we keep the current chat model for them.
        const desiredModel = p.model ? String(p.model) : null;
        const clientConvId = p.convId ? String(p.convId) : null;
        await ensureSession(desiredModel || userConfig['default-model'] || FREE_DEFAULT_MODEL);
        // Conversation switch → wipe the agent's history so a new/other chat
        // doesn't inherit the previous one's context. Only when we already had a
        // different conversation loaded (not on the very first turn).
        if (clientConvId && currentConvId && clientConvId !== currentConvId) {
          suppressTurns++; // swallow the injected /clear turn (see onEvent)
          pushInput('/clear');
        }
        if (clientConvId) currentConvId = clientConvId;
        if (desiredModel && currentModel && desiredModel !== currentModel) {
          suppressTurns++; // swallow the injected /model turn (see onEvent)
          pushInput(`/model ${desiredModel}`);
          currentModel = desiredModel;
        }
        pushInput(text);
        break;
      }
      case 'settings.get':
        send(ws, id, 'response', { costSaver });
        break;
      case 'settings.set': {
        if (typeof p.costSaver === 'boolean') {
          costSaver = p.costSaver;
          if (agentConfig) agentConfig.costSaver = costSaver; // live-update the running session
          setConfigValue('cost-saver', costSaver ? 'true' : 'false'); // persist across restarts
        }
        send(ws, id, 'response', { costSaver });
        break;
      }
      case 'agent.cancel':
        if (abortFn) abortFn();
        break;
      case 'agent.permissionResponse':
        // permissionMode is 'trust' — nothing to unblock.
        break;
      default:
        send(ws, id, 'error', { message: `Unknown kind: ${kind}` });
    }
  }

  // ── HTTP + WS ──
  // HTTP: a /file route streams a generated media file (audio/video/image) so
  // the renderer can play it. The path param is confined to media files under
  // the session work dir (plus FRANKLIN_SERVE_FILE_ROOTS extras) — NOT the
  // whole filesystem — and the request must pass the Origin gate. Otherwise a
  // hostile page could fetch wallet/key files off the loopback port.
  const fileRoots = [
    workDir,
    path.join(BLOCKRUN_DIR, 'content'),
    ...(process.env.FRANKLIN_SERVE_FILE_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ].map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter((r): r is string => !!r);
  const MEDIA_MIME: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
    mp4: 'video/mp4', webm: 'video/webm',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  };
  const httpServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const origin = req.headers.origin;
      if (url.pathname === '/file') {
        if (!isOriginAllowed(origin) || !tokenOk(url)) { res.writeHead(403); res.end(); return; }
        const p = url.searchParams.get('path') || '';
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
        // Resolve symlinks before the prefix check so a link can't escape a root.
        const real = fs.realpathSync(p);
        const inRoot = fileRoots.some((root) => real === root || real.startsWith(root + path.sep));
        const ext = real.toLowerCase().split('.').pop() || '';
        const mime = MEDIA_MIME[ext];
        if (!inRoot || !mime) { res.writeHead(403); res.end(); return; }
        res.writeHead(200, {
          'Content-Type': mime,
          // Reflect the (already vetted) origin instead of `*` so arbitrary
          // sites can't read the bytes cross-origin.
          ...(origin && origin !== 'null' ? { 'Access-Control-Allow-Origin': origin } : {}),
        });
        fs.createReadStream(real).pipe(res);
        return;
      }
    } catch { /* fall through to 404 */ }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocket.Server({
    server: httpServer,
    path: '/agent',
    // Same gate as /file: refuse upgrades from non-allowlisted browser origins
    // (and require the token when one is configured). See isOriginAllowed.
    verifyClient: (info: { origin?: string; req: http.IncomingMessage }) => {
      const url = new URL(info.req.url || '/', 'http://127.0.0.1');
      const allowed = isOriginAllowed(info.origin || info.req.headers.origin) && tokenOk(url);
      if (!allowed && debug) console.log(`[serve] rejected WS upgrade from origin=${info.origin ?? 'n/a'}`);
      return allowed;
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw: Buffer) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handle(ws, msg).catch((err) => {
        send(ws, msg.id, 'error', { message: err instanceof Error ? err.message : String(err) });
      });
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      // eslint-disable-next-line no-console
      console.log(`Franklin agent server on ws://127.0.0.1:${port}/agent  (chain: ${chain}, workdir: ${workDir})`);
      resolve();
    });
  });
}
