/**
 * BlockRun agent-market client — the shared engine behind the `/market`
 * slash command (a human browsing + hiring talent) and the agent_talent
 * tool (the agent hiring talent autonomously, mid-task).
 *
 * The market is business.blockrun.ai: a catalog of paid AI skills, each
 * runnable for ONE standard single-leg `exact` x402 USDC payment on Base.
 * Discovery is a free public GET; running a skill is a paid POST that
 * answers a 402 challenge with a wallet-signed payment — the same dance as
 * the gateway capability in src/tools/blockrun.ts, only the payment header
 * name (`x-payment`) and the base URL differ.
 *
 * Base-only by design: the market settles USDC on Base, so a hire always
 * pays from the EVM wallet (getOrCreateWallet) regardless of the session's
 * configured chain.
 */

import {
  getOrCreateWallet,
  createPaymentPayload,
  extractPaymentDetails,
} from '@blockrun/llm';
import { MARKET_URL, USER_AGENT } from '../config.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;

// extractPaymentDetails accepts a parsed PaymentRequired; that interface is
// not exported, so borrow the function's own parameter type for the cast.
type PaymentRequiredLike = Parameters<typeof extractPaymentDetails>[0];

export interface MarketSkill {
  slug: string;
  name: string;
  description: string;
  price_usd: number;
  backing_model: string;
  run_count: number;
  execution_type: 'prompt' | 'agent' | string;
  /** Live-data hostnames an `agent` skill fetches at run time (empty for `prompt`). */
  data_sources: string[];
  sample_input?: string;
  sample_output?: string;
  creator: { wallet: string; x: string | null };
  run_url: string;
}

interface CatalogResponse { skills?: MarketSkill[] }

// ─── Discovery (free) ───────────────────────────────────────────────────────

/** GET the public catalog. No payment. Optional client-side keyword filter. */
export async function fetchCatalog(
  opts: { limit?: number; query?: string; signal?: AbortSignal } = {},
): Promise<MarketSkill[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const url = `${MARKET_URL}/api/v1/skills?limit=${limit}`;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`marketplace returned HTTP ${res.status}`);
    const body = (await res.json()) as CatalogResponse;
    const skills = Array.isArray(body.skills) ? body.skills : [];
    return opts.query ? filterCatalog(skills, opts.query) : skills;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Filter the catalog by the fields a buyer searches on (AND over terms). */
export function filterCatalog(skills: MarketSkill[], query: string): MarketSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  const terms = q.split(/\s+/);
  return skills.filter((s) => {
    const hay = [s.slug, s.name, s.description, s.backing_model, ...(s.data_sources || [])]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// ─── Hire (paid) ────────────────────────────────────────────────────────────

export interface RunOutcome {
  ok: boolean;
  status: number;
  result?: string;
  /** USD authorized on the paid attempt (0 if unpaid / pre-payment 4xx). */
  paidUsd: number;
  txHash: string | null;
  error?: string;
}

async function signMarketPayment(
  challenge: PaymentRequiredLike,
  runUrl: string,
  skillName: string,
): Promise<{ header: string; amountUsd: number }> {
  // `challenge` is the marketplace's 402 body, already parsed:
  // { x402Version, accepts:[{ scheme, network, amount, asset, payTo, ... }], resource }.
  // extractPaymentDetails reads accepts[0] directly (amount + payTo) — no need
  // to round-trip through base64, which would choke on a non-Latin1 skill name
  // in the resource description.
  const details = extractPaymentDetails(challenge);
  const wallet = getOrCreateWallet();
  const header = await createPaymentPayload(
    wallet.privateKey as `0x${string}`,
    wallet.address,
    details.recipient,
    details.amount,
    details.network || 'eip155:8453',
    {
      resourceUrl: details.resource?.url || runUrl,
      // createPaymentPayload base64s the payload with btoa (Latin1-only), so the
      // description must stay ASCII — strip anything else out of the skill name.
      resourceDescription: `Run ${skillName}`.replace(/[^\x20-\x7E]/g, ''),
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra as { name?: string; version?: string } | undefined,
    },
  );
  return { header, amountUsd: Number(details.amount) / 1_000_000 };
}

/**
 * Hire a skill: POST the input, answer the 402 with a signed payment, retry,
 * return the result. Fails closed — the marketplace settles ONLY on a
 * successful run, so any non-2xx means the wallet was not charged.
 */
export async function runMarketSkill(
  slug: string,
  input: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; runUrl?: string } = {},
): Promise<RunOutcome> {
  const runUrl = opts.runUrl || `${MARKET_URL}/api/v1/skills/${encodeURIComponent(slug)}/run`;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  const payload = JSON.stringify({ input });

  try {
    let res = await fetch(runUrl, { method: 'POST', headers, body: payload, signal: ctrl.signal });
    let paidUsd = 0;

    if (res.status === 402) {
      const challenge = (await res.json().catch(() => null)) as
        | (PaymentRequiredLike & { accepts?: unknown[] })
        | null;
      if (!challenge?.accepts?.length) {
        return { ok: false, status: 402, paidUsd: 0, txHash: null, error: 'could not read payment requirements from the marketplace' };
      }
      let signed: { header: string; amountUsd: number };
      try {
        signed = await signMarketPayment(challenge, runUrl, slug);
      } catch (err) {
        return { ok: false, status: 402, paidUsd: 0, txHash: null, error: `payment signing failed: ${(err as Error).message}` };
      }
      paidUsd = signed.amountUsd;
      res = await fetch(runUrl, {
        method: 'POST',
        headers: { ...headers, 'x-payment': signed.header },
        body: payload,
        signal: ctrl.signal,
      });
    }

    const txHash = res.headers.get('x-payment-receipt');
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      const detail = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      // No charge on a non-2xx: the route fails closed before settle.
      return { ok: false, status: res.status, paidUsd: 0, txHash, error: detail };
    }

    const result = typeof body.result === 'string' ? body.result : '';
    return { ok: true, status: res.status, result, paidUsd, txHash };
  } catch (err) {
    return { ok: false, status: 0, paidUsd: 0, txHash: null, error: (err as Error).message || 'request failed' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// ─── Formatting (shared by the /market command + agent_talent tool) ─────────

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function typeBadge(s: MarketSkill): string {
  if (s.execution_type === 'agent' && s.data_sources?.length) return `live:${s.data_sources.join(',')}`;
  return s.execution_type === 'agent' ? 'live' : 'prompt';
}

// Truncate to a column width at a word boundary, with an ellipsis when cut —
// so a row never shows a half-word like "across cha".
function truncate(text: string, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1).replace(/\s+$/, '');
  const sp = cut.lastIndexOf(' ');
  const base = sp >= Math.floor(max * 0.6) ? cut.slice(0, sp) : cut; // word boundary, unless that loses too much
  return `${base}…`;
}

/** A compact numbered list for the terminal (one row per skill). */
export function formatCatalogList(skills: MarketSkill[], opts: { heading?: string } = {}): string {
  if (skills.length === 0) return 'No matching skills in the marketplace.\n';
  const lines = skills.map((s, i) => {
    const n = String(i + 1).padStart(2, ' ');
    // Never truncate the slug — it's the identifier the user types into
    // `/market run <slug>`; pad short ones, let a rare long one overflow.
    const slug = s.slug.padEnd(18);
    const price = fmtUsd(s.price_usd).padStart(7);
    const desc = truncate(s.description || '', 40).padEnd(40);
    const runs = `${s.run_count} run${s.run_count === 1 ? '' : 's'}`;
    const by = s.creator?.x ? ` @${s.creator.x}` : '';
    return `  ${n}. ${slug} ${price}  ${desc} ${runs}${by}`;
  });
  const head = opts.heading ? `${opts.heading}\n` : '';
  const foot = '\n  > /market <keyword> to search  .  /market info <slug>  .  /market run <slug> <input>\n';
  return `${head}${lines.join('\n')}\n${foot}`;
}

/** A fuller detail card for a single skill (shown by `/market info`). */
export function formatSkillCard(s: MarketSkill): string {
  const by = s.creator?.x ? `  .  by @${s.creator.x}` : '';
  const sample = s.sample_input
    ? `  e.g.  ${JSON.stringify(s.sample_input)}${s.sample_output ? `  ->  ${JSON.stringify(s.sample_output)}` : ''}\n`
    : '';
  return (
    `  ${s.name}  .  ${fmtUsd(s.price_usd)}/run  .  ${s.backing_model}  .  ${s.run_count} runs\n` +
    `  ${s.description}\n` +
    `  [${typeBadge(s)}]${by}\n` +
    sample +
    `  > /market run ${s.slug} <your input>\n`
  );
}
