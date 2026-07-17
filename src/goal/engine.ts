/**
 * Goal-engine role runners: planner, adversarial verifier panel,
 * strategist, summarizer. Role calls are ordinary model completions (all
 * recorded via recordUsage so /cost and --max-spend see them); verifiers
 * additionally run a bounded read-only tool loop so they can AUDIT the
 * implementer's evidence rather than take its word.
 */

import { ModelClient } from '../agent/llm.js';
import type {
  CapabilityHandler,
  CapabilityInvocation,
  CapabilityResult,
  Dialogue,
  UserContentPart,
} from '../agent/types.js';
import { recordUsage } from '../stats/tracker.js';
import { estimateCost } from '../pricing.js';
import {
  plannerPrompt,
  strategistPrompt,
  summarizerPrompt,
  verifierPrompt,
  VERIFIER_LENSES,
} from './prompts.js';
import type { GoalKind, GoalState, VerifierVerdict } from './types.js';
import { goalVerifierCount } from './types.js';

/** Read-only surface for verifiers — no writes, no shell, no sub-agents, so
 *  panels can run unattended without hitting a permission prompt. */
const VERIFIER_TOOL_ALLOWLIST = new Set([
  'Read', 'Grep', 'Glob',
  'WebFetch', 'WebSearch',
  'ExaSearch', 'ExaAnswer', 'ExaReadUrls',
  'TradingMarket', 'TradingSignal', 'TradingPortfolio', 'TradingHistory',
  'PredictionMarket', 'SurfMarket', 'Wallet',
]);

export interface GoalEngineContext {
  client: ModelClient;
  model: string;
  capabilities: CapabilityHandler[];
  workingDir: string;
  signal: AbortSignal;
  onProgress?: (text: string) => void;
}

function record(model: string, usage: { inputTokens: number; outputTokens: number }): void {
  try {
    recordUsage(model, usage.inputTokens, usage.outputTokens, estimateCost(model, usage.inputTokens, usage.outputTokens), 0);
  } catch { /* stats are best-effort */ }
}

async function completeText(
  ctx: GoalEngineContext,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const { content, usage } = await ctx.client.complete(
    {
      model: ctx.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: true,
    },
    ctx.signal
  );
  record(ctx.model, usage);
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('\n')
    .trim();
}

// ─── Planner ───────────────────────────────────────────────────────────────

/** Lightweight kind detection — the plan template diverges per kind. */
export function detectGoalKind(objective: string): GoalKind {
  const text = objective.toLowerCase();
  if (/\b(trade|trading|position|portfolio|swap|bet|long|short|rebalance|dca|stop.?loss|take.?profit|polymarket)\b/.test(text)) {
    return 'trading';
  }
  if (/\b(research|compare|investigate|analy[sz]e|find out|survey|report|summar)\b/.test(text)) {
    return 'research';
  }
  return 'general';
}

export async function runPlanner(
  ctx: GoalEngineContext,
  objective: string
): Promise<{ kind: GoalKind; planMd: string }> {
  const kind = detectGoalKind(objective);
  const planMd = await completeText(ctx, plannerPrompt(objective, kind), 4096);
  return { kind, planMd };
}

// ─── Verifier panel ────────────────────────────────────────────────────────

export function parseVerdict(text: string): VerifierVerdict | null {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const start = line.indexOf('{');
    if (start === -1) continue;
    try {
      const obj = JSON.parse(line.slice(start));
      if (typeof obj?.refuted === 'boolean') {
        return {
          refuted: obj.refuted,
          findings: Array.isArray(obj.findings) ? obj.findings.map(String).slice(0, 8) : [],
          confidence: obj.confidence === 'low' || obj.confidence === 'high' ? obj.confidence : 'medium',
          blocking: obj.blocking === 'contradiction' || obj.blocking === 'unverifiable' ? obj.blocking : 'none',
        };
      }
    } catch { /* keep scanning upward */ }
  }
  return null;
}

async function runSingleVerifier(
  ctx: GoalEngineContext,
  goal: GoalState,
  planMd: string,
  claimMessage: string,
  lens: string
): Promise<VerifierVerdict> {
  const tools = ctx.capabilities.filter(c => VERIFIER_TOOL_ALLOWLIST.has(c.spec.name));
  const toolDefs = tools.map(c => c.spec);
  const toolMap = new Map(tools.map(c => [c.spec.name, c]));

  const history: Dialogue[] = [
    { role: 'user', content: verifierPrompt(goal, planMd, claimMessage, lens) },
  ];
  const deadline = Date.now() + 4 * 60 * 1000;
  let finalText = '';

  for (let turn = 0; turn < 12; turn++) {
    if (Date.now() > deadline || ctx.signal.aborted) break;
    const { content, usage } = await ctx.client.complete(
      { model: ctx.model, messages: history, tools: toolDefs, max_tokens: 8192, stream: true },
      ctx.signal
    );
    record(ctx.model, usage);
    history.push({ role: 'assistant', content });

    const invocations: CapabilityInvocation[] = [];
    for (const part of content) {
      if (part.type === 'text') finalText = part.text;
      else if (part.type === 'tool_use') invocations.push(part);
    }
    if (invocations.length === 0) break;

    const outcomes: UserContentPart[] = [];
    for (const inv of invocations) {
      const handler = toolMap.get(inv.name);
      let result: CapabilityResult;
      try {
        result = handler
          ? await handler.execute(inv.input, { workingDir: ctx.workingDir, abortSignal: ctx.signal })
          : { output: `Tool ${inv.name} is not available to verifiers (read-only audit surface).`, isError: true };
      } catch (err) {
        result = { output: `Error: ${(err as Error).message}`, isError: true };
      }
      outcomes.push({
        type: 'tool_result',
        tool_use_id: inv.id,
        content: result.output.slice(0, 20_000),
        is_error: result.isError,
      });
    }
    history.push({ role: 'user', content: outcomes });
  }

  // Unparseable / no verdict = refuted (default-refute doctrine).
  return (
    parseVerdict(finalText) ?? {
      refuted: true,
      findings: ['verifier produced no parseable verdict — treat as refuted and re-verify'],
      confidence: 'low',
      blocking: 'none',
    }
  );
}

export interface PanelOutcome {
  refuted: boolean;
  gaps: string[];
  blocking: 'none' | 'contradiction' | 'unverifiable';
  verdicts: VerifierVerdict[];
}

export async function runVerifierPanel(
  ctx: GoalEngineContext,
  goal: GoalState,
  planMd: string,
  claimMessage: string
): Promise<PanelOutcome> {
  const n = goalVerifierCount();
  const lenses = Array.from({ length: n }, (_, i) => VERIFIER_LENSES[i % VERIFIER_LENSES.length]);
  ctx.onProgress?.(`goal verification: ${n} adversarial reviewers auditing the completion claim…`);

  const verdicts = await Promise.all(
    lenses.map(lens =>
      runSingleVerifier(ctx, goal, planMd, claimMessage, lens).catch((): VerifierVerdict => ({
        refuted: true,
        findings: ['verifier crashed — treat as refuted'],
        confidence: 'low',
        blocking: 'none',
      }))
    )
  );

  const refutedCount = verdicts.filter(v => v.refuted).length;
  const refuted = refutedCount * 2 > verdicts.length; // strict majority
  const gaps = refuted
    ? [...new Set(verdicts.filter(v => v.refuted).flatMap(v => v.findings))].slice(0, 10)
    : [];
  const blocking = verdicts.find(v => v.refuted && v.blocking === 'contradiction')
    ? 'contradiction' as const
    : verdicts.find(v => v.refuted && v.blocking === 'unverifiable')
      ? 'unverifiable' as const
      : 'none' as const;

  return { refuted, gaps, blocking, verdicts };
}

// ─── Strategist & summarizer ───────────────────────────────────────────────

/** Whack-a-mole detector: the last three rounds all refuted with materially
 *  different gap sets (no shared gap between consecutive rounds). */
export function needsStrategist(goal: GoalState): boolean {
  if (goal.strategistNote) return false; // one structural intervention per goal
  const last = goal.rounds.slice(-3);
  if (last.length < 3 || !last.every(r => r.refuted)) return false;
  for (let i = 1; i < last.length; i++) {
    const prev = new Set(last[i - 1].gaps.map(g => g.toLowerCase()));
    if (last[i].gaps.some(g => prev.has(g.toLowerCase()))) return false; // overlapping = converging
  }
  return true;
}

export async function runStrategist(ctx: GoalEngineContext, goal: GoalState, planMd: string): Promise<string> {
  return completeText(ctx, strategistPrompt(goal, planMd), 512);
}

export async function runSummarizer(ctx: GoalEngineContext, goal: GoalState, planMd: string): Promise<string> {
  return completeText(ctx, summarizerPrompt(goal, planMd), 512);
}

/** First unchecked checklist item — the per-turn nudge. */
export function mineNextStep(planMd: string): string | undefined {
  const m = planMd.match(/^- \[ \] (.+)$/m);
  return m?.[1]?.trim();
}
