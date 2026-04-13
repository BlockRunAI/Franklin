/**
 * Session insights engine.
 *
 * Rich usage analytics from the stats tracker history.
 * Inspired by hermes-agent's `agent/insights.py` and Claude Code's /insights.
 *
 * Provides:
 *   - Per-model cost and request breakdown
 *   - Daily activity trend (sparkline)
 *   - Top sessions by cost
 *   - Tool usage patterns
 *   - Cost projections and efficiency metrics
 */

import { loadStats } from './tracker.js';
import type { UsageRecord } from './tracker.js';
import { OPUS_PRICING, MODEL_PRICING } from '../pricing.js';
import { formatTokens, formatUsd, shortModelName } from './format.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface InsightsReport {
  /** Window size in days */
  days: number;
  /** Records within the window */
  windowRecords: number;
  /** Total cost in window */
  totalCostUsd: number;
  /** Total input tokens in window */
  totalInputTokens: number;
  /** Total output tokens in window */
  totalOutputTokens: number;
  /** Savings vs always using Claude Opus */
  savedVsOpusUsd: number;
  /** Per-model breakdown, sorted by cost desc */
  byModel: Array<{
    model: string;
    requests: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
    percentOfTotal: number;
  }>;
  /** Daily activity (last N days), oldest first */
  daily: Array<{
    date: string;      // YYYY-MM-DD
    requests: number;
    costUsd: number;
  }>;
  /** Projections */
  projections: {
    avgCostPerDay: number;
    projectedMonthlyUsd: number;
    projectedYearlyUsd: number;
  };
  /** Average request cost */
  avgRequestCostUsd: number;
  /** Efficiency: cost per 1K tokens */
  costPer1KTokens: number;
}

// ─── Generate Report ──────────────────────────────────────────────────────

export function generateInsights(days = 30): InsightsReport {
  const stats = loadStats();
  const now = Date.now();
  const windowStart = now - days * 24 * 60 * 60 * 1000;

  const windowHistory = stats.history.filter(r => r.timestamp >= windowStart);

  // Aggregate totals
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const modelAgg = new Map<string, {
    requests: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    totalLatencyMs: number;
  }>();

  for (const r of windowHistory) {
    totalCost += r.costUsd;
    totalInput += r.inputTokens;
    totalOutput += r.outputTokens;

    const existing = modelAgg.get(r.model) ?? {
      requests: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalLatencyMs: 0,
    };
    existing.requests++;
    existing.costUsd += r.costUsd;
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.totalLatencyMs += r.latencyMs;
    modelAgg.set(r.model, existing);
  }

  // Build byModel array sorted by cost
  const byModel: InsightsReport['byModel'] = [];
  for (const [model, agg] of modelAgg.entries()) {
    byModel.push({
      model,
      requests: agg.requests,
      costUsd: agg.costUsd,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      avgLatencyMs: agg.requests > 0 ? Math.round(agg.totalLatencyMs / agg.requests) : 0,
      percentOfTotal: totalCost > 0 ? (agg.costUsd / totalCost) * 100 : 0,
    });
  }
  byModel.sort((a, b) => b.costUsd - a.costUsd);

  // Daily activity
  const dailyMap = new Map<string, { requests: number; costUsd: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dailyMap.set(key, { requests: 0, costUsd: 0 });
  }
  for (const r of windowHistory) {
    const key = new Date(r.timestamp).toISOString().slice(0, 10);
    const existing = dailyMap.get(key);
    if (existing) {
      existing.requests++;
      existing.costUsd += r.costUsd;
    }
  }
  const daily: InsightsReport['daily'] = Array.from(dailyMap.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Calculate savings vs Opus
  const opusCostPer1M = (OPUS_PRICING.input + OPUS_PRICING.output) / 2;
  const opusWouldCost = ((totalInput + totalOutput) / 1_000_000) * opusCostPer1M;
  const savedVsOpusUsd = Math.max(0, opusWouldCost - totalCost);

  // Projections
  const avgCostPerDay = days > 0 ? totalCost / days : 0;
  const projections = {
    avgCostPerDay,
    projectedMonthlyUsd: avgCostPerDay * 30,
    projectedYearlyUsd: avgCostPerDay * 365,
  };

  // Efficiency
  const totalTokens = totalInput + totalOutput;
  const costPer1KTokens = totalTokens > 0 ? (totalCost / totalTokens) * 1000 : 0;
  const avgRequestCostUsd = windowHistory.length > 0 ? totalCost / windowHistory.length : 0;

  return {
    days,
    windowRecords: windowHistory.length,
    totalCostUsd: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    savedVsOpusUsd,
    byModel,
    daily,
    projections,
    avgRequestCostUsd,
    costPer1KTokens,
  };
}

// ─── Format for Display ───────────────────────────────────────────────────

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max === 0) return '▁'.repeat(values.length);
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return values.map(v => chars[Math.min(7, Math.floor((v / max) * 8))]).join('');
}

export function formatInsights(report: InsightsReport, days: number): string {
  const sep = '─'.repeat(60);
  const lines: string[] = [];

  lines.push('');
  lines.push(sep);
  lines.push(`  RUNCODE INSIGHTS — last ${days} days`);
  lines.push(sep);

  if (report.windowRecords === 0) {
    lines.push('');
    lines.push('  No activity in this window.');
    lines.push('');
    lines.push(sep);
    lines.push('');
    return lines.join('\n');
  }

  // Summary
  lines.push('');
  lines.push(`  Requests:     ${report.windowRecords}`);
  lines.push(`  Total cost:   ${formatUsd(report.totalCostUsd)}`);
  lines.push(`  Input tokens: ${formatTokens(report.totalInputTokens)}`);
  lines.push(`  Output tokens: ${formatTokens(report.totalOutputTokens)}`);
  lines.push(`  Avg/request:  ${formatUsd(report.avgRequestCostUsd)}  (${formatUsd(report.costPer1KTokens)}/1K tokens)`);

  if (report.savedVsOpusUsd > 0) {
    lines.push(`  Saved vs Opus: ${formatUsd(report.savedVsOpusUsd)} by using cheaper models`);
  }

  // Projections
  lines.push('');
  lines.push('  Projection:');
  lines.push(`    Per day:  ${formatUsd(report.projections.avgCostPerDay)}`);
  lines.push(`    Per month: ${formatUsd(report.projections.projectedMonthlyUsd)}`);
  lines.push(`    Per year: ${formatUsd(report.projections.projectedYearlyUsd)}`);

  // Per-model breakdown
  if (report.byModel.length > 0) {
    lines.push('');
    lines.push('  By model:');
    for (const m of report.byModel.slice(0, 10)) {
      const name = shortModelName(m.model).padEnd(30);
      const cost = formatUsd(m.costUsd).padStart(8);
      const pct = `${m.percentOfTotal.toFixed(0)}%`.padStart(4);
      const reqs = `${m.requests}req`.padStart(7);
      lines.push(`    ${name}  ${cost}  ${pct}  ${reqs}`);
    }
  }

  // Daily activity sparkline
  if (report.daily.length > 0) {
    const costs = report.daily.map(d => d.costUsd);
    const requests = report.daily.map(d => d.requests);
    lines.push('');
    lines.push('  Daily activity:');
    lines.push(`    Requests: ${sparkline(requests)}  ${report.daily[0].date} → ${report.daily[report.daily.length - 1].date}`);
    lines.push(`    Cost:     ${sparkline(costs)}`);
  }

  lines.push('');
  lines.push(sep);
  lines.push('');

  return lines.join('\n');
}

// Silence unused import warning
void MODEL_PRICING;
