/**
 * Grounding evaluator — a cheap second-pass check that every factual claim
 * in Franklin's answer traces back to a tool-call result, not model memory.
 *
 * Why this exists (2026-04 retrospective): the CRCL incident — user asked
 * about a stock Franklin had tools to query, Franklin answered from 2022
 * training data instead. Root cause wasn't a prompt defect; it was an
 * absent evaluator. The existing `verification.ts` only fires when the
 * agent writes code (Edit / Write / Bash threshold), so read-heavy hero
 * use cases (trading, research, analysis) never triggered any quality gate.
 *
 * This module is the complement: fires on *answers with factual content*,
 * regardless of tool type. Anthropic's harness-design article calls out
 * "self-evaluation on complex tasks" as anti-pattern #14 — models skew
 * positive when grading themselves. So the check runs as a separate agent
 * (different system prompt, explicitly adversarial) with its own model.
 *
 * v1 scope: check only, never re-prompt. Emit a follow-up ⚠️ event when
 * claims look ungrounded, let the user decide whether to re-ask. The
 * re-prompt loop (generator iterates against evaluator findings until
 * PASS) is a v2 concern once we know v1 catches real cases without
 * false-positive noise.
 */

import type { CapabilityHandler, Dialogue } from './types.js';
import { ModelClient } from './llm.js';

// ─── Evaluator system prompt ─────────────────────────────────────────────
//
// Principle-based, not example-enumerating. Specific tickers or phrasings
// hard-coded here would rot the moment the market changes. The rule is
// general: claim → tool result or explicit uncertainty.

const EVALUATOR_PROMPT = `You are a GROUNDING CHECK agent. Your job is to verify that an AI assistant's answer is grounded in tool-call evidence, not model memory — and that it didn't REFUSE to use tools when tools were the right answer.

## What you receive
- The user's question
- A list of tool calls made this turn (tool name, input summary, whether it succeeded)
- The assistant's final text answer

## Two failure modes to catch

### A. Ungrounded claims
Every **factual claim** in the answer must trace to ONE of:
  (a) A tool call result from this turn (model-initiated OR listed under "Pre-fetched by Franklin harness"), OR
  (b) Explicit acknowledgment of uncertainty ("I'm not sure", "based on older data")

**Harness-prefetched data is evidence.** When the turn includes a "Pre-fetched by Franklin harness" section, the data listed there was fetched live from tools on the assistant's behalf (TradingMarket, ExaAnswer, etc). Treat it identically to a model-initiated tool call — claims that reference prefetched prices, numbers, or news snippets are GROUNDED.

Flag as ungrounded:
- Specific current-world facts stated with confidence but not backed by any tool call this turn (including prefetch)
- Recommendations or conclusions that depend on unstated data (e.g. "you should sell" without a price lookup)
- Invented specifics — names, numbers, dates the model produced without a tool call supporting them

### B. Tool-use refusal (NEW)
If the user clearly asked for live-world data — a current price, today's news, the latest state of X — and the assistant's answer contains a refusal or deflection (e.g. "I can't provide real-time prices", "我无法提供实时数据", "check Yahoo Finance yourself", "as an AI I don't have access to live data"), that is also UNGROUNDED. Franklin HAS tools for this (TradingMarket for prices, ExaAnswer for current events, WebSearch for general web, etc.). Refusing to reach for them is the failure this check was built for.

Flag as tool-use refusal:
- "I can't check real-time prices"
- "I don't have access to current market data"
- "You should check [some external site] for the latest"
- Any variation in any language that shrugs off a live-data question when tools exist

## What's OK
- Anything directly derived from a tool result shown in the turn
- General knowledge / definitions / reasoning that doesn't depend on current-world specifics
- Claims explicitly hedged as uncertain for reasons unrelated to tool availability

## Output — exact format

VERDICT: GROUNDED | PARTIAL | UNGROUNDED

If not GROUNDED, list each issue on its own line starting with "- " and the tool that should have been called, like:
- Claim: "<the ungrounded part, quoted briefly>" → missing tool: <TradingMarket | ExaAnswer | ExaSearch | WebSearch | ...>
- Refusal: "<the refusal phrase, quoted briefly>" → should have called: <tool name>

Empty line between verdict and list. No other text. No preamble. No apology. Be terse.`;

// ─── Result type ─────────────────────────────────────────────────────────

export type GroundingVerdict = 'GROUNDED' | 'PARTIAL' | 'UNGROUNDED' | 'SKIPPED';

export interface GroundingResult {
  verdict: GroundingVerdict;
  issues: string[];
  raw: string;
}

// ─── Trigger policy ──────────────────────────────────────────────────────

const MIN_USER_CHARS = 3;     // "hi"/"ok"/"no" skip; "BTC"/"21044" do not
const MIN_ANSWER_CHARS = 50;  // Short answers are acks, not factual claims

// Factual-content patterns: digits paired with units, currency, dates, or
// percent/temperature/time signs. If the assistant emitted any of these in
// a >= MIN_ANSWER_CHARS reply, we check grounding regardless of how short
// the user's input was — a 5-char ZIP code "21044" can elicit a fabricated
// weather paragraph, and the original user-length gate let that through.
const FACTUAL_PATTERN = /(\$\s*\d|\d[\d,]*\s*(?:°[CF]?|%|km|mi|miles?|mph|kph|kg|lbs?|ft|in|cm|hours?|hrs?|minutes?|mins?|seconds?|secs?|GB|MB|KB|TB|USD|EUR|CNY|JPY|BTC|ETH|SOL)|\b(?:19|20)\d{2}-\d{1,2}-\d{1,2}\b|\b\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b)/;

/**
 * Decide whether this turn warrants a grounding check. Principles:
 * - Non-trivial user input (not a greeting, not a slash command), OR
 *   the assistant answer contains specific factual claims (numbers + units,
 *   currency, dates, times) regardless of input length
 * - Non-trivial assistant text output (not just a tool-result echo)
 *
 * Intentionally NOT gating on tool-type (read vs write) — the whole point
 * of this module is to cover read-heavy turns the code verifier misses.
 */
export function shouldCheckGrounding(
  userInput: string,
  assistantText: string,
): boolean {
  if (process.env.FRANKLIN_NO_EVAL === '1') return false;
  const ui = userInput.trim();
  if (ui.startsWith('/')) return false;
  const at = assistantText.trim();
  if (at.length < MIN_ANSWER_CHARS) return false;
  // If the answer looks factual (numbers + units, dates, prices), check
  // even when the user's prompt was a single token. The 21044 zip-code
  // case lived here.
  if (FACTUAL_PATTERN.test(at)) return true;
  if (ui.length < MIN_USER_CHARS) return false;
  return true;
}

// ─── Turn summary extraction ─────────────────────────────────────────────

/**
 * Summarize the current turn for the evaluator: user question + tool calls
 * + tool result snippets + assistant's final answer. Bounded to keep the
 * evaluator call cheap; it doesn't need every byte of every tool output.
 */
function summarizeTurn(userInput: string, history: Dialogue[], assistantText: string): string {
  const lines: string[] = [];
  lines.push(`## User question`);
  lines.push(userInput.trim().slice(0, 800));
  lines.push('');

  // ── Harness prefetch (treated as synthetic tool calls) ──
  // When intent-prefetch fires, it prepends a [FRANKLIN HARNESS PREFETCH]
  // block to the user message. The LLM answers based on that data, but
  // the evaluator previously only looked for tool_use/tool_result pairs
  // and missed the injection — flagging answers that were actually
  // grounded in live data as UNGROUNDED. Surface the block explicitly so
  // the evaluator counts it as evidence.
  const prefetchBlock = extractPrefetchBlock(history);
  if (prefetchBlock) {
    lines.push(`## Pre-fetched by Franklin harness (counts as tool evidence)`);
    lines.push(prefetchBlock.slice(0, 1200));
    lines.push('');
  }

  lines.push(`## Tool calls this turn (model-initiated)`);

  // Walk from the end of history back to (but not including) the user message.
  // Each assistant tool_use and each user tool_result get condensed to one line.
  let found = 0;
  const toolLines: string[] = [];
  for (let i = history.length - 1; i >= 0 && found < 40; i--) {
    const msg = history[i];
    if (msg.role === 'user' && typeof msg.content === 'string') break;
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part.type === 'tool_use') {
          const inputStr = JSON.stringify(part.input).slice(0, 160);
          toolLines.unshift(`  - ${part.name}(${inputStr})`);
          found++;
        }
      }
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part.type === 'tool_result') {
          const output = typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? (part.content as Array<{ text?: string }>).map(c => c.text || '').join('\n')
              : '';
          const snippet = output.slice(0, 240).replace(/\s+/g, ' ');
          toolLines.unshift(`    → ${snippet}`);
          found++;
        }
      }
    }
  }
  if (toolLines.length === 0) {
    lines.push(prefetchBlock ? '  (none — but harness pre-fetched data above)' : '  (none)');
  } else {
    lines.push(...toolLines);
  }
  lines.push('');
  lines.push(`## Assistant's answer`);
  lines.push(assistantText.trim().slice(0, 2400));
  return lines.join('\n');
}

/**
 * Find the `[FRANKLIN HARNESS PREFETCH]` block in the most recent user
 * message (that's where intent-prefetch injects it). Returns the inner
 * payload or null if no prefetch happened this turn.
 */
export function extractPrefetchBlock(history: Dialogue[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : null;
    if (!content) continue;
    const startIdx = content.indexOf('[FRANKLIN HARNESS PREFETCH]');
    if (startIdx < 0) return null; // Most recent user message has no prefetch — we're done
    // Capture from the marker up to (but not including) the "Original user message:" divider
    const endMarker = '\nOriginal user message:';
    const endIdx = content.indexOf(endMarker, startIdx);
    if (endIdx < 0) return content.slice(startIdx).trim();
    return content.slice(startIdx, endIdx).trim();
  }
  return null;
}

// ─── Verdict parser ──────────────────────────────────────────────────────

export function parseGroundingResponse(raw: string): GroundingResult {
  const text = raw.trim();
  const m = text.match(/VERDICT:\s*(GROUNDED|PARTIAL|UNGROUNDED)/i);
  const verdict: GroundingVerdict = m
    ? (m[1].toUpperCase() as 'GROUNDED' | 'PARTIAL' | 'UNGROUNDED')
    : 'PARTIAL'; // If the evaluator couldn't produce a clean verdict, err on the side of "flag for the user".

  const issues: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('- ') && l.length > 3) {
      issues.push(l.slice(2).trim());
    }
  }
  return { verdict, issues, raw: text };
}

// ─── Default evaluator model ─────────────────────────────────────────────

/** Cheap model for grading. Default matches existing verification.ts
 *  choice so both quality gates have the same cost profile. Override via
 *  `FRANKLIN_EVALUATOR_MODEL` to experiment with accuracy/cost trade-offs. */
export function evaluatorModel(): string {
  return process.env.FRANKLIN_EVALUATOR_MODEL || 'nvidia/llama-4-maverick';
}

// ─── Run grounding check ─────────────────────────────────────────────────

const MAX_EVAL_TOKENS = 512;
const EVAL_TIMEOUT_MS = 15_000;

export async function checkGrounding(
  userInput: string,
  history: Dialogue[],
  assistantText: string,
  client: ModelClient,
  opts: {
    abortSignal?: AbortSignal;
    model?: string;
  } = {},
): Promise<GroundingResult> {
  const model = opts.model || evaluatorModel();
  const summary = summarizeTurn(userInput, history, assistantText);

  // Run independently of the main agent — the evaluator gets NO tools
  // (it just reads and grades). Limit tokens so a chatty evaluator can't
  // balloon the cost of a cheap check.
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), EVAL_TIMEOUT_MS);
  const signal = opts.abortSignal
    ? anySignal([opts.abortSignal, timeoutCtrl.signal])
    : timeoutCtrl.signal;

  try {
    const response = await client.complete(
      {
        model,
        system: EVALUATOR_PROMPT,
        messages: [{ role: 'user', content: summary }],
        tools: [],
        max_tokens: MAX_EVAL_TOKENS,
      },
      signal,
    );

    let raw = '';
    for (const part of response.content) {
      if (typeof part === 'object' && part.type === 'text' && part.text) {
        raw += part.text;
      }
    }
    if (!raw.trim()) {
      return { verdict: 'SKIPPED', issues: [], raw: '(empty response)' };
    }
    return parseGroundingResponse(raw);
  } catch (err) {
    return {
      verdict: 'SKIPPED',
      issues: [],
      raw: `(evaluator error: ${(err as Error).message})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Compose multiple AbortSignals into one — aborts when any source aborts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

// ─── Render result for the UI ────────────────────────────────────────────

/**
 * Convert a grounding result into a user-facing follow-up message. Returns
 * empty string when verdict is GROUNDED / SKIPPED — no reason to spam the
 * user when the check agreed the answer was sound.
 */
export function renderGroundingFollowup(result: GroundingResult): string {
  if (result.verdict === 'GROUNDED' || result.verdict === 'SKIPPED') return '';

  const header = result.verdict === 'UNGROUNDED'
    ? '⚠️ **Grounding check failed** — the previous answer relied on memory where a tool call was available:'
    : '⚠️ **Grounding check flagged some claims** — re-run with the suggested tools for a verified answer:';

  const body = result.issues.length > 0
    ? result.issues.map(i => `- ${i}`).join('\n')
    : '(evaluator returned no specific items — check the transcript manually)';

  return `\n\n${header}\n${body}\n\n_Ask again with an explicit instruction to call the tools, or disable these checks with \`FRANKLIN_NO_EVAL=1\`._`;
}

/**
 * Build a synthetic user message that instructs the agent to retry with the
 * missing tools. Returned message goes into history so the model's next
 * generation sees it as the most recent instruction. This is the GAN-like
 * feedback loop pattern from Anthropic's harness-design writeup —
 * evaluator findings feed back into the generator until PASS (or retry cap).
 *
 * Intentionally terse: the agent already has the original question in
 * history; we only need to name the gap + the tools to use.
 */
export function buildGroundingRetryInstruction(
  result: GroundingResult,
  originalUserQuestion: string,
): string {
  // Pull the named missing tools out of the evaluator's issue list so we
  // can name them in the imperative. The evaluator outputs lines like
  //   Claim: "..." → missing tool: WebSearch
  // grab the bit after "missing tool:" / "should have called:".
  const namedTools = new Set<string>();
  for (const issue of result.issues) {
    const m = issue.match(/(?:missing tool|should have called):\s*([A-Za-z][\w| ,/-]*)/i);
    if (m) {
      for (const tok of m[1].split(/[|,/]/)) {
        const t = tok.trim().split(/\s+/)[0];
        if (t && t !== '...' && t !== '(or') namedTools.add(t);
      }
    }
  }
  const toolList = namedTools.size > 0
    ? Array.from(namedTools).join(', ')
    : '(see the missing-tool fields in the issues above)';

  const lines: string[] = [
    '[GROUNDING CHECK FAILED — RETRY ROUND]',
    'Your previous answer stated facts without calling tools. Specifically:',
  ];
  for (const issue of result.issues) {
    lines.push(`- ${issue}`);
  }
  lines.push('');
  lines.push('## What you must do this round');
  lines.push(`1. **Call these tools first**, before any prose: ${toolList}.`);
  lines.push('2. **Do not write a single factual sentence until the tool results return.** No restatement of the prior answer, no hedging, no "based on general knowledge".');
  lines.push('3. **Do NOT invent source names** (no fake URLs, no fabricated citation domains, no "per Trippy" / "per drivvin.com" — if you cite a source, it must come from a tool result you just ran).');
  lines.push('4. After tools return, write a concise answer that ONLY restates what the tool outputs say. If a result is partial or a tool failed, say so explicitly — do not paper over with memory.');
  lines.push('');
  lines.push(`Original user question: ${originalUserQuestion.trim().slice(0, 500)}`);
  return lines.join('\n');
}

// ─── Unused-import shim (keeps CapabilityHandler exportable for tests) ──
// Type re-export so tests can reference the shape without importing types.js.
export type { CapabilityHandler };
