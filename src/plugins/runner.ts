/**
 * Workflow Runner — orchestrates execution of any Workflow.
 *
 * Plugin-agnostic: takes a Workflow + config, runs steps, handles
 * model dispatch, dedup, tracking, dry-run.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { ModelClient } from '../agent/llm.js';
import { estimateCost } from '../pricing.js';
import { USER_AGENT } from '../config.js';
import type {
  Workflow,
  WorkflowConfig,
  WorkflowResult,
  WorkflowStepContext,
  ModelTier,
  ModelTierConfig,
} from '../plugin-sdk/workflow.js';
import { DEFAULT_MODEL_TIERS } from '../plugin-sdk/workflow.js';
import type { SearchResult } from '../plugin-sdk/search.js';
import type { ChannelMessage } from '../plugin-sdk/channel.js';
import type { WorkflowStats, TrackedAction } from '../plugin-sdk/tracker.js';

// ─── Storage ──────────────────────────────────────────────────────────────

const WORKFLOW_DIR = path.join(os.homedir(), '.blockrun', 'workflows');

function ensureDir(): void {
  fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
}

function getDbPath(workflow: string): string {
  return path.join(WORKFLOW_DIR, `${workflow}.jsonl`);
}

function getConfigPath(workflow: string): string {
  return path.join(WORKFLOW_DIR, `${workflow}.config.json`);
}

// ─── Config Persistence ───────────────────────────────────────────────────

export function loadWorkflowConfig(workflowId: string): WorkflowConfig | null {
  try {
    const p = getConfigPath(workflowId);
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      raw.models = { ...DEFAULT_MODEL_TIERS, ...raw.models };
      raw.name = workflowId;
      return raw as WorkflowConfig;
    }
  } catch { /* corrupt */ }
  return null;
}

export function saveWorkflowConfig(workflowId: string, config: WorkflowConfig): void {
  ensureDir();
  fs.writeFileSync(getConfigPath(workflowId), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// ─── Tracker ──────────────────────────────────────────────────────────────

interface TrackerEntry extends TrackedAction {}

function trackAction(workflow: string, action: string, key: string, metadata: Record<string, unknown> = {}, costUsd = 0): void {
  ensureDir();
  const entry: TrackerEntry = {
    workflow,
    action,
    key,
    metadata,
    costUsd,
    createdAt: new Date().toISOString(),
  };
  fs.appendFileSync(getDbPath(workflow), JSON.stringify(entry) + '\n');
}

function isDuplicate(workflow: string, key: string): boolean {
  const dbPath = getDbPath(workflow);
  if (!fs.existsSync(dbPath)) return false;
  try {
    const lines = fs.readFileSync(dbPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TrackerEntry;
        if (entry.key === key) return true;
      } catch { /* skip */ }
    }
  } catch { /* no db */ }
  return false;
}

export function getStats(workflow: string): WorkflowStats {
  const stats: WorkflowStats = {
    totalRuns: 0,
    totalActions: 0,
    totalCostUsd: 0,
    todayActions: 0,
    todayCostUsd: 0,
    byAction: {},
  };
  const dbPath = getDbPath(workflow);
  if (!fs.existsSync(dbPath)) return stats;

  const today = new Date().toISOString().slice(0, 10);
  try {
    const lines = fs.readFileSync(dbPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TrackerEntry;
        stats.totalActions++;
        stats.totalCostUsd += entry.costUsd;
        stats.byAction[entry.action] = (stats.byAction[entry.action] || 0) + 1;
        if (entry.action === 'run_start') stats.totalRuns++;
        if (entry.createdAt.startsWith(today)) {
          stats.todayActions++;
          stats.todayCostUsd += entry.costUsd;
        }
        stats.lastRun = entry.createdAt;
      } catch { /* skip */ }
    }
  } catch { /* no db */ }
  return stats;
}

export function getByAction(workflow: string, action: string): TrackerEntry[] {
  const dbPath = getDbPath(workflow);
  if (!fs.existsSync(dbPath)) return [];
  try {
    const lines = fs.readFileSync(dbPath, 'utf-8').split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l) as TrackerEntry; } catch { return null; } })
      .filter((e): e is TrackerEntry => e !== null && e.action === action);
  } catch { return []; }
}

// ─── Model Tier Resolution ────────────────────────────────────────────────

function resolveModel(tier: ModelTier, tiers: ModelTierConfig): string | null {
  switch (tier) {
    case 'free': return tiers.free;
    case 'cheap': return tiers.cheap;
    case 'premium': return tiers.premium;
    case 'none': return null;
  }
}

// ─── Channel Search Adapter ───────────────────────────────────────────────

import { listChannelPlugins } from './registry.js';

/** Default web search fallback using DuckDuckGo HTML */
async function defaultWebSearch(
  query: string,
  options?: { sources?: string[]; maxResults?: number }
): Promise<SearchResult[]> {
  const maxResults = Math.min(Math.max(options?.maxResults ?? 8, 1), 20);
  const domainHints = (options?.sources ?? [])
    .map(sourceToDomainHint)
    .filter((domain): domain is string => Boolean(domain));
  const scopedQueries = Array.from(new Set([
    ...domainHints.map((domain) => `${query} site:${domain}`),
    query,
  ])).slice(0, 3);
  const merged: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const scoped of scopedQueries) {
    const results = await searchDuckDuckGo(scoped, maxResults);
    for (const result of results) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      merged.push(result);
      if (merged.length >= maxResults) return merged;
    }
  }

  if (merged.length === 0 && scopedQueries[scopedQueries.length - 1] !== query) {
    return searchDuckDuckGo(query, maxResults);
  }

  return merged;
}

function sourceToDomainHint(source: string): string | null {
  const normalized = source.toLowerCase();
  if (normalized === 'reddit') return 'reddit.com';
  if (normalized === 'x' || normalized === 'twitter') return 'x.com';
  if (normalized === 'web') return null;
  return null;
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const html = await response.text();
    return parseDuckDuckGoResults(html, maxResults);
  } catch {
    return [];
  }
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let links = [...html.matchAll(linkRegex)];
  const snippets = [...html.matchAll(snippetRegex)];

  if (links.length === 0) {
    const fallbackLink = /<a[^>]*class="[^"]*result[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    links = [...html.matchAll(fallbackLink)];
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const link = links[i];
    const snippet = snippets[i];
    const decodedUrl = decodeDuckDuckGoUrl(link[1] ?? '');
    if (!decodedUrl || decodedUrl.startsWith('/') || decodedUrl.includes('duckduckgo.com')) continue;

    results.push({
      title: stripHtml(link[2] ?? '').trim(),
      url: decodedUrl,
      snippet: stripHtml(snippet?.[1] ?? '').trim(),
      source: inferSource(decodedUrl),
    });
  }

  return results;
}

function decodeDuckDuckGoUrl(url: string): string {
  const uddg = url.match(/[?&]uddg=([^&]+)/);
  if (uddg?.[1]) {
    try { return decodeURIComponent(uddg[1]); } catch { return url; }
  }
  return url;
}

function inferSource(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('reddit.com')) return 'reddit';
  if (lower.includes('x.com') || lower.includes('twitter.com')) return 'x';
  return 'web';
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Resolve channel by id and call its search method */
async function searchViaChannel(
  channelId: string,
  query: string,
  options?: { sources?: string[]; maxResults?: number }
): Promise<SearchResult[]> {
  const channelPlugins = listChannelPlugins();
  for (const cp of channelPlugins) {
    if (cp.plugin.channels?.[channelId]) {
      const channel = cp.plugin.channels[channelId]();
      try {
        const result = await channel.search(query, {
          log: (msg) => process.stderr.write(`[${channelId}] ${msg}\n`),
          dryRun: false,
        }, { maxResults: options?.maxResults });
        return result.posts.map(p => ({
          title: p.title,
          url: p.url,
          snippet: p.body,
          source: p.platform,
          author: p.author,
          timestamp: p.createdAt,
          score: p.score,
          commentCount: p.commentCount,
        }));
      } catch (err) {
        process.stderr.write(`[${channelId}] search failed: ${(err as Error).message}\n`);
      }
    }
  }
  return [];
}

// ─── Workflow Runner ──────────────────────────────────────────────────────

export async function runWorkflow(
  workflow: Workflow,
  config: WorkflowConfig,
  client: ModelClient,
  options: { dryRun?: boolean } = {}
): Promise<WorkflowResult> {
  const dryRun = options.dryRun ?? false;
  const start = Date.now();
  const stepResults: WorkflowResult['steps'] = [];
  let totalCost = 0;
  let itemsProcessed = 0;
  const data: Record<string, unknown> = {};
  const tiers = config.models ?? DEFAULT_MODEL_TIERS;

  trackAction(workflow.id, 'run_start', `run-${Date.now()}`, { dryRun });

  // Lifecycle hook
  if (workflow.beforeRun) {
    try { await workflow.beforeRun(config); } catch (err) {
      process.stderr.write(`[${workflow.id}] beforeRun failed: ${(err as Error).message}\n`);
    }
  }

  const ctx: WorkflowStepContext = {
    data,
    config,
    dryRun,
    callModel: async (tier, prompt, system) => {
      if (tier === 'none') throw new Error('Cannot call model with tier "none"');
      const model = resolveModel(tier, tiers);
      if (!model) throw new Error(`No model resolved for tier ${tier}`);
      const result = await client.complete({
        model,
        messages: [{ role: 'user', content: prompt }],
        system,
        max_tokens: 4096,
        stream: true,
      });
      let text = '';
      for (const part of result.content) {
        if (part.type === 'text') text += part.text;
      }
      const cost = estimateCost(model, result.usage.inputTokens, result.usage.outputTokens, 1);
      totalCost += cost;
      return text;
    },
    search: async (query, opts) => {
      // Try channel search first if scope hints at a channel
      if (opts?.sources && opts.sources.length > 0) {
        for (const source of opts.sources) {
          const results = await searchViaChannel(source, query, opts);
          if (results.length > 0) return results;
        }
      }
      return defaultWebSearch(query, opts);
    },
    sendMessage: async (channelId: string, message: ChannelMessage) => {
      if (dryRun) {
        process.stderr.write(`[${workflow.id}] [dry-run] would send to ${channelId}\n`);
        return;
      }
      const channelPlugins = listChannelPlugins();
      for (const cp of channelPlugins) {
        if (cp.plugin.channels?.[channelId]) {
          const channel = cp.plugin.channels[channelId]();
          await channel.post(message, {
            log: (msg) => process.stderr.write(`[${channelId}] ${msg}\n`),
            dryRun,
          });
          return;
        }
      }
      throw new Error(`Channel "${channelId}" not found`);
    },
    log: (msg) => process.stderr.write(`[${workflow.id}] ${msg}\n`),
    track: async (action, metadata) => {
      trackAction(workflow.id, action, `${action}-${Date.now()}`, metadata, 0);
    },
    isDuplicate: async (key) => isDuplicate(workflow.id, key),
  };

  for (const step of workflow.steps) {
    if (dryRun && step.skipInDryRun) {
      stepResults.push({ name: step.name, summary: '[dry-run] skipped', cost: 0, status: 'skipped' });
      continue;
    }

    process.stderr.write(`[${workflow.id}] → ${step.name}...\n`);

    try {
      const result = await step.execute(ctx);
      if (result.data) Object.assign(data, result.data);
      const stepCost = result.cost ?? 0;
      totalCost += stepCost;
      if (result.data?.itemCount) itemsProcessed += result.data.itemCount as number;

      stepResults.push({
        name: step.name,
        summary: result.summary ?? 'done',
        cost: stepCost,
        status: result.abort ? 'aborted' : 'ok',
      });

      if (result.abort) {
        process.stderr.write(`[${workflow.id}] ⚠ ${step.name}: ${result.summary ?? 'aborted'}\n`);
        break;
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      process.stderr.write(`[${workflow.id}] ✗ ${step.name}: ${errMsg}\n`);
      stepResults.push({ name: step.name, summary: `error: ${errMsg}`, cost: 0, status: 'error' });
      break;
    }
  }

  const result: WorkflowResult = {
    steps: stepResults,
    totalCost,
    itemsProcessed,
    durationMs: Date.now() - start,
    dryRun,
  };

  trackAction(workflow.id, 'run_complete', `run-${Date.now()}`, {
    dryRun, totalCost, itemsProcessed, durationMs: result.durationMs,
  }, totalCost);

  if (workflow.afterRun) {
    try { await workflow.afterRun(result); } catch (err) {
      process.stderr.write(`[${workflow.id}] afterRun failed: ${(err as Error).message}\n`);
    }
  }

  return result;
}

// ─── Display ──────────────────────────────────────────────────────────────

export function formatWorkflowResult(workflow: Workflow, result: WorkflowResult): string {
  const lines: string[] = [];
  const sep = '─'.repeat(50);
  lines.push(`\n${sep}`);
  lines.push(`${workflow.name.toUpperCase()} ${result.dryRun ? '[DRY RUN]' : 'COMPLETE'}`);
  lines.push(sep);
  for (const step of result.steps) {
    const costStr = step.cost > 0 ? ` ($${step.cost.toFixed(4)})` : '';
    const status = inferStepStatus(step);
    const icon = status === 'error'
      ? '✗'
      : status === 'aborted'
        ? '⚠'
        : status === 'skipped'
          ? '○'
          : '✓';
    lines.push(`  ${icon} ${step.name}: ${step.summary}${costStr}`);
  }
  lines.push(sep);
  lines.push(`  Items: ${result.itemsProcessed}  Cost: $${result.totalCost.toFixed(4)}  Time: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`${sep}\n`);
  return lines.join('\n');
}

function inferStepStatus(step: WorkflowResult['steps'][number]): 'ok' | 'error' | 'aborted' | 'skipped' {
  if (step.status) return step.status;

  const summary = step.summary.toLowerCase();
  if (summary.startsWith('error')) return 'error';
  if (summary.includes('abort')) return 'aborted';
  if (summary.includes('no posts found')) return 'aborted';
  if (summary.includes('[dry-run] skipped')) return 'skipped';
  if (summary.includes(' skipped')) return 'skipped';
  return 'ok';
}

export function formatWorkflowStats(workflow: Workflow, stats: WorkflowStats): string {
  const lines: string[] = [];
  const sep = '─'.repeat(40);
  lines.push(`\n${sep}\n${workflow.name.toUpperCase()} STATS\n${sep}`);
  lines.push(`  Total runs: ${stats.totalRuns}`);
  lines.push(`  Total actions: ${stats.totalActions}`);
  lines.push(`  Total cost: $${stats.totalCostUsd.toFixed(4)}`);
  lines.push(`  Today: ${stats.todayActions} actions, $${stats.todayCostUsd.toFixed(4)}`);
  if (stats.lastRun) lines.push(`  Last run: ${stats.lastRun}`);
  if (Object.keys(stats.byAction).length > 0) {
    lines.push(`  By action:`);
    for (const [action, count] of Object.entries(stats.byAction)) {
      if (action !== 'run_start' && action !== 'run_complete') {
        lines.push(`    ${action}: ${count}`);
      }
    }
  }
  lines.push(`${sep}\n`);
  return lines.join('\n');
}
