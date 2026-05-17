/**
 * Markdown footer for `TradingPortfolio` — the discipline mirror.
 *
 * Shows the last-N trades' average quality score and flags any component
 * that scored below 3.0 (the threshold AI-Trader uses too). The footer
 * is the only place the discipline metric surfaces today; future
 * releases can drop it into the panel Audit tab too.
 *
 * Pure formatting; takes AggregateScore from journal-quality.ts.
 */

import type { TradeLogEntry } from './trade-log.js';
import { aggregateScores, type AggregateScore } from './journal-quality.js';

const COMPONENT_WARN_THRESHOLD = 3.0; // out of 5

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function flagFor(component: keyof Omit<AggregateScore, 'count' | 'averageTotal'>): string {
  switch (component) {
    case 'averageVerifiability': return 'most trades missing direction or price target';
    case 'averageEvidence':      return 'most trades missing thesis or sources';
    case 'averageSpecificity':   return 'few tags — trades feel generic';
    case 'averageNovelty':       return 'repeating same symbol/direction';
    case 'averageReview':        return 'no post-trade notes';
  }
}

/**
 * Build the discipline footer markdown for an existing portfolio output.
 * Returns `null` when there's nothing to show (no scored entries yet).
 */
export function renderDisciplineFooter(entries: TradeLogEntry[]): string | null {
  const agg = aggregateScores(entries);
  if (!agg) return null;

  const lines: string[] = [];
  lines.push('');
  lines.push('### Journal discipline');
  lines.push(`Last ${agg.count} scored trade${agg.count === 1 ? '' : 's'}: ` +
    `**${fmt(agg.averageTotal)} / 5**`);
  lines.push('');

  // Each component scaled to 0–5 for display (internal is 0–1).
  const components: Array<{ key: keyof Omit<AggregateScore, 'count' | 'averageTotal'>; label: string; value: number }> = [
    { key: 'averageVerifiability', label: 'verifiability', value: agg.averageVerifiability * 5 },
    { key: 'averageEvidence',      label: 'evidence',      value: agg.averageEvidence * 5 },
    { key: 'averageSpecificity',   label: 'specificity',   value: agg.averageSpecificity * 5 },
    { key: 'averageNovelty',       label: 'novelty',       value: agg.averageNovelty * 5 },
    { key: 'averageReview',        label: 'review',        value: agg.averageReview * 5 },
  ];

  for (const c of components) {
    const flagged = c.value < COMPONENT_WARN_THRESHOLD;
    const flagText = flagged ? `  ←  ${flagFor(c.key)}` : '';
    lines.push(`- ${c.label.padEnd(14)} ${fmt(c.value).padStart(5)}${flagText}`);
  }

  return lines.join('\n');
}
