/**
 * Journal quality scorer — non-outcome trade discipline metric.
 *
 * Scores each journal entry on how well it was *justified*, not whether
 * it made money. The five components are weighted to reward the same
 * habits a discretionary trader's playbook teaches:
 *
 *   verifiability (30%)  did the entry name a direction and a price target?
 *   evidence       (25%)  did it cite sources / thesis / indicators?
 *   specificity    (20%)  symbol, tags — not vague vibes?
 *   novelty        (15%)  not the 4th identical revenge-trade this week?
 *   review         (10%)  did the user write a post-trade note?
 *
 * The total is on a 0–5 scale, presented in the portfolio footer so the
 * agent and the user can see the discipline curve over time.
 *
 * Pure function — no I/O, no clock, deterministic given inputs. Used at
 * append time (TradeLog) and at render time (TradingPortfolio).
 */

import type { TradeLogEntry, TradeRationale, QualityScore } from './trade-log.js';

const NOVELTY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const NOVELTY_PENALTY = 0.2;          // per duplicate within window
const EVIDENCE_KEYWORD_REGEX =
  /\b(rsi|macd|bollinger|sma|ema|volatility|funding|liquidation|etf|on[-\s]?chain|catalyst|earnings|tvl|because|since|due to|supports?|resistance|breakout|breakdown|divergence|oversold|overbought)\b/i;

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function hasIndicatorKeyword(text: string | undefined): number {
  if (!text) return 0;
  return EVIDENCE_KEYWORD_REGEX.test(text) ? 1 : 0;
}

/**
 * Score one journal entry against the prior history (used for novelty).
 * `history` should contain entries chronologically before `entry`.
 */
export function scoreEntry(
  entry: TradeLogEntry,
  history: TradeLogEntry[] = [],
): QualityScore {
  const r: TradeRationale | undefined = entry.rationale;

  // ─ verifiability: direction + priceTarget each contribute half ─
  const verifiability =
    (r?.direction ? 0.5 : 0) +
    (typeof r?.priceTarget === 'number' && r.priceTarget > 0 ? 0.5 : 0);

  // ─ evidence: array length, thesis length, indicator keyword presence ─
  const evidenceArrLen = Array.isArray(r?.evidence) ? r!.evidence!.length : 0;
  const thesisLen = (r?.thesis ?? '').trim().length;
  const evidence = clamp01(
    0.4 * Math.min(1, evidenceArrLen / 3) +
    0.4 * Math.min(1, thesisLen / 200) +
    0.2 * hasIndicatorKeyword(r?.thesis),
  );

  // ─ specificity: symbol present + tags present ─
  const tagCount = Array.isArray(r?.tags) ? r!.tags!.length : 0;
  const specificity =
    (entry.symbol ? 0.5 : 0) +
    Math.min(1, tagCount / 2) * 0.5;

  // ─ novelty: penalize same symbol + direction within 7d ─
  const sinceCutoff = entry.timestamp - NOVELTY_WINDOW_MS;
  const recentSameCount = history.filter((e) =>
    e.timestamp >= sinceCutoff &&
    e.timestamp < entry.timestamp &&
    e.symbol === entry.symbol &&
    (e.rationale?.direction ?? null) === (r?.direction ?? null),
  ).length;
  const novelty = clamp01(1 - NOVELTY_PENALTY * recentSameCount);

  // ─ review: did the user (or the agent in a follow-up turn) annotate? ─
  const review = entry.review && entry.review.trim().length > 0 ? 1 : 0;

  const total = 5 * (
    verifiability * 0.30 +
    evidence      * 0.25 +
    specificity   * 0.20 +
    novelty       * 0.15 +
    review        * 0.10
  );

  return {
    total: Math.round(total * 100) / 100, // 2 decimal places
    verifiability,
    evidence,
    specificity,
    novelty,
    review,
  };
}

export interface AggregateScore {
  count: number;
  averageTotal: number;
  averageVerifiability: number;
  averageEvidence: number;
  averageSpecificity: number;
  averageNovelty: number;
  averageReview: number;
}

/**
 * Average the qualityScore fields across a set of entries — used by the
 * portfolio footer to show "your last 10 trades scored 3.2 / 5 on average".
 *
 * Entries without a persisted qualityScore are skipped (back-compat with
 * pre-v3.20 trades). Returns null when there's nothing scored to average.
 */
export function aggregateScores(entries: TradeLogEntry[]): AggregateScore | null {
  const scored = entries.filter((e) => e.qualityScore != null);
  if (scored.length === 0) return null;
  const sum = scored.reduce(
    (acc, e) => {
      const q = e.qualityScore!;
      return {
        total: acc.total + q.total,
        v: acc.v + q.verifiability,
        e: acc.e + q.evidence,
        s: acc.s + q.specificity,
        n: acc.n + q.novelty,
        r: acc.r + q.review,
      };
    },
    { total: 0, v: 0, e: 0, s: 0, n: 0, r: 0 },
  );
  const n = scored.length;
  return {
    count: n,
    averageTotal: sum.total / n,
    averageVerifiability: sum.v / n,
    averageEvidence: sum.e / n,
    averageSpecificity: sum.s / n,
    averageNovelty: sum.n / n,
    averageReview: sum.r / n,
  };
}
