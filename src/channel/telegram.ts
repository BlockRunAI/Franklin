/**
 * Telegram ingress channel — drive Franklin from a Telegram chat.
 *
 * Why this exists: a persistent agent with a wallet is most useful when the
 * owner can reach it from anywhere, not just the laptop it runs on. This
 * module wraps Franklin's `interactiveSession` with a Telegram long-polling
 * loop: inbound text → agent turn → streamed text deltas delivered to the
 * originating chat, chunked to stay under Telegram's 4096-char limit.
 *
 * Security: hard owner lock. Only the Telegram user id listed in
 * `TELEGRAM_OWNER_ID` can talk to the bot. Anyone else gets a polite refusal
 * and their message is dropped — the agent's wallet is real money.
 *
 * Transport: long polling (`getUpdates` with `timeout=25`), not webhook.
 * Works behind NAT and through laptop sleep/wake without needing a public
 * HTTPS endpoint. `node fetch` is the only HTTP dep.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import type { AgentConfig, Dialogue, StreamEvent } from '../agent/types.js';
import { interactiveSession } from '../agent/loop.js';
import { ModelClient } from '../agent/llm.js';
import { extractBrainEntities } from '../brain/extract.js';
import { extractLearnings } from '../learnings/extractor.js';

// Per-bot prefs (persisted so a restart keeps the user's choice).
const PREFS_FILE = path.join(os.homedir(), '.blockrun', 'telegram-prefs.json');
function loadPrefs(): { showTools?: boolean } {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); } catch { return {}; }
}
function savePrefs(prefs: { showTools?: boolean }): void {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}

const TG_API = 'https://api.telegram.org';
const POLL_TIMEOUT_SECONDS = 25;
// Telegram caps messages at 4096 chars; keep a margin so our chunk headers
// (e.g. "[1/3] ") plus any UTF-16 counting quirks stay inside the limit.
const CHUNK_MAX = 4000;
// Progressive flush: send a partial message once the buffer crosses this and
// hits a paragraph boundary. Tuned so a typical multi-paragraph answer
// arrives as 2–3 messages instead of one 4000-char wall.
const PROGRESSIVE_FLUSH_MIN = 1500;

export interface TelegramOptions {
  /** Bot token from @BotFather. */
  token: string;
  /** Numeric Telegram user id that's allowed to drive the bot. Required. */
  ownerId: number;
  /** Extra numeric user ids allowed to drive the bot (e.g. other people in a
   *  group). The owner is always allowed; this widens access without dropping
   *  the lock. Empty/undefined → owner-only (original behaviour). */
  allowedUsers?: Set<number>;
  /** Called with each user-facing log line so the CLI can print them. */
  log?: (line: string) => void;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    reply_to_message?: { from?: { id?: number; is_bot?: boolean } };
  };
}

/**
 * Split a long agent response into Telegram-sized chunks. Prefers newline
 * boundaries, falls back to hard character split for pathological inputs
 * (e.g. 10 KB of no-newline JSON). Short responses return a single chunk.
 */
export function splitForTelegram(text: string, max = CHUNK_MAX): string[] {
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
 * `flush` is ready-to-send text ending at a paragraph boundary and `keep` is
 * the trailing partial to hold until more arrives. Returns `{flush: '',
 * keep: buffer}` if the buffer isn't big enough or has no boundary yet.
 */
export function takeProgressiveChunk(
  buffer: string,
  threshold = PROGRESSIVE_FLUSH_MIN,
  hardCap = CHUNK_MAX,
): { flush: string; keep: string } {
  // Hard cap overrides threshold: if we're above the cap we MUST flush
  // something, boundary or not, to avoid a 4096 overrun on final send.
  const mustFlush = buffer.length > hardCap;
  if (!mustFlush && buffer.length < threshold) {
    return { flush: '', keep: buffer };
  }
  // Prefer a paragraph break (double newline) near the threshold.
  const preferPos = buffer.lastIndexOf('\n\n', Math.min(buffer.length, hardCap) - 1);
  if (preferPos > Math.floor(threshold * 0.5)) {
    return { flush: buffer.slice(0, preferPos + 2), keep: buffer.slice(preferPos + 2) };
  }
  // Fall back to any newline.
  const nlPos = buffer.lastIndexOf('\n', Math.min(buffer.length, hardCap) - 1);
  if (nlPos > Math.floor(threshold * 0.5)) {
    return { flush: buffer.slice(0, nlPos + 1), keep: buffer.slice(nlPos + 1) };
  }
  // Must flush but no newline — hard split at hardCap only.
  if (mustFlush) {
    return { flush: buffer.slice(0, hardCap), keep: buffer.slice(hardCap) };
  }
  return { flush: '', keep: buffer };
}

/**
 * Start the bot. Resolves only on fatal error; the outer CLI handles SIGINT.
 */
export async function runTelegramBot(
  agentConfig: AgentConfig,
  opts: TelegramOptions,
): Promise<void> {
  const log = opts.log ?? (() => {});
  const state = {
    offset: 0,
    inputQueue: [] as string[],
    inputWaiters: [] as Array<(v: string | null) => void>,
    currentChatId: undefined as number | undefined,
    responseBuffer: '',
    running: true,
    restartRequested: false,
    stoppedBy: undefined as Error | undefined,
    // Tool names used in the current turn → one summary at turn end (not one
    // message per call). `showTools` gates whether that summary is sent.
    toolsUsed: [] as string[],
    showTools: loadPrefs().showTools ?? true,
  };

  // ── Telegram HTTP helpers ────────────────────────────────────────────
  const api = async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${TG_API}/bot${opts.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram ${method} failed: ${json.description ?? 'unknown'}`);
    }
    return json.result as T;
  };

  const sendMessage = async (chatId: number, text: string): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await api<unknown>('sendMessage', { chat_id: chatId, text });
        return;
      } catch (err) {
        if (attempt === 1) {
          log(`[telegram] sendMessage failed: ${(err as Error).message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  const sendChunked = async (chatId: number, text: string): Promise<void> => {
    const chunks = splitForTelegram(text);
    if (chunks.length === 1) {
      await sendMessage(chatId, chunks[0]);
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      await sendMessage(chatId, `[${i + 1}/${chunks.length}] ${chunks[i]}`);
    }
  };

  // ── Slash commands (handled by the bot, not the agent) ──────────────
  const handleSlashCommand = async (chatId: number, text: string): Promise<boolean> => {
    const cmd = text.trim().toLowerCase();

    // `/tools` toggles the per-turn tool summary (takes on/off, or bare = flip).
    if (cmd === '/tools' || cmd.startsWith('/tools ')) {
      const arg = cmd.slice('/tools'.length).trim();
      state.showTools = arg === 'on' ? true : arg === 'off' ? false : !state.showTools;
      savePrefs({ showTools: state.showTools });
      await sendMessage(chatId, `🔧 Tool summary: ${state.showTools ? 'on ✅' : 'off'}`);
      return true;
    }

    switch (cmd) {
      case '/start':
      case '/help':
        await sendMessage(
          chatId,
          'Franklin bot\n\n' +
            '/new — start a fresh conversation (clears history)\n' +
            '/tools [on|off] — toggle the per-turn tool-usage summary\n' +
            '/balance — show wallet USDC balance\n' +
            '/status — show chain, model, and session stats\n' +
            '/help — this message\n\n' +
            'Any other message is forwarded to the agent.',
        );
        return true;
      case '/new':
        state.restartRequested = true;
        // Drain any pending input and wake the session so it unwinds.
        state.inputQueue.length = 0;
        // Drop tools recorded by a turn this reset interrupts, so they don't
        // leak into the new conversation's first summary.
        state.toolsUsed = [];
        {
          const waiters = state.inputWaiters.splice(0);
          for (const w of waiters) w(null);
        }
        await sendMessage(chatId, '🔄 Starting a new conversation…');
        return true;
      case '/balance': {
        try {
          if (agentConfig.chain === 'solana') {
            const c = await setupAgentSolanaWallet({ silent: true });
            const addr = await c.getWalletAddress();
            const bal = await c.getBalance();
            await sendMessage(
              chatId,
              `Chain: solana\nWallet: ${addr}\nBalance: $${bal.toFixed(2)} USDC`,
            );
          } else {
            const c = setupAgentWallet({ silent: true });
            const addr = c.getWalletAddress();
            const bal = await c.getBalance();
            await sendMessage(
              chatId,
              `Chain: base\nWallet: ${addr}\nBalance: $${bal.toFixed(2)} USDC`,
            );
          }
        } catch (err) {
          await sendMessage(chatId, `Couldn't fetch balance: ${(err as Error).message}`);
        }
        return true;
      }
      case '/status':
        await sendMessage(
          chatId,
          `chain: ${agentConfig.chain}\n` +
            `model: ${agentConfig.model}\n` +
            `permission: ${agentConfig.permissionMode ?? 'default'}`,
        );
        return true;
      default:
        return false;
    }
  };

  // ── Input queue (feeds interactiveSession's getUserInput) ────────────
  const enqueueInput = (chatId: number, text: string): void => {
    state.currentChatId = chatId;
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

  // ── Event sink — progressive flush with a final sweep on turn_done ──
  const flushProgressive = (): void => {
    if (state.currentChatId === undefined) return;
    const { flush, keep } = takeProgressiveChunk(state.responseBuffer);
    if (flush.trim()) {
      const chatId = state.currentChatId;
      state.responseBuffer = keep;
      void sendMessage(chatId, flush.trim());
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
        // otherwise floods the chat.
        if (event.name) state.toolsUsed.push(event.name);
        if (state.currentChatId !== undefined && state.responseBuffer.trim()) {
          const chatId = state.currentChatId;
          const text = state.responseBuffer.trim();
          state.responseBuffer = '';
          void sendMessage(chatId, text);
        }
        break;
      case 'turn_done': {
        const chatId = state.currentChatId;
        const text = state.responseBuffer.trim();
        state.responseBuffer = '';
        if (chatId !== undefined && text) void sendChunked(chatId, text);
        // One tool summary per turn (toggle with /tools).
        if (chatId !== undefined && state.showTools && state.toolsUsed.length) {
          const uniq = [...new Set(state.toolsUsed)];
          void sendMessage(chatId, `🔧 Used ${state.toolsUsed.length} tool${state.toolsUsed.length === 1 ? '' : 's'}: ${uniq.join(' · ')}`);
        }
        state.toolsUsed = [];
        if (event.reason === 'error' && event.error && chatId !== undefined) {
          void sendMessage(chatId, `❌ Error: ${event.error}`);
        }
        break;
      }
    }
  };

  // ── Long-poll loop (runs concurrently with interactiveSession) ──────
  // Captured from getMe so the group @mention gate knows the bot's handle/id.
  let botUsername: string | undefined;
  let botId: number | undefined;

  const pollLoop = async (): Promise<void> => {
    try {
      const me = await api<{ id?: number; username?: string }>('getMe', {});
      botUsername = me.username;
      botId = me.id;
      log(
        `[telegram] connected as @${me.username ?? '(unknown)'} — owner=${opts.ownerId}` +
          (opts.allowedUsers && opts.allowedUsers.size
            ? ` + ${opts.allowedUsers.size} allowed user(s)`
            : ''),
      );
    } catch (err) {
      state.stoppedBy = err as Error;
      state.running = false;
      const waiters = state.inputWaiters.splice(0);
      for (const w of waiters) w(null);
      return;
    }

    while (state.running) {
      let updates: TgUpdate[] = [];
      try {
        updates = await api<TgUpdate[]>('getUpdates', {
          offset: state.offset,
          timeout: POLL_TIMEOUT_SECONDS,
        });
      } catch (err) {
        log(`[telegram] getUpdates error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      for (const u of updates) {
        state.offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text || !msg.from) continue;

        // In groups, only act when the bot is addressed: @mentioned (incl. the
        // `/cmd@bot` form) or replied to. Everything else — plain chatter AND
        // bare slash commands — is ignored SILENTLY. Private chats need no mention.
        const isGroup = !!msg.chat.type && msg.chat.type !== 'private';
        let text = msg.text;
        if (isGroup) {
          const tag = botUsername ? `@${botUsername}` : '';
          const mentioned = !!tag && text.toLowerCase().includes(tag.toLowerCase());
          const repliedToBot = !!botId && msg.reply_to_message?.from?.id === botId;
          if (!mentioned && !repliedToBot) continue;
          // Strip the @mention so the agent gets a clean prompt.
          if (mentioned && tag) {
            text = text.replace(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim();
          }
        }
        if (!text) continue; // mention with no actual content

        const isAuthorized =
          msg.from.id === opts.ownerId || !!opts.allowedUsers?.has(msg.from.id);
        if (!isAuthorized) {
          void sendMessage(msg.chat.id, 'Not authorized.');
          log(
            `[telegram] rejected unauthorized sender id=${msg.from.id} ` +
              `username=@${msg.from.username ?? 'n/a'}`,
          );
          continue;
        }
        log(`[telegram] ← ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);

        // Intercept bot slash commands before handing off to the agent.
        if (text.trim().startsWith('/')) {
          state.currentChatId = msg.chat.id;
          const handled = await handleSlashCommand(msg.chat.id, text);
          if (handled) continue;
          // Unknown slash command: fall through to agent (which has its own
          // slash handling for /retry, /model, /cost, …).
        }

        enqueueInput(msg.chat.id, text);
      }
    }
  };

  const pollPromise = pollLoop();

  // Shared LLM client used for post-session extraction. Built once so we
  // don't re-create a wallet client for every /new cycle.
  const extractor = new ModelClient({
    apiUrl: agentConfig.apiUrl,
    chain: agentConfig.chain,
  });

  const harvestSession = async (history: Dialogue[]): Promise<void> => {
    // Match the startCommand gate — very short sessions rarely carry useful
    // entities and the LLM call isn't free. 15s hard cap so extraction can't
    // hang the bot between sessions.
    if (history.length < 4) return;
    const sid = `telegram-${new Date().toISOString()}`;
    try {
      await Promise.race([
        Promise.all([
          extractLearnings(history, sid, extractor),
          extractBrainEntities(history, sid, extractor),
        ]),
        new Promise((r) => setTimeout(r, 15_000)),
      ]);
    } catch (err) {
      log(`[telegram] post-session extraction failed: ${(err as Error).message}`);
    }
  };

  try {
    // Outer session loop: `/new` makes interactiveSession return (waiters
    // drained to null), then we spin up a fresh session so the bot stays
    // live without needing a process restart. After each session ends we
    // run learnings + brain extraction so recall has something to recall.
    //
    // Resume semantics: the FIRST session honors agentConfig.resumeSessionId
    // (set by the CLI command to pick up a prior cross-process session).
    // After `/new` we clear it so the next session is genuinely fresh —
    // otherwise every /new would re-hydrate the same history and defeat
    // the point of the command.
    let firstSession = true;
    while (state.running) {
      state.restartRequested = false;
      if (!firstSession) agentConfig.resumeSessionId = undefined;
      firstSession = false;
      const history = await interactiveSession(agentConfig, waitNextInput, handleEvent);
      // Best-effort harvest — never block the next session on extraction.
      void harvestSession(history);
      if (!state.restartRequested) break;
      log('[telegram] session reset by /new');
    }
  } finally {
    state.running = false;
    const waiters = state.inputWaiters.splice(0);
    for (const w of waiters) w(null);
    await pollPromise;
  }

  if (state.stoppedBy) throw state.stoppedBy;
}
