/**
 * PredictionMarket — unified access to Polymarket / Kalshi / Limitless /
 * Opinion / Predict.Fun / cross-platform / smart-money / wallet endpoints
 * via the BlockRun gateway. Each call settles via x402 against the user's
 * USDC wallet.
 *
 * Powered server-side by Predexon; surfaced to the agent as a single
 * action-dispatched tool so the inventory stays small. Keep one cohesive
 * tool — the way TradingMarket bundles 6 actions — instead of forty
 * one-shot capabilities, otherwise weak models start hallucinating tool
 * names.
 *
 *   searchAll          $0.005  search markets across Polymarket+Kalshi+
 *                              Limitless+Opinion+Predict.Fun in one call
 *   searchPolymarket   $0.001  query Polymarket markets (event filter, sort)
 *   searchKalshi       $0.001  query Kalshi markets
 *   crossPlatform      $0.005  matching market pairs across Polymarket+Kalshi
 *                              (the arbitrage / consensus signal)
 *   leaderboard        $0.001  global Polymarket leaderboard — top wallets by P&L
 *   walletProfile      $0.005  batch profile lookup for one or more Polymarket
 *                              wallets — P&L, positions, identity
 *   smartActivity      $0.005  discover markets where high-performing wallets
 *                              are active right now
 *
 * Replaces the old `smartMoney` action (3.15.69 and earlier) which hit a
 * non-existent path /v1/pm/polymarket/market/<id>/smart-money — that endpoint
 * was never on the gateway, so the action was a silent 404 from day one.
 * Verified 2026-05-05 against blockrun.ai/openapi.json: Polymarket has no
 * per-market path-parameter endpoints; smart-money intelligence lives at
 * /v1/pm/polymarket/markets/smart-activity (cross-market discovery) and
 * /v1/pm/polymarket/leaderboard (top wallets globally).
 *
 * Output is filtered + truncated on the way back so a single call never
 * dumps 100 markets into the agent's context. Default 20 rows; agents that
 * need more should narrow the search.
 */

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
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { loadChain, API_URLS, VERSION } from '../config.js';
import { logger } from '../logger.js';
import { recordFetch } from '../trading/providers/telemetry.js';

const TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Per-action price table — mirrors the Predexon openapi.json. Used to feed
// the Markets-tab telemetry ring buffer so prediction-market spend appears
// in "Calls today / Spend today / Recent paid calls" alongside trading calls.
// If a path isn't here we don't record cost — we still record the fetch
// (success/latency) so panel health stays accurate.
const PATH_PRICES: Array<{ pattern: RegExp; usd: number }> = [
  { pattern: /\/v1\/pm\/markets\/search$/, usd: 0.005 },
  { pattern: /\/v1\/pm\/matching-markets/, usd: 0.005 },
  { pattern: /\/v1\/pm\/polymarket\/wallets\//, usd: 0.005 },
  { pattern: /\/v1\/pm\/polymarket\/wallet\//, usd: 0.005 },
  { pattern: /\/v1\/pm\/polymarket\/markets\/smart-activity$/, usd: 0.005 },
  { pattern: /\/v1\/pm\/.+/, usd: 0.001 },
];

function priceForPath(path: string): number {
  for (const { pattern, usd } of PATH_PRICES) {
    if (pattern.test(path)) return usd;
  }
  return 0;
}

// ─── Shared GET-with-x402 flow ────────────────────────────────────────────

async function getWithPayment<T>(path: string, query: Record<string, string | number | undefined>, ctx: ExecutionScope): Promise<T> {
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    qs.set(k, String(v));
  }
  const queryStr = qs.toString();
  const endpoint = `${apiUrl}${path}${queryStr ? `?${queryStr}` : ''}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  const startedAt = Date.now();
  let costRecorded = 0;
  try {
    let response = await fetch(endpoint, { method: 'GET', signal: controller.signal, headers });

    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint);
      if (!paymentHeaders) {
        throw new Error('Payment signing failed — check wallet balance');
      }
      response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
      });
      // Only record cost on the post-402 settlement; the initial 402
      // response is free and counting it would double-charge the panel.
      costRecorded = priceForPath(path);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // Surface failed paid calls in the Markets-tab health summary.
      recordFetch({ provider: 'blockrun', endpoint: path, ok: false, latencyMs: Date.now() - startedAt });
      throw new Error(`PredictionMarket ${path} failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    recordFetch({
      provider: 'blockrun',
      endpoint: path,
      ok: true,
      latencyMs: Date.now() - startedAt,
      costUsd: costRecorded > 0 ? costRecorded : undefined,
    });
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
): Promise<Record<string, string> | null> {
  try {
    const paymentHeader = await extractPaymentReq(response);
    if (!paymentHeader) return null;

    if (chain === 'solana') {
      const wallet = await getOrCreateSolanaWallet();
      const paymentRequired = parsePaymentRequired(paymentHeader);
      const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
      const secretBytes = await solanaKeyToBytes(wallet.privateKey);
      const feePayer = details.extra?.feePayer || details.recipient;
      const payload = await createSolanaPaymentPayload(
        secretBytes,
        wallet.address,
        details.recipient,
        details.amount,
        feePayer as string,
        {
          resourceUrl: details.resource?.url || endpoint,
          resourceDescription: details.resource?.description || 'Franklin PredictionMarket call',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
    const wallet = await getOrCreateWallet();
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    const payload = await createPaymentPayload(
      wallet.privateKey as `0x${string}`,
      wallet.address,
      details.recipient,
      details.amount,
      details.network || 'eip155:8453',
      {
        resourceUrl: details.resource?.url || endpoint,
        resourceDescription: details.resource?.description || 'Franklin PredictionMarket call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] PredictionMarket payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch {
      /* ignore */
    }
  }
  return header;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(digits)}%`;
}

// Both gateways return slightly different shapes; we intentionally use
// loose typing here because we re-shape into our own markdown anyway.
type PolyMarket = {
  question?: string;
  market_slug?: string;
  condition_id?: string;
  volume?: number;
  liquidity?: number;
  end_date?: string;
  outcomes?: string[];
  outcome_prices?: number[];
  status?: string;
};
type KalshiMarket = {
  ticker?: string;
  event_ticker?: string;
  title?: string;
  yes_bid?: number;
  yes_ask?: number;
  volume?: number;
  open_interest?: number;
  status?: string;
  close_time?: string;
};
type MatchedPair = {
  polymarket_condition_id?: string;
  polymarket_question?: string;
  kalshi_ticker?: string;
  kalshi_title?: string;
  similarity?: number;
};
// API responses sometimes come wrapped as `{data: [...], pagination: ...}`,
// other times as a bare array. Normalise to an array.
function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.markets)) return obj.markets as T[];
    if (Array.isArray(obj.pairs)) return obj.pairs as T[];
    if (Array.isArray(obj.results)) return obj.results as T[];
  }
  return [];
}

// ─── PredictionMarket capability ──────────────────────────────────────────

interface PredictionInput {
  action:
    | 'searchAll'
    | 'searchPolymarket'
    | 'searchKalshi'
    | 'crossPlatform'
    | 'leaderboard'
    | 'walletProfile'
    | 'smartActivity';
  search?: string;
  status?: string;
  sort?: string;
  limit?: number;
  /** Comma-separated wallet addresses or a single address — used by walletProfile. */
  wallets?: string;
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { action, search, status, sort, limit, wallets } = input as unknown as PredictionInput;
  const cappedLimit = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  if (!action) {
    return {
      output: 'Error: action is required (searchAll | searchPolymarket | searchKalshi | crossPlatform | leaderboard | walletProfile | smartActivity)',
      isError: true,
    };
  }

  try {
    switch (action) {
      case 'searchAll': {
        // One $0.005 call across 5 platforms — Polymarket, Kalshi, Limitless,
        // Opinion, Predict.Fun. The right entry point for "is there a market
        // on X anywhere?" — beats firing per-platform searches in parallel.
        const raw = await getWithPayment<unknown>('/v1/pm/markets/search', {
          search,
          status,
          sort,
          limit: cappedLimit,
        }, ctx);
        // Predexon returns either a flat list or per-platform buckets.
        // Try the bucket shape first; fall back to a flat list.
        const lines: string[] = [
          `## Cross-platform market search` + (search ? ` · "${search}"` : ''),
          '_Searched Polymarket, Kalshi, Limitless, Opinion, Predict.Fun in one call._',
          '',
        ];
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const obj = raw as Record<string, unknown>;
          const platforms = ['polymarket', 'kalshi', 'limitless', 'opinion', 'predictfun', 'predict_fun'];
          let totalShown = 0;
          for (const p of platforms) {
            const list = unwrapList<Record<string, unknown>>(obj[p]);
            if (list.length === 0) continue;
            const remaining = cappedLimit - totalShown;
            if (remaining <= 0) break;
            const shown = list.slice(0, Math.min(5, remaining));
            lines.push(`### ${p}`);
            shown.forEach((m, i) => {
              const title = (m.title || m.question || m.market_slug || m.ticker || 'untitled') as string;
              const id = (m.condition_id || m.ticker || m.id) as string | undefined;
              const idTag = id ? ` · \`${String(id).slice(0, 18)}…\`` : '';
              const vol = m.volume != null ? ` · vol ${formatUsd(m.volume as number)}` : '';
              lines.push(`${i + 1}. ${title}${idTag}${vol}`);
              totalShown++;
            });
            lines.push('');
          }
          if (totalShown === 0) {
            // Bucket shape but empty — fall back to flat-list interpretation.
            const flat = unwrapList<Record<string, unknown>>(raw);
            if (flat.length === 0) {
              return { output: 'No markets matched across any platform.' };
            }
            flat.slice(0, cappedLimit).forEach((m, i) => {
              const title = (m.title || m.question || m.market_slug || m.ticker || 'untitled') as string;
              const platform = (m.platform || m.source || 'unknown') as string;
              lines.push(`${i + 1}. **[${platform}]** ${title}`);
            });
          }
        } else {
          const flat = unwrapList<Record<string, unknown>>(raw);
          if (flat.length === 0) {
            return { output: 'No markets matched across any platform.' };
          }
          flat.slice(0, cappedLimit).forEach((m, i) => {
            const title = (m.title || m.question || m.market_slug || m.ticker || 'untitled') as string;
            const platform = (m.platform || m.source || 'unknown') as string;
            lines.push(`${i + 1}. **[${platform}]** ${title}`);
          });
        }
        lines.push(`_$0.005 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'leaderboard': {
        // Global top-wallet ranking. Cheap ($0.001) — the right answer to
        // "who's making money on Polymarket" / "who should I follow".
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/leaderboard', {
          limit: cappedLimit,
          sort,
        }, ctx);
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (rows.length === 0) {
          return { output: 'No leaderboard data returned.' };
        }
        const lines: string[] = [
          `## Polymarket leaderboard — top ${rows.length} wallet${rows.length === 1 ? '' : 's'}`,
          '',
        ];
        rows.forEach((r, i) => {
          const wallet = (r.wallet || r.address || r.proxy_wallet || 'unknown') as string;
          const w = wallet.length > 12
            ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}`
            : wallet;
          const pnl = r.pnl ?? r.realized_pnl ?? r.total_pnl;
          const volume = r.volume ?? r.total_volume;
          const winRate = r.win_rate ?? r.winRate;
          const name = (r.name || r.handle || r.username) as string | undefined;
          const handle = name ? ` (${name})` : '';
          const parts: string[] = [];
          if (pnl != null) parts.push(`P&L ${formatUsd(pnl as number)}`);
          if (volume != null) parts.push(`vol ${formatUsd(volume as number)}`);
          if (winRate != null) parts.push(`win ${formatPct(winRate as number, 0)}`);
          lines.push(`${i + 1}. \`${w}\`${handle}` + (parts.length > 0 ? ` — ${parts.join(' · ')}` : ''));
        });
        lines.push('', `_$0.001 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'walletProfile': {
        if (!wallets || !wallets.trim()) {
          return {
            output: 'Error: `wallets` is required for walletProfile (single address or comma-separated list of Polymarket wallet addresses)',
            isError: true,
          };
        }
        // Predexon's batch endpoint accepts multiple wallets; we forward
        // verbatim. Single wallet works too — caller passes one address.
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/wallets/profiles', {
          wallets: wallets.trim(),
        }, ctx);
        const profiles = unwrapList<Record<string, unknown>>(raw);
        if (profiles.length === 0) {
          return { output: `No profile data returned for: ${wallets}` };
        }
        const lines: string[] = [
          `## Polymarket wallet profile${profiles.length === 1 ? '' : 's'} — ${profiles.length}`,
          '',
        ];
        profiles.forEach((p, i) => {
          const wallet = (p.wallet || p.address || p.proxy_wallet || 'unknown') as string;
          const w = wallet.length > 12
            ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}`
            : wallet;
          const name = (p.name || p.handle || p.username) as string | undefined;
          const pnl = p.pnl ?? p.realized_pnl ?? p.total_pnl;
          const unrealized = p.unrealized_pnl;
          const volume = p.volume ?? p.total_volume;
          const positions = p.positions_count ?? p.open_positions;
          const winRate = p.win_rate ?? p.winRate;
          lines.push(`${i + 1}. \`${w}\`` + (name ? ` (${name})` : ''));
          const stats: string[] = [];
          if (pnl != null) stats.push(`P&L ${formatUsd(pnl as number)}`);
          if (unrealized != null) stats.push(`unrealized ${formatUsd(unrealized as number)}`);
          if (volume != null) stats.push(`vol ${formatUsd(volume as number)}`);
          if (positions != null) stats.push(`${positions} open`);
          if (winRate != null) stats.push(`win ${formatPct(winRate as number, 0)}`);
          if (stats.length > 0) lines.push(`   ${stats.join(' · ')}`);
        });
        lines.push('', `_$0.005 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'smartActivity': {
        // "Discover markets where high-performing wallets are active right now."
        // Replaces the old `smartMoney` action (which hit a non-existent path
        // /v1/pm/polymarket/market/<id>/smart-money — silently 404'd from
        // launch). Verified 2026-05-05 against blockrun.ai/openapi.json.
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/markets/smart-activity', {
          limit: cappedLimit,
          search,
        }, ctx);
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (rows.length === 0) {
          return { output: 'No smart-money activity recorded right now.' };
        }
        const lines: string[] = [
          `## Smart-money activity — ${rows.length} market${rows.length === 1 ? '' : 's'}`,
          '_Markets where high-P&L Polymarket wallets are positioning right now._',
          '',
        ];
        rows.forEach((r, i) => {
          const title = (r.question || r.title || r.market_slug || 'untitled') as string;
          const cid = (r.condition_id || r.id) as string | undefined;
          const cidTag = cid ? ` · \`${String(cid).slice(0, 14)}…\`` : '';
          const smartCount = r.smart_wallets_count ?? r.wallet_count;
          const netFlow = r.net_size ?? r.net_yes_size;
          const stats: string[] = [];
          if (smartCount != null) stats.push(`${smartCount} smart wallet${smartCount === 1 ? '' : 's'}`);
          if (netFlow != null) stats.push(`net ${formatUsd(netFlow as number)}`);
          lines.push(`${i + 1}. **${title}**${cidTag}` + (stats.length > 0 ? `\n   ${stats.join(' · ')}` : ''));
        });
        lines.push('', `_$0.005 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'searchPolymarket': {
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/markets', {
          search,
          status: status ?? 'active',
          sort: sort ?? 'volume',
          limit: cappedLimit,
        }, ctx);
        const markets = unwrapList<PolyMarket>(raw);
        if (markets.length === 0) {
          return { output: 'No Polymarket markets matched the filters.' };
        }
        const lines: string[] = [
          `## Polymarket — ${markets.length} market${markets.length === 1 ? '' : 's'}` +
            (search ? ` · search="${search}"` : '') +
            (status ? ` · status=${status}` : '') +
            ` · sort=${sort ?? 'volume'}`,
          '',
        ];
        markets.forEach((m, i) => {
          const yesPx = m.outcomes && m.outcome_prices && m.outcomes.length === m.outcome_prices.length
            ? m.outcomes.map((o, j) => `${o}=${formatPct(m.outcome_prices![j])}`).join(' / ')
            : 'n/a';
          const cid = m.condition_id ? ` · condition_id=\`${m.condition_id.slice(0, 14)}…\`` : '';
          lines.push(
            `${i + 1}. **${m.question || m.market_slug || 'untitled'}**${cid}\n` +
            `   prices: ${yesPx} · vol: ${formatUsd(m.volume)} · liq: ${formatUsd(m.liquidity)}` +
            (m.end_date ? ` · ends ${m.end_date.slice(0, 10)}` : '')
          );
        });
        lines.push('', `_$0.001 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'searchKalshi': {
        const raw = await getWithPayment<unknown>('/v1/pm/kalshi/markets', {
          search,
          status: status ?? 'open',
          sort: sort ?? 'volume',
          limit: cappedLimit,
        }, ctx);
        const markets = unwrapList<KalshiMarket>(raw);
        if (markets.length === 0) {
          return { output: 'No Kalshi markets matched the filters.' };
        }
        const lines: string[] = [
          `## Kalshi — ${markets.length} market${markets.length === 1 ? '' : 's'}` +
            (search ? ` · search="${search}"` : '') +
            ` · status=${status ?? 'open'} · sort=${sort ?? 'volume'}`,
          '',
        ];
        markets.forEach((m, i) => {
          // Kalshi quotes prices in cents (0–100). Surface them as a tight
          // bid/ask so the agent can read implied probability at a glance.
          const bid = m.yes_bid != null ? `${m.yes_bid}¢` : 'n/a';
          const ask = m.yes_ask != null ? `${m.yes_ask}¢` : 'n/a';
          const ticker = m.ticker ? ` · ticker=\`${m.ticker}\`` : '';
          lines.push(
            `${i + 1}. **${m.title || m.ticker || 'untitled'}**${ticker}\n` +
            `   yes ${bid}/${ask} · vol: ${m.volume?.toLocaleString() ?? 'n/a'} · OI: ${m.open_interest?.toLocaleString() ?? 'n/a'}` +
            (m.close_time ? ` · closes ${m.close_time.slice(0, 10)}` : '')
          );
        });
        lines.push('', `_$0.001 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'crossPlatform': {
        const raw = await getWithPayment<unknown>('/v1/pm/matching-markets/pairs', {
          limit: cappedLimit,
        }, ctx);
        const pairs = unwrapList<MatchedPair>(raw);
        if (pairs.length === 0) {
          return { output: 'No matched market pairs available right now.' };
        }
        const lines: string[] = [
          `## Cross-platform matched pairs — ${pairs.length}`,
          '_Polymarket ↔ Kalshi equivalent markets. Use these to compare implied probabilities across venues._',
          '',
        ];
        pairs.forEach((p, i) => {
          const sim = p.similarity != null ? ` · similarity ${formatPct(p.similarity, 0)}` : '';
          lines.push(
            `${i + 1}. **Polymarket:** ${p.polymarket_question || '(untitled)'}\n` +
            `   **Kalshi:** ${p.kalshi_title || '(untitled)'}` +
            (p.kalshi_ticker ? ` · ticker=\`${p.kalshi_ticker}\`` : '') +
            sim
          );
        });
        lines.push('', `_$0.005 paid via x402._`);
        return { output: lines.join('\n') };
      }

      default:
        return {
          output: `Error: unknown action "${action}". Use: searchAll, searchPolymarket, searchKalshi, crossPlatform, leaderboard, walletProfile, smartActivity`,
          isError: true,
        };
    }
  } catch (err) {
    return { output: `Error: ${(err as Error).message}`, isError: true };
  }
}

export const predictionMarketCapability: CapabilityHandler = {
  spec: {
    name: 'PredictionMarket',
    description:
      'Real prediction market data via the BlockRun gateway (powered by Predexon). Use for any "what are the odds of X" / "Polymarket on Y" / "is there a market on Z" / "follow this trader" question. ' +
      'Actions: ' +
      '`searchAll` (search markets across Polymarket+Kalshi+Limitless+Opinion+Predict.Fun in one call — $0.005), ' +
      '`searchPolymarket` (Polymarket only, supports sort+status — $0.001), ' +
      '`searchKalshi` (Kalshi only, supports sort+status — $0.001), ' +
      '`crossPlatform` (matched market pairs across Polymarket+Kalshi for arbitrage / consensus — $0.005), ' +
      '`leaderboard` (global top wallets by P&L on Polymarket — $0.001), ' +
      '`walletProfile` (P&L + positions for one or more Polymarket wallets — $0.005), ' +
      '`smartActivity` (markets where high-P&L wallets are positioning right now — $0.005). ' +
      'Default routing: ' +
      '"is there a market on X anywhere" → searchAll. ' +
      '"top wallets / who is profitable / who should I follow on Polymarket" → leaderboard. ' +
      '"how is wallet 0xabc doing / show me their P&L" → walletProfile with that address. ' +
      '"what are smart traders betting on right now" → smartActivity. ' +
      '"should I bet on X" → run searchPolymarket + searchKalshi in parallel and compare implied probabilities — divergence is the signal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: [
            'searchAll',
            'searchPolymarket',
            'searchKalshi',
            'crossPlatform',
            'leaderboard',
            'walletProfile',
            'smartActivity',
          ],
          description: 'Which prediction-market query to run. See tool description for cost per action.',
        },
        search: {
          type: 'string',
          description: 'Search query. Used by searchAll / searchPolymarket / searchKalshi / smartActivity. Optional for crossPlatform/leaderboard/walletProfile.',
        },
        status: {
          type: 'string',
          description: 'Polymarket: active | closed | archived (default active). Kalshi: open | closed (default open). Forwarded to searchAll where supported.',
        },
        sort: {
          type: 'string',
          description: 'Polymarket: volume | liquidity | created (default volume). Kalshi: volume | open_interest | price_desc | price_asc | close_time (default volume). leaderboard: pnl | volume | win_rate (gateway-defined).',
        },
        limit: {
          type: 'number',
          description: `Max results (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`,
        },
        wallets: {
          type: 'string',
          description: 'For walletProfile: a single Polymarket wallet address, or a comma-separated list of addresses for batch lookup.',
        },
      },
      required: ['action'],
    },
  },
  execute,
  concurrent: true,
};
