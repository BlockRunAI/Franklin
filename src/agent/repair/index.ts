/**
 * Tool-call repair pipeline — ported and adapted from reasonix (MIT).
 *
 * The pipeline has three layers, each used at a different boundary:
 *
 *   1. `repairTruncatedJson(rawArgs)` — call at the LLM-client boundary,
 *      right before JSON.parse on the streamed tool_use input. Catches
 *      max_tokens-cut-mid-structure and rebalances the braces.
 *   2. `ToolCallRepair.process(calls, reasoning, content)` — call once
 *      the assistant turn has finished but before dispatch. Scavenges
 *      tool calls the model leaked into text/reasoning channels and
 *      merges them in (deduped).
 *   3. `analyzeSchema` + `flattenSchema` + `nestArguments` — apply at
 *      tool-registration time for tools whose schemas are deep or wide
 *      enough that smaller models drop required params.
 *
 * Storm suppression is intentionally not part of this pipeline.
 * Franklin's `SessionToolGuard` (src/agent/tool-guard.ts) already does
 * per-tool repeat suppression with richer logic — Jaccard search
 * families, mtime-aware Read cache, per-tool circuit breakers.
 */
import type { CapabilityInvocation } from '../types.js';
import { scavengeToolCalls } from './scavenge.js';
import { repairTruncatedJson } from './truncation.js';

export { analyzeSchema, flattenSchema, nestArguments } from './flatten.js';
export type { FlattenDecision, SchemaNode } from './flatten.js';
export { repairTruncatedJson } from './truncation.js';
export type { TruncationRepairResult } from './truncation.js';
export { scavengeToolCalls } from './scavenge.js';
export type { ScavengeOptions, ScavengeResult } from './scavenge.js';

export interface RepairReport {
  scavenged: number;
  duplicatesDropped: number;
  notes: string[];
}

export interface ToolCallRepairOptions {
  allowedToolNames: ReadonlySet<string>;
  maxScavenge?: number;
}

/** Boundary-level helper: parse tool-use argument JSON with truncation
 *  recovery. Returns `null` if every attempt fails and the caller should
 *  reject the call (better than dispatching with `{}`).
 *
 *  Usage at the streaming-client boundary:
 *    const args = repairAndParseArgs(jsonAccumulator);
 *    if (args == null) return reject("invalid JSON in tool_use");
 */
export function repairAndParseArgs(
  raw: string,
): { input: Record<string, unknown>; repaired: boolean; notes: string[] } | null {
  const r = repairTruncatedJson(raw);
  if (r.fallback) return null;
  try {
    const parsed = JSON.parse(r.repaired);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { input: parsed as Record<string, unknown>, repaired: r.changed, notes: r.notes };
    }
    return null;
  } catch {
    return null;
  }
}

export class ToolCallRepair {
  private readonly opts: ToolCallRepairOptions;

  constructor(opts: ToolCallRepairOptions) {
    this.opts = opts;
  }

  /**
   * Scavenge leaked tool calls from text/reasoning channels and merge
   * into the declared list, deduped.
   *
   * @param declaredCalls  Tool calls the model emitted structurally.
   * @param reasoningText  Optional reasoning_content / thinking text.
   * @param contentText    Optional plain text-channel content.
   */
  process(
    declaredCalls: CapabilityInvocation[],
    reasoningText: string | null,
    contentText: string | null = null,
  ): { calls: CapabilityInvocation[]; report: RepairReport } {
    const report: RepairReport = { scavenged: 0, duplicatesDropped: 0, notes: [] };

    const combined = [reasoningText ?? '', contentText ?? ''].filter(Boolean).join('\n');
    const scavenged = scavengeToolCalls(combined || null, {
      allowedNames: this.opts.allowedToolNames,
      maxCalls: this.opts.maxScavenge ?? 4,
    });
    const seenSignatures = new Set(declaredCalls.map(signature));
    const merged: CapabilityInvocation[] = [...declaredCalls];
    for (const sc of scavenged.calls) {
      const sig = signature(sc);
      if (seenSignatures.has(sig)) {
        report.duplicatesDropped++;
        continue;
      }
      merged.push(sc);
      report.scavenged++;
      seenSignatures.add(sig);
    }
    report.notes.push(...scavenged.notes);

    return { calls: merged, report };
  }
}

function signature(call: CapabilityInvocation): string {
  return `${call.name}::${stableStringify(call.input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
