import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityInvocation, CapabilityResult, ExecutionScope } from './types.js';
import { checkTradePlanGate, recordTradeExecution, releaseTradeReservation } from '../trading/trade-plan.js';
import { appendApprovalRecord } from '../audit/approvals.js';
import { getAddress } from '../wallet/manager.js';
import { activeSolanaAddress } from '../wallet/solana-migration.js';
import {
  ambiguousOutcomeReason,
  analyzeBash,
  attemptsOverlap,
  commandPreview,
  describeAttempt,
  extractRecipients,
  extractTxHashes,
  isPaymentSend,
  isReconciliation,
  loadPaymentAttempts,
  savePaymentAttempts,
  codeRecordsNegativeOutcome,
  recordsNegativeOutcome,
  unknownOutcomeNotice,
  type PaymentAttempt,
} from './payment-hold.js';

const MAX_WEBSEARCHES_PER_TURN = 8;
const MAX_SIMILAR_SEARCHES_PER_TURN = 4;
const MAX_NO_SIGNAL_SEARCHES_PER_FAMILY = 2;
const SEARCH_FAMILY_SIMILARITY = 0.58;
const DUPLICATE_READ_TURN_WINDOW = 1;
const DUPLICATE_FETCH_TURN_WINDOW = 1;
const MAX_PREVIEW_CHARS = 320;

// Commands that mutate state or have side effects — never dedup these.
// Covers: filesystem writes, network downloads, package managers, container/orchestration,
// git mutations, privileged escalation, archive ops, and output redirection.
// Hoisted to module scope so beforeBash/afterBash don't recompile on every call.
// Normalize a filesystem path for cache-key use: collapse whitespace and strip
// a single trailing slash (so `/foo` and `/foo/` share a cache entry).
function normalizePath(p: string): string {
  const trimmed = p.trim().replace(/\s+/g, ' ');
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1);
  return trimmed;
}

// Build a stable Grep cache key — or return '' if the call isn't dedupable.
// Pattern is case-sensitive by design (grep semantics), but path/glob/type
// are normalized so cosmetic variation doesn't bypass dedup.
function grepKey(invocation: CapabilityInvocation): string {
  const pattern = String(invocation.input.pattern ?? '').trim();
  if (!pattern) return '';
  const path = normalizePath(String(invocation.input.path ?? ''));
  const glob = String(invocation.input.glob ?? '').trim().replace(/\s+/g, ' ');
  const type = String(invocation.input.type ?? '').trim();
  return `${pattern}::${path}::${glob}::${type}`;
}

function globKey(invocation: CapabilityInvocation): string {
  const pattern = String(invocation.input.pattern ?? '').trim().replace(/\s+/g, ' ');
  if (!pattern) return '';
  const path = normalizePath(String(invocation.input.path ?? ''));
  return `${pattern}::${path}`;
}

// Detect a blocking poll-loop in a foreground bash command:
// any `for|while|until` loop containing a `sleep` of ≥1 second. This is
// the canonical antipattern that makes the agent feel frozen — see
// beforeBash() for the full rationale and the recommended alternatives.
// Use [\s\S] for cross-line match so we catch multi-line scripts; require
// `sleep [1-9]` so trivial `sleep 0` / `sleep 0.1` micro-pauses don't trip.
export const BLOCKING_POLL_LOOP_RE: RegExp =
  /\b(?:for|while|until)\b[\s\S]*?\bsleep\s+[1-9]/;

const WRITE_KEYWORDS: RegExp = (() => {
  const words = [
    'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln',
    'write', 'install', 'uninstall', 'build', 'publish',
    'push', 'pull', 'fetch', 'clone',
    'curl', 'wget', 'scp', 'rsync',
    'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pipx', 'poetry', 'cargo', 'gem',
    'apt', 'apt-get', 'brew', 'port', 'dnf', 'yum', 'pacman',
    'make', 'cmake', 'gradle', 'mvn',
    'go\\s+(?:build|run|test|install|mod)',
    'git\\s+(?:push|pull|commit|merge|rebase|reset|clean|stash|checkout|add|rm|mv|fetch|clone|revert|cherry-pick)',
    'docker', 'podman', 'kubectl', 'helm',
    'tar', 'zip', 'unzip', 'gzip', 'bzip2',
    'tee', 'sudo', 'doas',
  ];
  // Redirect operators are not word chars — match separately, not under \b.
  return new RegExp(`(?:\\b(?:${words.join('|')})\\b|>>?\\s)`);
})();

const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'april', 'at', 'builder', 'builders', 'com', 'developer',
  'developers', 'for', 'from', 'in', 'latest', 'live', 'may', 'of', 'on', 'or',
  'post', 'posts', 'recent', 'reply', 'replies', 'site', 'status', 'the', 'to',
  'tweet', 'tweets', 'via', 'x',
]);

interface SearchFamily {
  exemplarQuery: string;
  tokens: Set<string>;
  totalSearches: number;
  turnSearches: number;
  noSignalSearches: number;
}

interface SearchRecord {
  query: string;
  preview: string;
  noSignal: boolean;
}

interface PendingSearch {
  normalized: string;
  family: SearchFamily;
}

interface FileSnapshot {
  key: string;
  resolved: string;
  offset: number;
  limit: number;
  turn: number;
  mtimeMs: number;
  size: number;
}

interface FetchSnapshot {
  key: string;
  url: string;
  maxLength: number;
  turn: number;
}

function stemToken(token: string): string {
  let result = token.toLowerCase();
  if (/^\d{4}$/.test(result)) return '';
  if (result.endsWith('ing') && result.length > 6) result = result.slice(0, -3);
  else if (result.endsWith('ers') && result.length > 5) result = result.slice(0, -3);
  else if (result.endsWith('er') && result.length > 4) result = result.slice(0, -2);
  else if (result.endsWith('ed') && result.length > 4) result = result.slice(0, -2);
  else if (result.endsWith('es') && result.length > 4) result = result.slice(0, -2);
  else if (result.endsWith('s') && result.length > 4) result = result.slice(0, -1);
  return result;
}

export function normalizeSearchQuery(query: string): { normalized: string; tokens: string[] } {
  const tokens = query
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token));

  const normalized = [...new Set(tokens)].sort().join(' ');
  return { normalized, tokens: [...new Set(tokens)] };
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function summarizeOutput(output: string): string {
  const compact = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
  return compact.length > MAX_PREVIEW_CHARS
    ? compact.slice(0, MAX_PREVIEW_CHARS - 3) + '...'
    : compact;
}

function isNoSignalSearchResult(output: string, isError?: boolean): boolean {
  const lower = output.toLowerCase();
  return Boolean(
    isError ||
    lower.startsWith('no results found for:') ||
    lower.startsWith('no candidate posts found') ||
    lower.startsWith('search timed out') ||
    lower.startsWith('search error:') ||
    lower.startsWith('searchx error:')
  );
}

function readKey(resolved: string, offset?: number, limit?: number): string {
  return `${resolved}::${offset ?? 1}::${limit ?? 2000}`;
}

function fetchKey(url: string, maxLength?: number): string {
  return `${url}::${maxLength ?? 12288}`;
}

// Circuit-breaker classifier for the per-tool kill switch.
//
// `isError: true` covers everything from "tool itself broke" (network, parse,
// timeout) to "agent fed me a bad input" (404 on a guessed URL, malformed URL).
// Only the first category should count toward disabling the tool — otherwise
// three hallucinated URLs in one prompt permanently kill WebFetch for the
// session, even though the tool worked correctly each time.
export function isToolClassFailure(name: string, result: CapabilityResult): boolean {
  if (!result.isError) return false;
  const out = String(result.output ?? '');

  if (name === 'WebFetch') {
    // HTTP 4xx/5xx — the URL was real-but-wrong or the upstream had issues.
    // Either way, the tool worked; the agent should pick a different URL.
    if (/^HTTP \d{3}\b/.test(out)) return false;
    // Bad URL syntax / unsupported protocol / missing arg — agent input error.
    if (out.startsWith('Error: invalid URL')) return false;
    if (out.startsWith('Error: only http')) return false;
    if (out.startsWith('Error: url is required')) return false;
    // User interrupt — not a tool failure.
    if (out.startsWith('Error: request aborted')) return false;
  }

  return true;
}

// Tools whose input can never record a payment outcome — reads, searches,
// and questions to the user (asking is exactly what an unknown outcome needs).
const OUTCOME_NEUTRAL_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'SearchX', 'WebFetch', 'AskUser', 'ActivateTool',
]);

/**
 * Every string in a tool input, checked raw as well as serialized: JSON
 * escaping turns `{"status":"failed"}` inside a Write's content into
 * `{\"status\":\"failed\"}`, which a pattern on the serialized form misses.
 */
function inputRecordsNegativeOutcome(name: string, input: Record<string, unknown>): boolean {
  // Editing tools: only the text they introduce is a record. Removing an
  // "unpaid" (Edit's old_string) is a correction, not a claim.
  if (name === 'Edit') return recordsNegativeOutcome(String(input.new_string ?? ''));
  if (name === 'Write') return recordsNegativeOutcome(String(input.content ?? ''));
  const strings: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach(x => walk(x, depth + 1));
  };
  walk(input, 0);
  return recordsNegativeOutcome(JSON.stringify(input ?? {})) || strings.some(recordsNegativeOutcome);
}

/**
 * Whether a read-only lookup is about this attempt: it names one of the
 * attempt's tx hashes, recipients or paying wallets (a sender nonce or
 * balance check). An attempt with none of those cannot be told apart from
 * any other, so any lookup counts for it.
 */
function lookupAddressesAttempt(lookup: string, attempt: PaymentAttempt): boolean {
  const keys = [...attempt.txHashes, ...attempt.recipients, ...attempt.senders].map(k => k.toLowerCase());
  if (keys.length === 0) return true;
  const text = lookup.toLowerCase();
  return keys.some(k => text.includes(k));
}

function negativeOutcomeBlock(unresolved: PaymentAttempt[]): CapabilityResult {
  const pending = unresolved.filter(a => !a.reconciled);
  return {
    output:
      'Blocked by Franklin\'s payment guard: this call records a payment as failed/unpaid, but the outcome of ' +
      `${pending.length === 1 ? 'this attempt is' : 'these attempts are'} UNKNOWN and nothing has been checked yet:\n` +
      pending.map(a => `- ${describeAttempt(a)}`).join('\n') +
      '\n\nA timeout or 5xx after a send is not a failure — the payment may have settled. Either run a READ-ONLY ' +
      'reconciliation first (receipt for the tx hash, the sender\'s nonce, sender/recipient balances, or the ' +
      'venue\'s status endpoint), or record the outcome as UNKNOWN and tell the user exactly what is unknown.',
    isError: true,
  };
}

function ownWalletAddresses(): string[] {
  const out: string[] = [];
  try { out.push(getAddress()); } catch { /* no EVM wallet */ }
  try {
    const sol = activeSolanaAddress();
    if (sol) out.push(sol);
  } catch { /* no Solana wallet */ }
  return out;
}

function paymentHoldResult(blocking: PaymentAttempt[]): CapabilityResult {
  return {
    output:
      'Payment held by Franklin\'s payment guard — NOT sent. An earlier payment attempt to the same recipient ' +
      'has an UNKNOWN outcome and may already have settled:\n' +
      blocking.map(a => `- ${describeAttempt(a)}`).join('\n') +
      '\n\nSending again — with a rewritten script, a new nonce or a new signature — could pay the same obligation ' +
      'twice, so the user did not approve this send (or no one was available to approve it). Do not try another ' +
      'way to send it. Reconcile with READ-ONLY checks (receipt for the tx hash, sender nonce, sender/recipient ' +
      'balances, or the venue\'s status endpoint), then report every attempt to the user and say exactly what ' +
      'is still unknown. Record the outcome as UNKNOWN unless a check established it.',
    isError: true,
  };
}

export class SessionToolGuard {
  /**
   * Session identity for the trade-plan gate. Explicit (not module-global)
   * so multiple concurrent sessions in one process (AgentHost) can never
   * check trades against another session's approved plan.
   */
  private sessionId?: string;
  private turn = 0;
  private webSearchesThisTurn = 0;
  private searchFamilies: SearchFamily[] = [];
  private searchCache = new Map<string, SearchRecord>();
  private pendingSearches = new Map<string, PendingSearch>();
  private recentReads = new Map<string, FileSnapshot>();
  private pendingReads = new Map<string, FileSnapshot>();
  private recentFetches = new Map<string, FetchSnapshot>();
  private pendingFetches = new Map<string, FetchSnapshot>();
  private toolErrorCounts = new Map<string, number>();
  // Session-level dedup for code-search tools — agents love grep'ing the same pattern
  // five times in a row when they're confused. Tell them once that it already failed.
  private recentGreps = new Map<string, { preview: string; turn: number }>();
  private recentGlobs = new Map<string, { preview: string; turn: number }>();
  private recentBash = new Map<string, { preview: string; turn: number; isError: boolean }>();
  // Payment hold (see payment-hold.ts): sends whose outcome is unknown, the
  // sends and reconciliation lookups currently executing, and sends the user
  // explicitly allowed past a hold (those skip the exact-command dedup too).
  private paymentAttempts: PaymentAttempt[] = [];
  private nextPaymentAttemptId = 1;
  private pendingPaymentSends = new Map<string, { command: string; recipients: string[]; senders: string[]; background: boolean }>();
  // Read-only lookups in flight: the code they run, so only the attempts it
  // names (tx hash or recipient) count as checked.
  private pendingReconciles = new Map<string, string>();
  private userAllowedPaymentSends = new Set<string>();

  constructor(sessionId?: string) {
    this.sessionId = sessionId;
    if (sessionId) {
      // A resumed session keeps its unknown payment outcomes and their holds.
      this.paymentAttempts = loadPaymentAttempts(sessionId);
      this.nextPaymentAttemptId = this.paymentAttempts.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    }
  }

  private persistPaymentAttempts(): void {
    if (this.sessionId) savePaymentAttempts(this.sessionId, this.paymentAttempts);
  }

  startTurn(): void {
    this.turn++;
    this.webSearchesThisTurn = 0;
    // The per-tool circuit breaker exists to stop a model from burning a
    // whole turn re-attacking a wall. It must NOT outlive the user turn that
    // earned the failures — a fresh prompt is a fresh intent. Without this
    // reset, three failed Bash calls (e.g. `franklin social login x` on a
    // host without the right env) permanently disable Bash for the rest of
    // the session, even on completely unrelated follow-ups.
    this.toolErrorCounts.clear();
    for (const family of this.searchFamilies) {
      family.turnSearches = 0;
    }
  }

  async beforeExecute(
    invocation: CapabilityInvocation,
    scope: ExecutionScope
  ): Promise<CapabilityResult | null> {
    // Hard-block tools that have failed too many times this session.
    // Modal lifecycle tools are exempt: orphan sandboxes keep billing
    // GPU time, and ModalTerminate is the only way to recover from
    // agent-side. Auto-disabling it after 3 transient errors would
    // strand a $0.40/hr H100 until the session ends. Same logic for
    // media-gen tools: failures are usually transient (gateway hiccup,
    // prompt rejection) and the user often wants to retry.
    const FAILURE_EXEMPT = new Set([
      'ImageGen',
      'VideoGen',
      'ModalCreate',
      'ModalExec',
      'ModalStatus',
      'ModalTerminate',
    ]);
    const errorCount = this.toolErrorCounts.get(invocation.name) ?? 0;
    if (errorCount >= 3 && !FAILURE_EXEMPT.has(invocation.name)) {
      return {
        output: `${invocation.name} has failed ${errorCount} times this session and is now disabled. ` +
          'Tell the user what went wrong and suggest alternatives.',
        isError: true,
      };
    }

    // Trade-plan gate: real-money trades require an approved plan with
    // remaining budget — in every permission mode, trust included.
    const tradeGate = checkTradePlanGate(invocation, this.sessionId);
    if (tradeGate) return tradeGate;

    // Payment hold: a send whose outcome is unknown blocks any new send that
    // could pay the same recipient, whatever the script text looks like.
    const paymentGate = await this.checkPaymentHold(invocation, scope);
    if (paymentGate) return paymentGate;

    switch (invocation.name) {
      case 'WebSearch':
      case 'SearchX':
        return this.beforeWebSearch(invocation);
      case 'Read':
        return this.beforeRead(invocation, scope);
      case 'WebFetch':
        return this.beforeWebFetch(invocation);
      case 'Grep':
        return this.beforeGrep(invocation);
      case 'Glob':
        return this.beforeGlob(invocation);
      case 'Bash':
        return this.beforeBash(invocation);
      default:
        return null;
    }
  }

  private beforeBash(invocation: CapabilityInvocation): CapabilityResult | null {
    const cmd = String(invocation.input.command ?? '').trim();
    if (!cmd) return null;

    // Reject interactive franklin subcommands that require the human at the
    // keyboard (they spawn a non-headless Chrome and wait for the user to
    // close it). If the agent runs them via Bash they block until timeout,
    // burn a tool-failure strike, and contribute nothing. Tell the agent to
    // ask the user to run them in a separate terminal instead.
    if (/^\s*franklin\s+social\s+(login|setup)\b/.test(cmd)) {
      return {
        output:
          'Blocked: `franklin social login` / `franklin social setup` are INTERACTIVE — ' +
          'they open a Chrome window the human must drive and close. They cannot run from ' +
          'an agent Bash call (they will hang then time out). ' +
          'Ask the user to run this in their own terminal, then continue once they say it is done.',
        isError: true,
      };
    }

    // `franklin social run` is a batch poster/replier that loops over the
    // user's configured search_queries — it is not the right tool for
    // "read this specific tweet" or "draft replies to one post". Steer the
    // agent to SearchX (now URL-aware) instead.
    if (/^\s*franklin\s+social\s+run\b/.test(cmd)) {
      return {
        output:
          'Blocked: `franklin social run` is a batch reply loop over the user\'s configured ' +
          'queries, not a single-tweet reader. Use the SearchX tool instead — pass a tweet URL ' +
          'as the query to read one post, or use mode="search"/"notifications" for discovery.',
        isError: true,
      };
    }

    // Reject blocking poll-loops in foreground bash. A single bash call with
    // `sleep N` inside a for/while/until loop blocks the agent for the full
    // duration — the UI repeats the same status line and the user almost
    // always cancels before it finishes. The right pattern is `Detach`
    // (persistent background task) or `run_in_background: true`.
    const runInBackground = Boolean(invocation.input.run_in_background);
    if (!runInBackground && BLOCKING_POLL_LOOP_RE.test(cmd)) {
      return {
        output:
          'Blocked: this Bash command runs `sleep` inside a for/while/until loop in the ' +
          'foreground. That blocks the agent for the full poll duration and looks frozen ' +
          'to the user — they almost always cancel before it finishes.\n\n' +
          'Use the `Detach` tool for polling-style work (waiting for an Apify run, video ' +
          'generation, deploy, build, or any external async job to complete). It returns ' +
          'a runId immediately and the polling continues persistently. Check status later ' +
          'with `franklin task wait <runId>` or `franklin task tail <runId>` via a ' +
          'separate Bash call.\n\n' +
          'If you need the result inline, break the loop into discrete single-poll Bash ' +
          'calls — poll once, reason about the status, then decide whether to poll again. ' +
          'Or, if the upstream API has a sync variant (e.g. Apify\'s ' +
          '`run-sync-get-dataset-items`), use that with a `timeout` of 300000–600000 ms ' +
          'instead of orchestrating async + poll yourself.',
        isError: true,
      };
    }

    // Only dedup deterministic read-only commands. Skip anything writing/network/long-running.
    if (WRITE_KEYWORDS.test(cmd)) return null;
    // The user explicitly allowed this send past a payment hold — honor that
    // even when it repeats a command that failed earlier.
    if (this.userAllowedPaymentSends.delete(invocation.id)) return null;
    // Normalize whitespace so "ls   -la" and "ls -la" share a cache entry.
    const key = cmd.replace(/\s+/g, ' ');
    const cached = this.recentBash.get(key);
    if (cached) {
      const lead = cached.isError
        ? 'That exact Bash command was already run this session and FAILED:'
        : 'That exact Bash command was already run this session and returned:';
      return {
        output:
          `${lead}\n${cached.preview}\n\n` +
          'Do not re-run the same command. If the output was insufficient, run a different command or use a dedicated tool (Read for files, Grep/Glob for searching).',
      };
    }
    return null;
  }

  private beforeGrep(invocation: CapabilityInvocation): CapabilityResult | null {
    const key = grepKey(invocation);
    if (!key) return null;
    const cached = this.recentGreps.get(key);
    if (cached) {
      return {
        output:
          `That exact Grep was already run this session and returned:\n${cached.preview}\n\n` +
          'Do not re-run the same pattern. If you need different information, change the pattern, path, or try a different tool (Glob to list files, Read to see full content).',
      };
    }
    return null;
  }

  private beforeGlob(invocation: CapabilityInvocation): CapabilityResult | null {
    const key = globKey(invocation);
    if (!key) return null;
    const cached = this.recentGlobs.get(key);
    if (cached) {
      return {
        output:
          `That exact Glob was already run this session and returned:\n${cached.preview}\n\n` +
          'Do not re-run the same pattern. Use Grep to search within those files, or Read them directly.',
      };
    }
    return null;
  }

  /**
   * Post-execution bookkeeping. Returns the result the model should see —
   * the same object unless a payment attempt ended ambiguously, in which case
   * an OUTCOME UNKNOWN notice is appended before the model decides anything.
   */
  afterExecute(invocation: CapabilityInvocation, result: CapabilityResult): CapabilityResult {
    // Draw down the approved trade plan's budget on successful executions
    // (no-op for non-trade tools).
    try {
      recordTradeExecution(invocation, result, this.sessionId);
    } catch { /* budget accounting must never break tool results */ }

    result = this.afterPayment(invocation, result);

    // Per-tool circuit breaker: count consecutive tool-class failures, reset on
    // any success. Agent-input errors (e.g. WebFetch 404 on a guessed URL) are
    // not tool failures and must not trip the breaker.
    if (isToolClassFailure(invocation.name, result)) {
      this.toolErrorCounts.set(
        invocation.name,
        (this.toolErrorCounts.get(invocation.name) ?? 0) + 1,
      );
    } else if (!result.isError) {
      this.toolErrorCounts.delete(invocation.name);
    }

    switch (invocation.name) {
      case 'WebSearch':
      case 'SearchX':
        this.afterWebSearch(invocation, result);
        break;
      case 'Read':
        this.afterRead(invocation, result);
        break;
      case 'WebFetch':
        this.afterWebFetch(invocation, result);
        break;
      case 'Grep':
        this.afterGrep(invocation, result);
        break;
      case 'Glob':
        this.afterGlob(invocation, result);
        break;
      case 'Bash':
        this.afterBash(invocation, result);
        break;
      default:
        break;
    }
    return result;
  }

  /** Payment attempts this session whose outcome is still unknown. */
  unresolvedPaymentAttempts(): PaymentAttempt[] {
    return this.paymentAttempts.filter(a => !a.overriddenByUser);
  }

  private async checkPaymentHold(
    invocation: CapabilityInvocation,
    scope: ExecutionScope,
  ): Promise<CapabilityResult | null> {
    const unresolved = this.unresolvedPaymentAttempts();

    if (invocation.name === 'Bash') {
      const cmd = String(invocation.input.command ?? '').trim();
      if (!cmd) return null;
      const { code, data, detached } = analyzeBash(cmd, scope.workingDir);
      const hasUncheckedAttempt = unresolved.some(a => !a.reconciled);

      // Recording failed/unpaid from the shell — checked before anything
      // else, so batching it with a send or a lookup changes nothing: text it
      // writes to a file or passes to a CLI (`echo '{"status":"unpaid"}' >
      // ledger.json`, `ledger add --status unpaid`), or code it runs that
      // persists a negative outcome (`node record.mjs`). A send's own code may
      // log "failed" for its own errors, so for sends only the shell-level
      // writes count. A lookup that merely PRINTS "unpaid" writes nothing.
      if (
        hasUncheckedAttempt &&
        (recordsNegativeOutcome(data) || (!isPaymentSend(code) && codeRecordsNegativeOutcome(code)))
      ) {
        return negativeOutcomeBlock(unresolved);
      }

      if (isPaymentSend(code)) {
        const own = ownWalletAddresses();
        const recipients = extractRecipients(code, own);
        // The wallet named in the script, or — when it loads its key some
        // other way — every wallet Franklin holds.
        const named = own.filter(a => code.toLowerCase().includes(a.toLowerCase()));
        const senders = (named.length ? named : own).map(a => a.toLowerCase());
        const blocking = unresolved.filter(a => attemptsOverlap(a.recipients, recipients));
        if (blocking.length > 0) {
          const allowed = await this.askToOverrideHold(blocking, cmd, scope);
          if (!allowed) return paymentHoldResult(blocking);
          for (const a of blocking) a.overriddenByUser = true;
          this.persistPaymentAttempts();
          this.userAllowedPaymentSends.add(invocation.id);
        }
        this.pendingPaymentSends.set(invocation.id, {
          command: commandPreview(cmd),
          recipients,
          senders,
          // `node pay.mjs &` or `nohup …` returns before the payment does,
          // exactly like the tool's own run_in_background.
          background: Boolean(invocation.input.run_in_background) || detached,
        });
        return null;
      }

      // Classified on executed code only: printing a lookup into a file is
      // not a lookup.
      if (isReconciliation(code)) {
        // A background lookup returns before it has looked anything up, so
        // it can never count as a check.
        if (unresolved.length > 0 && !invocation.input.run_in_background && !detached) {
          this.pendingReconciles.set(invocation.id, code);
        }
      }
      // Bash was judged above on what it writes and runs, not on its raw text.
      return null;
    }

    // Recording an unknown outcome as failed/unpaid before anything was
    // checked. Read-only tools and questions to the user are never outcome
    // records, so they pass.
    if (
      unresolved.some(a => !a.reconciled) &&
      !OUTCOME_NEUTRAL_TOOLS.has(invocation.name) &&
      inputRecordsNegativeOutcome(invocation.name, invocation.input)
    ) {
      return negativeOutcomeBlock(unresolved);
    }
    return null;
  }

  private async askToOverrideHold(
    blocking: PaymentAttempt[],
    command: string,
    scope: ExecutionScope,
  ): Promise<boolean> {
    const sessionId = scope.sessionId ?? this.sessionId ?? '';
    const subject = `payment attempt${blocking.length > 1 ? 's' : ''} ${blocking.map(a => `#${a.id}`).join(', ')}`;
    if (!scope.onApproval) {
      appendApprovalRecord({ ts: Date.now(), sessionId, kind: 'payment-hold', subject, decision: 'deny', by: 'policy', reason: 'no approval surface' });
      return false;
    }
    let choice = 'deny';
    let by = 'user';
    try {
      const decision = await scope.onApproval({
        sessionId,
        kind: 'payment-hold',
        title: 'New payment while an earlier one is unresolved',
        description:
          'An earlier payment attempt in this session ended without a clear result, so it may already have ' +
          'settled. Sending again could pay the same obligation twice.\n\n' +
          blocking.map(a => `Earlier: ${describeAttempt(a)}`).join('\n') +
          `\n\nNew send: ${commandPreview(command)}\n\n` +
          'Approve ONLY if you have confirmed the earlier attempt did not settle (e.g. a reverted receipt, or ' +
          'the recipient balance and sender nonce are unchanged). Deny keeps the hold.',
        options: ['approve', 'deny'],
        payload: { attempts: blocking, command },
      });
      choice = decision.choice.toLowerCase();
      if (decision.message === 'auto') by = 'flag';
    } catch {
      choice = 'deny';
      by = 'policy';
    }
    const approved = choice === 'approve';
    appendApprovalRecord({
      ts: Date.now(),
      sessionId,
      kind: 'payment-hold',
      subject,
      decision: approved ? 'approve' : 'deny',
      by,
    });
    return approved;
  }

  private afterPayment(
    invocation: CapabilityInvocation,
    result: CapabilityResult,
    forcedReason?: string,
  ): CapabilityResult {
    const output = String(result.output ?? '');

    const lookup = this.pendingReconciles.get(invocation.id);
    if (lookup !== undefined) {
      this.pendingReconciles.delete(invocation.id);
      // A lookup that itself failed or timed out established nothing.
      if (!result.isError && !ambiguousOutcomeReason(output, result.isError, false)) {
        for (const a of this.unresolvedPaymentAttempts()) {
          if (lookupAddressesAttempt(lookup, a)) a.reconciled = true;
        }
        this.persistPaymentAttempts();
      }
    }

    const pending = this.pendingPaymentSends.get(invocation.id);
    if (!pending) return result;
    this.pendingPaymentSends.delete(invocation.id);

    const reason = forcedReason ?? ambiguousOutcomeReason(output, result.isError, pending.background);
    if (!reason) return result;

    const attempt: PaymentAttempt = {
      id: this.nextPaymentAttemptId++,
      turn: this.turn,
      at: Date.now(),
      command: pending.command,
      recipients: pending.recipients,
      senders: pending.senders,
      reason,
      txHashes: extractTxHashes(output),
      reconciled: false,
      overriddenByUser: false,
    };
    this.paymentAttempts.push(attempt);
    this.persistPaymentAttempts();
    appendApprovalRecord({
      ts: attempt.at,
      sessionId: this.sessionId ?? '',
      kind: 'payment-hold',
      subject: `payment attempt #${attempt.id}`,
      decision: 'deny',
      by: 'policy',
      reason: `outcome unknown: ${reason}`,
    });
    return { ...result, output: output + unknownOutcomeNotice(attempt) };
  }

  private afterBash(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const cmd = String(invocation.input.command ?? '').trim();
    if (!cmd) return;
    if (WRITE_KEYWORDS.test(cmd)) return;
    const output = String(result.output ?? '');
    const preview = output.length > MAX_PREVIEW_CHARS
      ? output.slice(0, MAX_PREVIEW_CHARS) + '…'
      : output;
    // Match the normalization used in beforeBash so reads/writes share keys.
    const key = cmd.replace(/\s+/g, ' ');
    this.recentBash.set(key, { preview, turn: this.turn, isError: !!result.isError });
  }

  private afterGrep(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const key = grepKey(invocation);
    if (!key) return;
    const output = String(result.output ?? '');
    const preview = output.length > MAX_PREVIEW_CHARS
      ? output.slice(0, MAX_PREVIEW_CHARS) + '…'
      : output;
    this.recentGreps.set(key, { preview, turn: this.turn });
  }

  private afterGlob(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const key = globKey(invocation);
    if (!key) return;
    const output = String(result.output ?? '');
    const preview = output.length > MAX_PREVIEW_CHARS
      ? output.slice(0, MAX_PREVIEW_CHARS) + '…'
      : output;
    this.recentGlobs.set(key, { preview, turn: this.turn });
  }

  /**
   * The tool threw instead of returning. A payment send that was already
   * running may have broadcast before the throw, so it is recorded as an
   * unknown outcome rather than silently forgotten. Returns the error result
   * the model should see.
   */
  executionThrew(invocation: CapabilityInvocation, result: CapabilityResult): CapabilityResult {
    const pending = this.pendingPaymentSends.get(invocation.id);
    if (!pending) return result;
    // A thrown send never produced a conclusive answer.
    return this.afterPayment(invocation, result, 'the tool threw before it could report a result');
  }

  cancelInvocation(invocationId: string): void {
    // Denied before execution (permission refused, PreSpend veto): nothing
    // was submitted, so a trade-plan reservation made by the gate goes back.
    try {
      releaseTradeReservation(invocationId);
    } catch { /* budget accounting must never break tool flow */ }
    this.pendingSearches.delete(invocationId);
    this.pendingReads.delete(invocationId);
    this.pendingFetches.delete(invocationId);
    this.pendingPaymentSends.delete(invocationId);
    this.pendingReconciles.delete(invocationId);
    this.userAllowedPaymentSends.delete(invocationId);
  }

  private beforeWebSearch(invocation: CapabilityInvocation): CapabilityResult | null {
    const query = String(invocation.input.query ?? '').trim();
    const fingerprint = normalizeSearchQuery(query);
    const normalized = fingerprint.normalized || query.toLowerCase().trim();

    const cached = this.searchCache.get(normalized);
    if (cached) {
      const reason = cached.noSignal
        ? 'That same WebSearch already returned no useful signal earlier in this session.'
        : 'That same WebSearch already ran earlier in this session.';
      return {
        output:
          `${reason} Reuse the prior result already in context instead of searching again.\n\n` +
          `Previous search: ${cached.query}\n` +
          `Summary:\n${cached.preview}`,
      };
    }

    if (this.webSearchesThisTurn >= MAX_WEBSEARCHES_PER_TURN) {
      return {
        output:
          `WebSearch budget reached for this turn (${MAX_WEBSEARCHES_PER_TURN} searches). ` +
          'Stop searching and synthesize the results already collected.',
      };
    }

    let bestFamily: SearchFamily | null = null;
    let bestSimilarity = 0;
    const tokenSet = new Set(fingerprint.tokens);
    for (const family of this.searchFamilies) {
      const similarity = jaccardSimilarity(tokenSet, family.tokens);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestFamily = family;
      }
    }

    if (bestFamily && bestSimilarity >= SEARCH_FAMILY_SIMILARITY) {
      if (bestFamily.noSignalSearches >= MAX_NO_SIGNAL_SEARCHES_PER_FAMILY) {
        return {
          output:
            `Search stopped: ${bestFamily.noSignalSearches} similar WebSearch queries for this topic ` +
            `already returned empty or low-signal results.\n\n` +
            `Topic exemplar: ${bestFamily.exemplarQuery}\n` +
            'Present what you have instead of rephrasing the same search.',
        };
      }
      if (bestFamily.turnSearches >= MAX_SIMILAR_SEARCHES_PER_TURN) {
        return {
          output:
            `Search stopped: you already ran ${bestFamily.turnSearches} similar WebSearch queries ` +
            `for this topic in the current turn.\n\n` +
            `Topic exemplar: ${bestFamily.exemplarQuery}\n` +
            'Synthesize or switch to a materially different angle.',
        };
      }
    }

    const family = bestFamily && bestSimilarity >= SEARCH_FAMILY_SIMILARITY
      ? bestFamily
      : {
          exemplarQuery: query,
          tokens: tokenSet,
          totalSearches: 0,
          turnSearches: 0,
          noSignalSearches: 0,
        };

    if (family === bestFamily) {
      family.tokens = new Set([...family.tokens, ...tokenSet]);
    } else {
      this.searchFamilies.push(family);
    }

    family.totalSearches++;
    family.turnSearches++;
    this.webSearchesThisTurn++;
    this.pendingSearches.set(invocation.id, { normalized, family });
    return null;
  }

  private beforeRead(
    invocation: CapabilityInvocation,
    scope: ExecutionScope
  ): CapabilityResult | null {
    const filePath = String(invocation.input.file_path ?? '');
    if (!filePath) return null;

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(scope.workingDir, filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    if (stat.isDirectory()) return null;

    const offset = Number(invocation.input.offset ?? 1);
    const limit = Number(invocation.input.limit ?? 2000);
    const key = readKey(resolved, offset, limit);

    const pending = [...this.pendingReads.values()].find((snapshot) => snapshot.key === key);
    if (pending && pending.mtimeMs === stat.mtimeMs && pending.size === stat.size) {
      return {
        output:
          `Skipped duplicate Read of ${resolved}. The same file and line range is already being read ` +
          'in this turn, so reuse that content instead of reading it again.',
      };
    }

    const previous = this.recentReads.get(key);
    if (
      previous &&
      this.turn - previous.turn <= DUPLICATE_READ_TURN_WINDOW &&
      previous.mtimeMs === stat.mtimeMs &&
      previous.size === stat.size
    ) {
      return {
        output:
          `Skipped duplicate Read of ${resolved}. Same file and line range were already read ` +
          `${previous.turn === this.turn ? 'this turn' : 'in the previous turn'}, and the file has not changed.`,
      };
    }

    this.pendingReads.set(invocation.id, {
      key,
      resolved,
      offset,
      limit,
      turn: this.turn,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
    return null;
  }

  private beforeWebFetch(invocation: CapabilityInvocation): CapabilityResult | null {
    const url = String(invocation.input.url ?? '').trim();
    if (!url) return null;
    const maxLength = Number(invocation.input.max_length ?? 12288);
    const key = fetchKey(url, maxLength);

    const pending = [...this.pendingFetches.values()].find((snapshot) => snapshot.key === key);
    if (pending) {
      return {
        output:
          `Skipped duplicate WebFetch of ${url}. The same URL is already being fetched in this turn, ` +
          'so reuse that result instead of fetching it again.',
      };
    }

    const previous = this.recentFetches.get(key);
    if (previous && this.turn - previous.turn <= DUPLICATE_FETCH_TURN_WINDOW) {
      return {
        output:
          `Skipped duplicate WebFetch of ${url}. The same URL was already fetched recently in this session; ` +
          'reuse that content already in context instead of fetching it again.',
      };
    }

    this.pendingFetches.set(invocation.id, {
      key,
      url,
      maxLength,
      turn: this.turn,
    });
    return null;
  }

  private afterWebSearch(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const pending = this.pendingSearches.get(invocation.id);
    if (!pending) return;
    this.pendingSearches.delete(invocation.id);

    const query = String(invocation.input.query ?? '').trim();
    const noSignal = isNoSignalSearchResult(result.output, result.isError);
    if (noSignal) {
      pending.family.noSignalSearches++;
    }

    this.searchCache.set(pending.normalized, {
      query,
      preview: summarizeOutput(result.output),
      noSignal,
    });
  }

  private afterRead(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const pending = this.pendingReads.get(invocation.id);
    if (!pending) return;
    this.pendingReads.delete(invocation.id);
    if (result.isError) return;
    this.recentReads.set(pending.key, pending);
  }

  private afterWebFetch(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const pending = this.pendingFetches.get(invocation.id);
    if (!pending) return;
    this.pendingFetches.delete(invocation.id);
    if (result.isError) return;
    this.recentFetches.set(pending.key, pending);
  }
}
