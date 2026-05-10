import http from 'node:http';
import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';
import type { Chain } from '../config.js';
import { recordUsage } from '../stats/tracker.js';
import { appendSettlementRow } from '../stats/cost-log.js';
import { appendAudit } from '../stats/audit.js';
import {
  buildFallbackChain,
  DEFAULT_FALLBACK_CONFIG,
  ROUTING_PROFILES,
  type FallbackConfig,
} from './fallback.js';
import {
  routeRequest,
  parseRoutingProfile,
  getFallbackChain as getRouterFallbackChain,
  type RoutingProfile,
} from '../router/index.js';
import { estimateCost } from '../pricing.js';
import { VERSION } from '../config.js';

// User-Agent for backend requests
const USER_AGENT = `franklin/${VERSION}`;
const X_FRANKLIN_VERSION = VERSION;

export interface ProxyOptions {
  port: number;
  apiUrl: string;
  chain?: Chain;
  modelOverride?: string;
  debug?: boolean;
  fallbackEnabled?: boolean;
  // Override the per-request timeout. Tests pass this directly instead of
  // mutating process.env.FRANKLIN_PROXY_REQUEST_TIMEOUT_MS — an interrupted
  // test run was leaving the env var set to '40' in the parent shell, which
  // then poisoned subsequent franklin invocations with a 40ms timeout
  // (verified in franklin-debug.log: real models like deepseek/deepseek-chat
  // were timing out at 40ms long after the test process exited).
  requestTimeoutMs?: number;
  streamTimeoutMs?: number;
}

// Logging here goes through the unified logger introduced in 3.15.11
// (timestamp + [LEVEL] tag, self-rotating at 10 MB, optional stderr
// mirror in debug mode). The previous per-module debug()/log() helpers
// duplicated the file path, ANSI strip regex (with a slightly different
// pattern!), and timestamp format — bug fixes never propagated. They
// were the last holdouts after the agent loop was migrated.
import { logger, setDebugMode } from '../logger.js';
import { isTestFixtureModel } from '../stats/test-fixture.js';

const DEFAULT_MAX_TOKENS = 4096;
// 180s budget for *time-to-headers* — reasoning-class models (zai/glm-*,
// nemotron *-reasoning, deepseek-r*, gpt-5-codex, anthropic extended-thinking)
// routinely take 60–120s to first token on cache-cold prompts or busy
// gateways. The old 45s default cut those off and the proxy returned a
// failed response that downstream agents (Cline, Claude Desktop, etc.) had
// to retry blindly.
const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_PROXY_STREAM_TIMEOUT_MS = 5 * 60 * 1000;

function parseTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getProxyRequestTimeoutMs(): number {
  return parseTimeoutEnv('FRANKLIN_PROXY_REQUEST_TIMEOUT_MS', DEFAULT_PROXY_REQUEST_TIMEOUT_MS);
}

function getProxyStreamTimeoutMs(): number {
  return parseTimeoutEnv('FRANKLIN_PROXY_STREAM_TIMEOUT_MS', DEFAULT_PROXY_STREAM_TIMEOUT_MS);
}

function createProxyTimeoutError(label: string, timeoutMs: number): Error {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  if (timeoutMs <= 0) return fetch(url, init);

  const controller = new AbortController();
  const timeoutError = createProxyTimeoutError(label, timeoutMs);
  const timeout = setTimeout(() => {
    try { controller.abort(timeoutError); } catch { /* ignore */ }
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw timeoutError;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function replaceModelInBody(body: string, model: string): string {
  try {
    const parsed = JSON.parse(body);
    parsed.model = model;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

// Per-model last output tokens for adaptive max_tokens (avoids cross-request pollution)
const MAX_TRACKED_MODELS = 50;
const lastOutputByModel = new Map<string, number>();
function trackOutputTokens(model: string, tokens: number) {
  if (lastOutputByModel.size >= MAX_TRACKED_MODELS) {
    const firstKey = lastOutputByModel.keys().next().value;
    if (firstKey) lastOutputByModel.delete(firstKey);
  }
  lastOutputByModel.set(model, tokens);
}

// Model shortcuts for quick switching
const MODEL_SHORTCUTS: Record<string, string> = {
  // Routing profiles — Auto-only since 2026-05-03 (Eco/Premium retired).
  // `eco` / `premium` aliases retained for back-compat with proxy clients;
  // they parse to Auto downstream.
  auto: 'blockrun/auto',
  smart: 'blockrun/auto',
  eco: 'blockrun/auto',
  premium: 'blockrun/auto',
  // Anthropic
  sonnet: 'anthropic/claude-sonnet-4.6',
  claude: 'anthropic/claude-sonnet-4.6',
  'sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  opus: 'anthropic/claude-opus-4.7',
  'opus-4.7': 'anthropic/claude-opus-4.7',
  'opus-4.6': 'anthropic/claude-opus-4.6',
  haiku: 'anthropic/claude-haiku-4.5-20251001',
  'haiku-4.5': 'anthropic/claude-haiku-4.5-20251001',
  // OpenAI
  // `gpt` / `gpt5` / `gpt-5` follow the gateway's flagship — currently 5.5.
  gpt: 'openai/gpt-5.5',
  gpt5: 'openai/gpt-5.5',
  'gpt-5': 'openai/gpt-5.5',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-5.3': 'openai/gpt-5.3',
  'gpt-5.2': 'openai/gpt-5.2',
  'gpt-5.2-pro': 'openai/gpt-5.2-pro',
  'gpt-4.1': 'openai/gpt-4.1',
  codex: 'openai/gpt-5.3-codex',
  nano: 'openai/gpt-5-nano',
  mini: 'openai/gpt-5-mini',
  o3: 'openai/o3',
  o4: 'openai/o4-mini',
  'o4-mini': 'openai/o4-mini',
  o1: 'openai/o1',
  // Google
  gemini: 'google/gemini-2.5-pro',
  'gemini-2.5': 'google/gemini-2.5-pro',
  flash: 'google/gemini-2.5-flash',
  'gemini-3': 'google/gemini-3.1-pro',
  'gemini-3.1': 'google/gemini-3.1-pro',
  // xAI
  grok: 'xai/grok-3',
  'grok-3': 'xai/grok-3',
  'grok-4': 'xai/grok-4-0709',
  'grok-fast': 'xai/grok-4-1-fast-reasoning',
  'grok-4.1': 'xai/grok-4-1-fast-reasoning',
  // DeepSeek
  deepseek: 'deepseek/deepseek-chat',
  r1: 'deepseek/deepseek-reasoner',
  // Free models (agent-tested gateway free tier — refreshed 2026-04)
  free: 'nvidia/qwen3-coder-480b',
  glm4: 'nvidia/qwen3-coder-480b',
  'deepseek-free': 'nvidia/qwen3-coder-480b',
  'qwen-coder': 'nvidia/qwen3-coder-480b',
  'qwen-think': 'nvidia/qwen3-coder-480b',
  maverick: 'nvidia/llama-4-maverick',
  'gpt-oss': 'nvidia/qwen3-coder-480b',
  'gpt-oss-small': 'nvidia/qwen3-coder-480b',
  'mistral-small': 'nvidia/llama-4-maverick',
  // Retired/unreliable gateway-model aliases (map to closest agent-tested current).
  nemotron: 'nvidia/qwen3-coder-480b',
  devstral: 'nvidia/qwen3-coder-480b',
  // Minimax
  minimax: 'minimax/minimax-m2.7',
  'm2.7': 'minimax/minimax-m2.7',
  // Others
  glm: 'zai/glm-5.1',
  'glm-turbo': 'zai/glm-5-turbo',
  'glm5': 'zai/glm-5.1',
  kimi: 'moonshot/kimi-k2.6',
  'k2.6': 'moonshot/kimi-k2.6',
  // K2.5 retired by the gateway — aliases resolve to K2.6 for muscle memory.
  'kimi-k2.5': 'moonshot/kimi-k2.6',
  'k2.5': 'moonshot/kimi-k2.6',
};

// Model pricing now uses shared source from src/pricing.ts

function detectModelSwitch(parsed: {
  messages?: Array<{ role: string; content: string | unknown[] | unknown }>;
}): string | null {
  if (!parsed.messages || parsed.messages.length === 0) return null;
  const last = parsed.messages[parsed.messages.length - 1];
  if (last.role !== 'user') return null;

  let content = '';
  if (typeof last.content === 'string') {
    content = last.content;
  } else if (Array.isArray(last.content)) {
    const textBlock = (
      last.content as Array<{ type: string; text?: string }>
    ).find((b) => b.type === 'text' && b.text);
    if (textBlock && textBlock.text) content = textBlock.text;
  }
  if (!content) return null;

  content = content.trim().toLowerCase();
  const match = content.match(/^use\s+(.+)$/);
  if (!match) return null;

  const modelInput = match[1].trim();
  // Check shortcuts first
  if (MODEL_SHORTCUTS[modelInput]) return MODEL_SHORTCUTS[modelInput];
  // If it contains a slash, treat as full model ID
  if (modelInput.includes('/')) return modelInput;
  return null;
}

// Default model - smart routing built-in
const DEFAULT_MODEL = 'blockrun/auto';

// Origin allowlist: requests must either have no Origin (native HTTP CLI clients)
// or come from localhost. This prevents drive-by wallet draining by browser extensions
// or other cross-origin local processes.
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Native HTTP clients (curl, CLI) have no Origin header
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

// Sliding-window rate limiter to prevent runaway loops draining the wallet.
// Default 120 req/min; override via FRANKLIN_PROXY_RATE_LIMIT=<n> (0 disables).
const RATE_LIMIT_PER_MIN = (() => {
  const raw = process.env.FRANKLIN_PROXY_RATE_LIMIT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : 120;
})();
const rateWindow: number[] = []; // timestamps (ms) of recent paid requests
function withinRateLimit(): boolean {
  if (RATE_LIMIT_PER_MIN <= 0) return true;
  const now = Date.now();
  // Drop timestamps older than 60s
  while (rateWindow.length && now - rateWindow[0] > 60_000) rateWindow.shift();
  if (rateWindow.length >= RATE_LIMIT_PER_MIN) return false;
  rateWindow.push(now);
  return true;
}

export function createProxy(options: ProxyOptions): http.Server {
  // Wire stderr-mirroring of unified logger output to the proxy's debug
  // flag — same pattern as interactiveSession in agent/loop. File writes
  // happen regardless; only the live stderr mirror is gated.
  setDebugMode(!!options.debug);

  const chain = options.chain || 'base';
  let currentModel: string | null = options.modelOverride || DEFAULT_MODEL;
  const fallbackEnabled = options.fallbackEnabled !== false; // Default true
  // Resolve timeouts once at construction. The option wins over the env var
  // so callers (esp. tests) can configure a single proxy without polluting
  // process.env for the rest of the process — and for any sibling proxy.
  const effectiveRequestTimeoutMs = options.requestTimeoutMs ?? getProxyRequestTimeoutMs();
  const effectiveStreamTimeoutMs = options.streamTimeoutMs ?? getProxyStreamTimeoutMs();

  let baseWallet: { privateKey: string; address: string } | null = null;
  let solanaWallet: { privateKey: string; address: string } | null = null;

  if (chain === 'base') {
    const w = getOrCreateWallet();
    baseWallet = { privateKey: w.privateKey, address: w.address };
  }

  let solanaInitPromise: Promise<void> | null = null;
  const initSolana = () => {
    if (chain !== 'solana' || solanaWallet) return Promise.resolve();
    if (!solanaInitPromise) {
      solanaInitPromise = getOrCreateSolanaWallet().then((w) => {
        solanaWallet = { privateKey: w.privateKey, address: w.address };
      }).catch((err) => {
        solanaInitPromise = null; // Allow retry on failure
        throw err;
      });
    }
    return solanaInitPromise;
  };

  const server = http.createServer(async (req, res) => {
    // Origin check: block browser extensions / cross-origin local processes
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Origin ${origin} not allowed` }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Rate limit paid endpoints (anything but /health and /v1/models)
    const rawPath = req.url?.replace(/^\/api/, '') || '';
    const isReadOnly = rawPath.startsWith('/health') || rawPath.startsWith('/v1/models');
    if (!isReadOnly && !withinRateLimit()) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Rate limit: ${RATE_LIMIT_PER_MIN} requests/minute. Override with FRANKLIN_PROXY_RATE_LIMIT=<n> (0 disables).`,
      }));
      return;
    }

    await initSolana();

    const requestPath = rawPath;
    const targetUrl = `${options.apiUrl}${requestPath}`;
    let body = '';
    const requestStartTime = Date.now();

    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', async () => {
      let requestModel = currentModel || options.modelOverride || 'unknown';
      let usedFallback = false;

      try {
        if (options.debug) logger.debug(`[franklin] request: ${req.method} ${req.url} currentModel=${currentModel || 'none'}`);
        if (body) {
          try {
            const parsed = JSON.parse(body);

            // Intercept "use <model>" commands for in-session model switching
            if (parsed.messages) {
              const last = parsed.messages[parsed.messages.length - 1];
              if (options.debug) logger.debug(`[franklin] last msg role=${last?.role} content-type=${typeof last?.content} content=${JSON.stringify(last?.content).slice(0, 200)}`);
            }
            const switchCmd = detectModelSwitch(parsed);
            if (switchCmd) {
              currentModel = switchCmd;
              if (options.debug) logger.debug(`[franklin] model switched to: ${currentModel}`);
              const fakeResponse = {
                id: `msg_franklin_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                model: currentModel,
                content: [
                  {
                    type: 'text',
                    text: `Switched to **${currentModel}**. All subsequent requests will use this model.`,
                  },
                ],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 10 },
              };
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(fakeResponse));
              return;
            }

            // Model override logic:
            // - Native Anthropic-format IDs (e.g. "claude-sonnet-4-6-20250514")
            //   don't contain "/" — these MUST be replaced with currentModel.
            // - BlockRun model IDs always contain "/" (e.g. "blockrun/auto", "nvidia/nemotron-ultra-253b")
            //   — these should be passed through as-is.
            // - If --model CLI flag is set, always override regardless.
            if (options.modelOverride) {
              parsed.model = currentModel;
            } else if (!parsed.model || !parsed.model.includes('/')) {
              parsed.model = currentModel || DEFAULT_MODEL;
            }
            requestModel = parsed.model || DEFAULT_MODEL;

            // Smart routing: if model is a routing profile, classify and route
            const routingProfile = parseRoutingProfile(requestModel);
            if (routingProfile) {
              // Extract user prompt for classification
              const userMessages = parsed.messages?.filter(
                (m: { role: string }) => m.role === 'user'
              ) || [];
              const lastUserMsg = userMessages[userMessages.length - 1];
              let promptText = '';
              if (lastUserMsg) {
                if (typeof lastUserMsg.content === 'string') {
                  promptText = lastUserMsg.content;
                } else if (Array.isArray(lastUserMsg.content)) {
                  promptText = lastUserMsg.content
                    .filter((b: { type: string }) => b.type === 'text')
                    .map((b: { text: string }) => b.text)
                    .join('\n');
                }
              }

              // Route the request
              const routing = routeRequest(promptText, routingProfile);
              parsed.model = routing.model;
              requestModel = routing.model;

              logger.info(
                `[franklin] 🧠 Smart routing: ${routingProfile} → ${routing.tier} → ${routing.model} ` +
                `(${(routing.savings * 100).toFixed(0)}% savings) [${routing.signals.join(', ')}]`
              );
            }

            {
              const original = parsed.max_tokens;
              const model = (parsed.model || '').toLowerCase();
              const modelCap =
                model.includes('deepseek') ||
                model.includes('haiku') ||
                model.includes('gpt-oss')
                  ? 8192
                  : 16384;

              // Use max of (last output × 2, default 4096) capped by model limit
              // This ensures short replies don't starve the next request
              const lastOut = lastOutputByModel.get(requestModel) ?? 0;
              const adaptive =
                lastOut > 0
                  ? Math.max(lastOut * 2, DEFAULT_MAX_TOKENS)
                  : DEFAULT_MAX_TOKENS;
              parsed.max_tokens = Math.min(adaptive, modelCap);

              if (original !== parsed.max_tokens && options.debug) {
                logger.debug(`[franklin] max_tokens: ${original || 'unset'} → ${parsed.max_tokens} (last output: ${lastOut || 'none'})`);
              }
            }
            body = JSON.stringify(parsed);
          } catch {
            /* not JSON, pass through */
          }
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-Franklin-Version': X_FRANKLIN_VERSION,
        };
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            key.toLowerCase() !== 'host' &&
            key.toLowerCase() !== 'content-length' &&
            key.toLowerCase() !== 'user-agent' && // Don't forward client's user-agent
            value
          ) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
        }

        // Safety net: if requestModel is still a routing profile (blockrun/auto etc.)
        // after all resolution attempts, force-route it to a concrete model.
        // This prevents 404s from the backend which doesn't recognize virtual model names.
        if (ROUTING_PROFILES.has(requestModel) && body) {
          const virtualName = requestModel;
          const profile = parseRoutingProfile(requestModel);
          if (profile) {
            const fallbackRouting = routeRequest('', profile);
            requestModel = fallbackRouting.model;
            try {
              const parsed = JSON.parse(body);
              parsed.model = requestModel;
              body = JSON.stringify(parsed);
            } catch { /* body not JSON, skip */ }
            logger.warn(`[franklin] ⚠️  Safety net: resolved unrouted ${virtualName} → ${requestModel}`);
          }
        }

        // Build request init
        const requestInit: RequestInit = {
          method: req.method || 'POST',
          headers,
          body: body || undefined,
        };

        let response: Response;
        let finalModel = requestModel;
        // Real x402 charge for the call that ultimately succeeded. 0 when
        // no payment was needed (free model / cached). Fed into recordUsage
        // and appendAudit below so franklin-stats.json reflects what the
        // wallet actually paid, not a token-catalog estimate.
        let paidUsd = 0;
        const requestTimeoutMs = effectiveRequestTimeoutMs;

        // Use fallback chain if enabled
        if (fallbackEnabled && body && requestPath.includes('messages')) {
          const fallbackConfig: FallbackConfig = {
            ...DEFAULT_FALLBACK_CONFIG,
            chain: buildFallbackChain(requestModel),
          };

          const result = await fetchWithPaymentFallback(
            targetUrl,
            requestInit,
            body,
            fallbackConfig,
            {
              method: req.method || 'POST',
              headers,
              chain,
              baseWallet,
              solanaWallet,
              timeoutMs: requestTimeoutMs,
            },
            (failedModel, status, nextModel) => {
              // Skip test-fixture model names (slow/, mock/, test/, local/test*)
              // — these come from in-process proxy tests with mock servers and
              // would otherwise pollute the user's real franklin-debug.log.
              if (isTestFixtureModel(failedModel) || isTestFixtureModel(nextModel)) return;
              logger.warn(
                `[franklin] ⚠️  ${failedModel} returned ${status}, falling back to ${nextModel}`
              );
            }
          );

          response = result.response;
          finalModel = result.modelUsed;
          // Use the body with the correct fallback model for payment
          body = result.bodyUsed;
          usedFallback = result.fallbackUsed;
          paidUsd = result.paidUsd;

          // Skip the success log when the request originated from a test
          // fixture, even if the fallback ended on a real model. Verified
          // on a real machine: 5 spurious "↺ Fallback successful: using
          // deepseek/deepseek-chat" entries appeared in
          // franklin-debug.log because the proxy timeout test uses
          // `slow/model` (filtered) as the source but ends up on
          // `deepseek/deepseek-chat` (not filtered). Check the
          // failedModels array — any fixture in there means the call
          // chain started in a test.
          const fallbackTouchedFixture =
            result.failedModels.some(isTestFixtureModel) ||
            isTestFixtureModel(finalModel);
          if (usedFallback && !fallbackTouchedFixture) {
            logger.info(`[franklin] ↺ Fallback successful: using ${finalModel}`);
          }
        } else {
          const attempt = await fetchModelAttempt(targetUrl, requestInit, body, requestModel, {
            method: req.method || 'POST',
            headers,
            chain,
            baseWallet,
            solanaWallet,
            timeoutMs: requestTimeoutMs,
          });
          response = attempt.response;
          paidUsd = attempt.paidUsd;
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });

        // Intercept error responses and ensure Anthropic-format errors
        // so upstream CLI clients don't fall back to showing a login page
        if (response.status >= 400 && !responseHeaders['content-type']?.includes('text/event-stream')) {
          let errorBody: string;
          try {
            const rawText = await response.text();
            const parsed = JSON.parse(rawText);
            // Already has Anthropic error shape? Pass through
            if (parsed.type === 'error' && parsed.error) {
              errorBody = rawText;
            } else {
              // Wrap in Anthropic error format
              const errorMsg = parsed.error?.message || parsed.message || rawText.slice(0, 500);
              errorBody = JSON.stringify({
                type: 'error',
                error: {
                  type: response.status === 401 ? 'authentication_error'
                    : response.status === 402 ? 'invalid_request_error'
                    : response.status === 429 ? 'rate_limit_error'
                    : response.status === 400 ? 'invalid_request_error'
                    : 'api_error',
                  message: `[${finalModel}] ${errorMsg}`,
                },
              });
            }
          } catch {
            errorBody = JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: `Backend returned ${response.status}` },
            });
          }
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.end(errorBody);
          logger.warn(`[franklin] ⚠️  ${response.status} from backend for ${finalModel}`);
          return;
        }

        res.writeHead(response.status, responseHeaders);

        const isStreaming =
          responseHeaders['content-type']?.includes('text/event-stream');

        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let fullResponse = '';
          const STREAM_CAP = 5_000_000; // 5MB cap on accumulated stream

          const STREAM_TIMEOUT_MS = effectiveStreamTimeoutMs;
          const streamDeadline = Date.now() + STREAM_TIMEOUT_MS;

          const pump = async () => {
            while (true) {
              if (Date.now() > streamDeadline) {
                logger.warn('[franklin] ⚠️  Stream timeout after 5 minutes');
                try { reader.cancel(); } catch { /* ignore */ }
                break;
              }
              const { done, value } = await reader.read();
              if (done) {
                // Record stats from streaming response
                if (isStreaming && fullResponse) {
                  // Extract token usage from SSE stream by parsing message_delta events
                  let outputTokens = 0;
                  let inputTokens = 0;
                  // Find all data: lines and parse JSON to extract usage
                  for (const line of fullResponse.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const json = line.slice(6).trim();
                    if (json === '[DONE]') continue;
                    try {
                      const parsed = JSON.parse(json);
                      if (parsed.usage?.output_tokens) outputTokens = parsed.usage.output_tokens;
                      if (parsed.usage?.input_tokens) inputTokens = parsed.usage.input_tokens;
                    } catch { /* skip malformed */ }
                  }
                  if (outputTokens > 0) {
                    trackOutputTokens(finalModel, outputTokens);
                    const latencyMs = Date.now() - requestStartTime;
                    // Real x402 charge wins over the token-catalog estimate.
                    // estimateCost only fills in for the no-payment path
                    // (free models / cached) so stats stay non-null there.
                    const cost = paidUsd > 0
                      ? paidUsd
                      : estimateCost(finalModel, inputTokens, outputTokens);
                    const costSource = paidUsd > 0 ? 'charged' : 'estimated';

                    recordUsage(
                      finalModel,
                      inputTokens,
                      outputTokens,
                      cost,
                      latencyMs,
                      usedFallback
                    );
                    appendAudit({
                      ts: Date.now(),
                      model: finalModel,
                      inputTokens,
                      outputTokens,
                      costUsd: cost,
                      latencyMs,
                      fallback: usedFallback,
                      source: 'proxy',
                    });
                    if (options.debug) logger.debug(`[franklin] recorded: model=${finalModel} in=${inputTokens} out=${outputTokens} cost=$${cost.toFixed(4)} (${costSource}) fallback=${usedFallback}`);
                  }
                }
                res.end();
                break;
              }
              if (isStreaming && fullResponse.length < STREAM_CAP) {
                const chunk = decoder.decode(value, { stream: true });
                fullResponse += chunk;
              }
              res.write(value);
            }
          };
          pump().catch((err) => {
            logger.error(`[franklin] ❌ Stream error: ${err instanceof Error ? err.message : String(err)}`);
            res.end();
          });
        } else {
          const text = await response.text();
          try {
            const parsed = JSON.parse(text);
            if (parsed.usage?.output_tokens) {
              const outputTokens = parsed.usage.output_tokens;
              trackOutputTokens(finalModel, outputTokens);
              const inputTokens = parsed.usage?.input_tokens || 0;
              const latencyMs = Date.now() - requestStartTime;
              const cost = paidUsd > 0
                ? paidUsd
                : estimateCost(finalModel, inputTokens, outputTokens);
              const costSource = paidUsd > 0 ? 'charged' : 'estimated';

              recordUsage(
                finalModel,
                inputTokens,
                outputTokens,
                cost,
                latencyMs,
                usedFallback
              );
              appendAudit({
                ts: Date.now(),
                model: finalModel,
                inputTokens,
                outputTokens,
                costUsd: cost,
                latencyMs,
                fallback: usedFallback,
                source: 'proxy',
              });
              if (options.debug) logger.debug(`[franklin] recorded: model=${finalModel} in=${inputTokens} out=${outputTokens} cost=$${cost.toFixed(4)} (${costSource}) fallback=${usedFallback}`);
            }
          } catch {
            /* not JSON */
          }
          res.end(text);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Proxy error';
        logger.error(`[franklin] ❌ Error: ${msg}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: msg },
          })
        );
      }
    });
  });

  return server;
}

interface ProxyPaymentContext {
  method: string;
  headers: Record<string, string>;
  chain: Chain;
  baseWallet: { privateKey: string; address: string } | null;
  solanaWallet: { privateKey: string; address: string } | null;
  timeoutMs: number;
}

interface ProxyFallbackResult {
  response: Response;
  modelUsed: string;
  bodyUsed: string;
  fallbackUsed: boolean;
  attemptsCount: number;
  failedModels: string[];
  /**
   * Actual USDC charged for this call (parsed from the x402 payment header
   * the gateway demanded). 0 when no payment was needed — free model,
   * cached response, or non-402 path. This is the source of truth for
   * stats; estimateCost() is only kept as a fallback.
   */
  paidUsd: number;
}

interface ProxyAttemptResult {
  response: Response;
  paidUsd: number;
}

async function fetchModelAttempt(
  url: string,
  init: RequestInit,
  body: string,
  model: string,
  payment: ProxyPaymentContext
): Promise<ProxyAttemptResult> {
  const response = await fetchWithTimeout(
    url,
    { ...init, body: body || undefined },
    payment.timeoutMs,
    `Proxy request for ${model}`
  );

  // Non-402 path: free model or cached response — no payment, paidUsd = 0.
  if (response.status !== 402) return { response, paidUsd: 0 };

  if (payment.chain === 'solana' && payment.solanaWallet) {
    return handleSolanaPayment(
      response,
      url,
      payment.method,
      payment.headers,
      body,
      payment.solanaWallet.privateKey,
      payment.solanaWallet.address,
      payment.timeoutMs,
      model
    );
  }

  if (payment.baseWallet) {
    return handleBasePayment(
      response,
      url,
      payment.method,
      payment.headers,
      body,
      payment.baseWallet.privateKey as `0x${string}`,
      payment.baseWallet.address,
      payment.timeoutMs,
      model
    );
  }

  return { response, paidUsd: 0 };
}

/**
 * Try each fallback model as a full x402 attempt:
 * unpaid 402 probe, payment signing, then the paid provider call. The older
 * flow only applied fallback to the probe, which meant a slow paid call could
 * hang Franklin until the outer client gave up.
 */
async function fetchWithPaymentFallback(
  url: string,
  init: RequestInit,
  originalBody: string,
  config: FallbackConfig,
  payment: ProxyPaymentContext,
  onFallback?: (model: string, statusCode: number, nextModel: string) => void
): Promise<ProxyFallbackResult> {
  const failedModels: string[] = [];
  let attempts = 0;

  for (let i = 0; i < config.chain.length && attempts < config.maxRetries; i++) {
    const model = config.chain[i];
    const body = replaceModelInBody(originalBody, model);

    try {
      attempts++;
      const { response, paidUsd } = await fetchModelAttempt(url, init, body, model, payment);

      if (!config.retryOn.includes(response.status)) {
        return {
          response,
          modelUsed: model,
          bodyUsed: body,
          fallbackUsed: i > 0,
          attemptsCount: attempts,
          failedModels,
          paidUsd,
        };
      }

      try { await response.body?.cancel(); } catch { /* ignore */ }
      failedModels.push(model);

      const nextModel = config.chain[i + 1];
      if (nextModel && onFallback) {
        onFallback(model, response.status, nextModel);
      }

      if (i < config.chain.length - 1) {
        await sleep(config.retryDelayMs);
      }
    } catch (err) {
      failedModels.push(model);
      const nextModel = config.chain[i + 1];

      if (nextModel && onFallback) {
        onFallback(model, 0, nextModel);
      }
      if (!isTestFixtureModel(model)) {
        logger.warn(
          `[franklin] [fallback] ${model} request error: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      if (i < config.chain.length - 1) {
        await sleep(config.retryDelayMs);
      }
    }
  }

  throw new Error(
    `All models in fallback chain failed: ${failedModels.join(', ')}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ======================================================================
// Base (EIP-712) payment handler
// ======================================================================

async function handleBasePayment(
  response: Response,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  privateKey: `0x${string}`,
  fromAddress: string,
  timeoutMs = getProxyRequestTimeoutMs(),
  model = 'unknown'
): Promise<ProxyAttemptResult> {
  const paymentHeader = await extractPaymentHeader(response);
  if (!paymentHeader) {
    throw new Error('402 Payment Required — wallet may need funding. Open http://localhost:3100/#wallet to deposit USDC (or run: franklin balance)');
  }

  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired);
  const paidUsd = paymentAmountToUsd(details.amount);
  appendSettlementRow(extractEndpointPath(url), paidUsd, {
    model,
    wallet: fromAddress,
    network: details.network || 'base-mainnet',
    client_kind: 'ProxyClient',
  });

  const paymentPayload = await createPaymentPayload(
    privateKey,
    fromAddress,
    details.recipient,
    details.amount,
    details.network || 'eip155:8453',
    {
      resourceUrl: details.resource?.url || url,
      resourceDescription:
        details.resource?.description || 'BlockRun AI API call',
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra,
    }
  );

  const paid = await fetchWithTimeout(url, {
    method,
    headers: {
      ...headers,
      'PAYMENT-SIGNATURE': paymentPayload,
    },
    body: body || undefined,
  }, timeoutMs, `Paid proxy request for ${model}`);

  return { response: paid, paidUsd };
}

// ======================================================================
// Solana payment handler
// ======================================================================

async function handleSolanaPayment(
  response: Response,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  privateKey: string,
  fromAddress: string,
  timeoutMs = getProxyRequestTimeoutMs(),
  model = 'unknown'
): Promise<ProxyAttemptResult> {
  const paymentHeader = await extractPaymentHeader(response);
  if (!paymentHeader) {
    throw new Error('402 Payment Required — wallet may need funding. Open http://localhost:3100/#wallet to deposit USDC (or run: franklin balance)');
  }

  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
  const paidUsd = paymentAmountToUsd(details.amount);
  appendSettlementRow(extractEndpointPath(url), paidUsd, {
    model,
    wallet: fromAddress,
    network: details.network || 'solana-mainnet',
    client_kind: 'ProxyClient',
  });

  const secretKey = await solanaKeyToBytes(privateKey);

  const feePayer = details.extra?.feePayer || details.recipient;

  const paymentPayload = await createSolanaPaymentPayload(
    secretKey,
    fromAddress,
    details.recipient,
    details.amount,
    feePayer,
    {
      resourceUrl: details.resource?.url || url,
      resourceDescription:
        details.resource?.description || 'BlockRun AI API call',
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra as Record<string, unknown> | undefined,
    }
  );

  const paid = await fetchWithTimeout(url, {
    method,
    headers: {
      ...headers,
      'PAYMENT-SIGNATURE': paymentPayload,
    },
    body: body || undefined,
  }, timeoutMs, `Paid proxy request for ${model}`);

  return { response: paid, paidUsd };
}

/**
 * Extract just the path portion of a URL — `https://api.blockrun.ai/v1/messages`
 * → `/v1/messages`. Used as the `endpoint` field in `cost_log.jsonl` so
 * proxy entries match the SDK's path-only convention. Falls back to the
 * raw input if URL parsing throws (defensive — better to log a weird
 * string than skip the row).
 */
function extractEndpointPath(url: string): string {
  try { return new URL(url).pathname || url; } catch { return url; }
}

/**
 * Convert an x402 `details.amount` field (USDC in micro-units, 6 decimals)
 * to a USD float. Mirrors the SDK's `appendCostLog` math so the proxy and
 * `cost_log.jsonl` agree to the cent.
 */
function paymentAmountToUsd(amount: string | number | undefined): number {
  if (amount === undefined || amount === null) return 0;
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return 0;
  return n / 1e6;
}

// ======================================================================
// Request classification (smart routing infrastructure)
// ======================================================================

type RequestCategory = 'simple' | 'code' | 'default';

interface ClassifiedRequest {
  category: RequestCategory;
  suggestedModel?: string;
}

export function classifyRequest(body: string): ClassifiedRequest {
  try {
    const parsed = JSON.parse(body);
    const messages = parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { category: 'default' };
    }

    const lastMessage = messages[messages.length - 1];
    let content = '';
    if (typeof lastMessage.content === 'string') {
      content = lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
      content = lastMessage.content
        .filter(
          (b: { type: string; text?: string }) => b.type === 'text' && b.text
        )
        .map((b: { text: string }) => b.text)
        .join('\n');
    }

    if (
      content.includes('```') ||
      content.includes('function ') ||
      content.includes('class ') ||
      content.includes('import ') ||
      content.includes('def ') ||
      content.includes('const ')
    ) {
      return { category: 'code' };
    }

    if (content.length < 100) {
      return { category: 'simple' };
    }

    return { category: 'default' };
  } catch {
    return { category: 'default' };
  }
}

// ======================================================================
// Shared helpers
// ======================================================================

async function extractPaymentHeader(
  response: Response
): Promise<string | null> {
  let paymentHeader = response.headers.get('payment-required');

  if (!paymentHeader) {
    try {
      const respBody = (await response.json()) as Record<string, unknown>;
      if (respBody.x402 || respBody.accepts) {
        paymentHeader = btoa(JSON.stringify(respBody));
      }
    } catch {
      // ignore parse errors
    }
  }

  return paymentHeader;
}
