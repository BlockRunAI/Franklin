/**
 * Slack ingress channel — drive Franklin from a Slack workspace.
 *
 * Why this exists: same motivation as the Telegram channel, but for teams.
 * A persistent agent with a wallet is most useful when a whole channel can
 * reach it. This module wraps Franklin's `interactiveSession` with a Slack
 * Socket Mode connection: inbound @mentions (and DMs) → agent turn → streamed
 * text deltas posted back into the originating thread.
 *
 * Multi-user: unlike Telegram's single-owner lock, Slack uses an allowlist of
 * user ids (`SLACK_ALLOWED_USERS`). Anyone on the list can @mention the bot in
 * a channel or DM it; everyone else is ignored. The wallet is real money, so
 * an empty allowlist denies everyone by default.
 *
 * Session model (MVP v1): ONE shared session for the running bot, exactly like
 * the Telegram channel. All authorized users share a single Franklin
 * conversation. Replies always land in a thread so the channel stays tidy.
 * NOTE: Hermes-style per-thread isolation (a separate concurrent session per
 * Slack thread) is the planned v2 — it needs a session-manager that runs
 * multiple `interactiveSession` instances at once, which this single-queue
 * design intentionally does not do yet.
 *
 * Transport: Socket Mode (WebSocket via @slack/bolt), not Events API webhooks.
 * Works behind NAT / through laptop sleep-wake without a public HTTPS endpoint.
 */

import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import type { AgentConfig, Dialogue, StreamEvent } from '../agent/types.js';
import { interactiveSession } from '../agent/loop.js';
import { ModelClient } from '../agent/llm.js';
import { extractBrainEntities } from '../brain/extract.js';
import { extractLearnings } from '../learnings/extractor.js';

// Slack's hard per-message cap is ~40 KB, but readability tanks long before
// that. Keep chunks small so a long answer arrives as a few tidy messages.
const CHUNK_MAX = 3500;
// Progressive flush: emit a partial message once the buffer crosses this and
// hits a paragraph boundary, mirroring the Telegram channel's behaviour.
const PROGRESSIVE_FLUSH_MIN = 1200;

export interface SlackOptions {
  /** Bot User OAuth token (xoxb-…), from the Slack app's OAuth page. */
  botToken: string;
  /** App-level token (xapp-…) with connections:write, for Socket Mode. */
  appToken: string;
  /** Slack user ids allowed to drive the bot. Empty set denies everyone. */
  allowedUsers: Set<string>;
  /** Verbose: log every inbound event and turn on bolt's DEBUG logging. */
  debug?: boolean;
  /** Called with each user-facing log line so the CLI can print them. */
  log?: (line: string) => void;
}

/**
 * Where a reply should be posted. `threadTs` is set for channel mentions (so
 * replies stay grouped in a thread) but left undefined for top-level DMs —
 * threading a DM reply hides it in a sub-thread the user isn't looking at.
 */
interface SlackTarget {
  channel: string;
  threadTs?: string;
}

/**
 * Split a long agent response into Slack-sized chunks. Prefers newline
 * boundaries, falls back to a hard character split for pathological inputs.
 * Short responses return a single chunk. Mirrors `splitForTelegram`.
 */
export function splitForSlack(text: string, max = CHUNK_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const windowEnd = Math.min(max, remaining.length);
    const nlIdx = remaining.lastIndexOf('\n', windowEnd - 1);
    const cut = nlIdx > Math.floor(max * 0.5) ? nlIdx + 1 : windowEnd;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Progressive flush: given a growing buffer, return `{flush, keep}` where
 * `flush` ends at a paragraph boundary and `keep` is the trailing partial to
 * hold until more arrives. Identical strategy to the Telegram channel.
 */
export function takeProgressiveChunk(
  buffer: string,
  threshold = PROGRESSIVE_FLUSH_MIN,
  hardCap = CHUNK_MAX,
): { flush: string; keep: string } {
  const mustFlush = buffer.length > hardCap;
  if (!mustFlush && buffer.length < threshold) {
    return { flush: '', keep: buffer };
  }
  const preferPos = buffer.lastIndexOf('\n\n', Math.min(buffer.length, hardCap) - 1);
  if (preferPos > Math.floor(threshold * 0.5)) {
    return { flush: buffer.slice(0, preferPos + 2), keep: buffer.slice(preferPos + 2) };
  }
  const nlPos = buffer.lastIndexOf('\n', Math.min(buffer.length, hardCap) - 1);
  if (nlPos > Math.floor(threshold * 0.5)) {
    return { flush: buffer.slice(0, nlPos + 1), keep: buffer.slice(nlPos + 1) };
  }
  if (mustFlush) {
    return { flush: buffer.slice(0, hardCap), keep: buffer.slice(hardCap) };
  }
  return { flush: '', keep: buffer };
}

/** Strip a leading `<@BOTID>` (and any extra mentions) from an app_mention. */
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Start the bot. Resolves only on fatal error; the outer CLI handles SIGINT.
 */
export async function runSlackBot(
  agentConfig: AgentConfig,
  opts: SlackOptions,
): Promise<void> {
  const log = opts.log ?? (() => {});

  // Lazy import keeps @slack/bolt out of the load path for users who never
  // run the Slack bot, matching how heavy optional deps are handled elsewhere.
  const { App, LogLevel } = await import('@slack/bolt');

  const state = {
    inputQueue: [] as string[],
    inputWaiters: [] as Array<(v: string | null) => void>,
    currentTarget: undefined as SlackTarget | undefined,
    responseBuffer: '',
    running: true,
    restartRequested: false,
    botUserId: undefined as string | undefined,
    // Tools the current turn has called — posted as ONE summary on turn_done,
    // mirroring the Telegram channel (a per-tool message floods the thread).
    toolsUsed: [] as string[],
  };

  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: opts.debug ? LogLevel.DEBUG : LogLevel.WARN,
  });

  // ── Slack send helpers ───────────────────────────────────────────────
  const postMessage = async (target: SlackTarget, text: string): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await app.client.chat.postMessage({
          channel: target.channel,
          ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
          text,
        });
        return;
      } catch (err) {
        if (attempt === 1) {
          log(`[slack] postMessage failed: ${(err as Error).message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  const postChunked = async (target: SlackTarget, text: string): Promise<void> => {
    const chunks = splitForSlack(text);
    if (chunks.length === 1) {
      await postMessage(target, chunks[0]);
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      await postMessage(target, `[${i + 1}/${chunks.length}] ${chunks[i]}`);
    }
  };

  // ── Bot control commands (handled here, not by the agent) ─────────────
  // Slack swallows unregistered "/foo" slash commands, but inside an
  // @mention the text "@bot /new" reaches us intact, so these still work.
  const handleControlCommand = async (target: SlackTarget, text: string): Promise<boolean> => {
    const cmd = text.trim().toLowerCase();
    switch (cmd) {
      case '/help':
      case 'help':
        await postMessage(
          target,
          'Franklin bot\n' +
            '• `/new` — start a fresh conversation (clears history)\n' +
            '• `/balance` — show wallet USDC balance\n' +
            '• `/status` — chain, model, permission mode\n' +
            'Anything else is forwarded to the agent.',
        );
        return true;
      case '/new':
        state.restartRequested = true;
        state.inputQueue.length = 0;
        // Drop tools recorded by a turn this reset interrupts, so they don't
        // leak into the new conversation's first summary.
        state.toolsUsed = [];
        {
          const waiters = state.inputWaiters.splice(0);
          for (const w of waiters) w(null);
        }
        await postMessage(target, '🔄 Starting a new conversation…');
        return true;
      case '/balance': {
        try {
          if (agentConfig.chain === 'solana') {
            const c = await setupAgentSolanaWallet({ silent: true });
            const addr = await c.getWalletAddress();
            const bal = await c.getBalance();
            await postMessage(target, `Chain: solana\nWallet: ${addr}\nBalance: $${bal.toFixed(2)} USDC`);
          } else {
            const c = setupAgentWallet({ silent: true });
            const addr = c.getWalletAddress();
            const bal = await c.getBalance();
            await postMessage(target, `Chain: base\nWallet: ${addr}\nBalance: $${bal.toFixed(2)} USDC`);
          }
        } catch (err) {
          await postMessage(target, `Couldn't fetch balance: ${(err as Error).message}`);
        }
        return true;
      }
      case '/status':
        await postMessage(
          target,
          `chain: ${agentConfig.chain}\n` +
            `model: ${agentConfig.model}\n` +
            `permission: ${agentConfig.permissionMode ?? 'default'}`,
        );
        return true;
      default:
        return false;
    }
  };

  // ── Input queue (feeds interactiveSession's getUserInput) ─────────────
  const enqueueInput = (target: SlackTarget, text: string): void => {
    state.currentTarget = target;
    if (state.inputWaiters.length > 0) {
      const w = state.inputWaiters.shift()!;
      w(text);
    } else {
      state.inputQueue.push(text);
    }
  };

  const waitNextInput = (): Promise<string | null> => {
    if (state.restartRequested) return Promise.resolve(null);
    if (state.inputQueue.length > 0) {
      return Promise.resolve(state.inputQueue.shift()!);
    }
    if (!state.running) return Promise.resolve(null);
    return new Promise((resolve) => state.inputWaiters.push(resolve));
  };

  // ── Event sink — progressive flush with a final sweep on turn_done ────
  const flushProgressive = (): void => {
    if (!state.currentTarget) return;
    const { flush, keep } = takeProgressiveChunk(state.responseBuffer);
    if (flush.trim()) {
      const target = state.currentTarget;
      state.responseBuffer = keep;
      void postMessage(target, flush.trim());
    }
  };

  const handleEvent = (event: StreamEvent): void => {
    switch (event.kind) {
      case 'text_delta':
        state.responseBuffer += event.text;
        if (state.responseBuffer.length >= PROGRESSIVE_FLUSH_MIN) {
          flushProgressive();
        }
        break;
      case 'capability_start':
        // Record the tool (for the turn-end summary) and flush buffered text so
        // narrative order reads right. No per-tool message — a multi-tool run
        // otherwise floods the thread (same fix as the Telegram channel).
        if (event.name) state.toolsUsed.push(event.name);
        if (state.currentTarget && state.responseBuffer.trim()) {
          const target = state.currentTarget;
          const text = state.responseBuffer.trim();
          state.responseBuffer = '';
          void postMessage(target, text);
        }
        break;
      case 'turn_done': {
        const target = state.currentTarget;
        const text = state.responseBuffer.trim();
        state.responseBuffer = '';
        if (target && text) void postChunked(target, text);
        // One tool summary per turn, mirroring Telegram.
        if (target && state.toolsUsed.length) {
          const uniq = [...new Set(state.toolsUsed)];
          void postMessage(target, `🔧 Used ${state.toolsUsed.length} tool${state.toolsUsed.length === 1 ? '' : 's'}: ${uniq.join(' · ')}`);
        }
        state.toolsUsed = [];
        if (event.reason === 'error' && event.error && target) {
          void postMessage(target, `❌ Error: ${event.error}`);
        }
        break;
      }
    }
  };

  // ── Inbound routing ───────────────────────────────────────────────────
  const authorized = (userId: string | undefined): boolean =>
    !!userId && opts.allowedUsers.has(userId);

  const ingest = async (
    userId: string | undefined,
    channel: string,
    threadTs: string | undefined,
    rawText: string,
  ): Promise<void> => {
    const target: SlackTarget = { channel, threadTs };
    if (!authorized(userId)) {
      log(`[slack] rejected unauthorized sender id=${userId ?? 'n/a'}`);
      await postMessage(target, 'Not authorized.');
      return;
    }
    const text = stripMentions(rawText);
    if (!text) return;
    log(`[slack] ← ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);

    if (text.startsWith('/') || text.toLowerCase() === 'help') {
      state.currentTarget = target;
      const handled = await handleControlCommand(target, text);
      if (handled) return;
      // Unknown command falls through to the agent (it has its own slash
      // handling for /retry, /model, /cost, …).
    }
    enqueueInput(target, text);
  };

  // app_mention: someone @mentioned the bot in a channel. Reply in-thread so
  // the conversation stays grouped; a top-level mention starts a new thread.
  app.event('app_mention', async ({ event }) => {
    const e = event as { user?: string; channel: string; ts: string; thread_ts?: string; text: string };
    await ingest(e.user, e.channel, e.thread_ts ?? e.ts, e.text);
  });

  // Direct messages to the bot. Ignore the bot's own messages, edits, and
  // any message that carries a subtype (joins, file shares, etc.).
  app.message(async ({ message }) => {
    const m = message as {
      channel_type?: string;
      subtype?: string;
      user?: string;
      bot_id?: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      text?: string;
    };
    if (opts.debug) {
      log(
        `[slack] message event: channel_type=${m.channel_type} subtype=${m.subtype ?? '-'} ` +
          `bot_id=${m.bot_id ?? '-'} user=${m.user ?? '-'} text=${(m.text ?? '').slice(0, 40)}`,
      );
    }
    if (m.channel_type !== 'im') return; // channel posts arrive via app_mention
    if (m.subtype || m.bot_id || !m.text) return;
    if (m.user && m.user === state.botUserId) return;
    // DMs reply at top level; only stay threaded if the user is already in one.
    await ingest(m.user, m.channel, m.thread_ts, m.text);
  });

  // ── Connect ────────────────────────────────────────────────────────────
  try {
    const auth = (await app.client.auth.test()) as { user_id?: string; team?: string };
    state.botUserId = auth.user_id;
    await app.start();
    log(
      `[slack] connected as bot ${auth.user_id ?? '(unknown)'} ` +
        `team=${auth.team ?? '?'} — ${opts.allowedUsers.size} allowed user(s)`,
    );
  } catch (err) {
    throw new Error(`Slack connect failed: ${(err as Error).message}`);
  }

  // Shared LLM client for post-session extraction (built once).
  const extractor = new ModelClient({
    apiUrl: agentConfig.apiUrl,
    chain: agentConfig.chain,
  });

  const harvestSession = async (history: Dialogue[]): Promise<void> => {
    if (history.length < 4) return;
    const sid = `slack-${new Date().toISOString()}`;
    try {
      await Promise.race([
        Promise.all([
          extractLearnings(history, sid, extractor),
          extractBrainEntities(history, sid, extractor),
        ]),
        new Promise((r) => setTimeout(r, 15_000)),
      ]);
    } catch (err) {
      log(`[slack] post-session extraction failed: ${(err as Error).message}`);
    }
  };

  // ── Outer session loop (mirrors the Telegram channel) ─────────────────
  try {
    let firstSession = true;
    while (state.running) {
      state.restartRequested = false;
      if (!firstSession) agentConfig.resumeSessionId = undefined;
      firstSession = false;
      const history = await interactiveSession(agentConfig, waitNextInput, handleEvent);
      void harvestSession(history);
      if (!state.restartRequested) break;
      log('[slack] session reset by /new');
    }
  } finally {
    state.running = false;
    const waiters = state.inputWaiters.splice(0);
    for (const w of waiters) w(null);
    await app.stop().catch(() => {});
  }
}
