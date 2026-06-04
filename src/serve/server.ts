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
import WebSocket from 'ws';
import { loadChain, API_URLS } from '../config.js';
import { loadConfig } from '../commands/config.js';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { getModelsByCategory } from '../gateway-models.js';
import { listSessions, loadSessionHistory } from '../session/storage.js';
import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import { retryFetchBalance } from '../commands/balance-retry.js';
import type { AgentConfig, StreamEvent, Dialogue, ContentPart, UserContentPart } from '../agent/types.js';

const FREE_DEFAULT_MODEL = 'nvidia/deepseek-v4-flash';

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
  let inputQueue: string[] = [];
  let inputResolver: ((v: string | null) => void) | null = null;
  let abortFn: (() => void) | null = null;

  // The socket + correlation id for the in-flight turn (single-window).
  let activeWs: WebSocket | null = null;
  let activeTurnId: string | null = null;
  const stepIds = new Map<string, number>();
  const stepLabels = new Map<string, string>();
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

  function onEvent(event: StreamEvent): void {
    switch (event.kind) {
      case 'text_delta':
        emit('agent.text', { sessionId: '', text: event.text });
        break;
      case 'capability_start': {
        let sid = stepIds.get(event.id);
        if (sid == null) { sid = ++stepSeq; stepIds.set(event.id, sid); }
        const label = labelFor(event.name);
        stepLabels.set(event.id, label);
        emit('agent.step', { sessionId: '', stepId: sid, label, state: 'run' });
        break;
      }
      case 'capability_done': {
        const sid = stepIds.get(event.id) ?? ++stepSeq;
        // Keep the original label on completion — sending '' here is what made
        // finished steps render as a bare checkmark with no text.
        emit('agent.step', { sessionId: '', stepId: sid, label: stepLabels.get(event.id) ?? '', state: 'done' });
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
    };

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
          const client = chain === 'solana'
            ? await setupAgentSolanaWallet({ silent: true })
            : setupAgentWallet({ silent: true });
          const address = client.getWalletAddress();
          let balanceUsd: number | undefined;
          try {
            balanceUsd = await retryFetchBalance(() => client.getBalance());
          } catch { /* balance best-effort — still return the address */ }
          send(ws, id, 'response', { address, chain, balanceUsd });
        } catch (err) {
          send(ws, id, 'error', { message: err instanceof Error ? err.message : 'wallet error' });
        }
        break;
      }
      case 'models.list': {
        try {
          const models = await getModelsByCategory('chat');
          send(ws, id, 'response', {
            models: models.map((m) => ({
              id: m.id,
              label: m.name,
              free: m.billing_mode === 'free',
              group: m.billing_mode === 'free' ? 'Free' : 'Paid',
            })),
          });
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
        await ensureSession(desiredModel || userConfig['default-model'] || FREE_DEFAULT_MODEL);
        if (desiredModel && currentModel && desiredModel !== currentModel) {
          pushInput(`/model ${desiredModel}`);
          currentModel = desiredModel;
        }
        pushInput(text);
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
  // the renderer can play it. Loopback-only server, so a path param is fine.
  const httpServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/file') {
        const p = url.searchParams.get('path') || '';
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
        const ext = p.toLowerCase().split('.').pop() || '';
        const mime =
          ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4' :
          ext === 'ogg' ? 'audio/ogg' : ext === 'flac' ? 'audio/flac' :
          ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' :
          /^(png|jpe?g|webp|gif)$/.test(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(p).pipe(res);
        return;
      }
    } catch { /* fall through to 404 */ }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocket.Server({ server: httpServer, path: '/agent' });

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
