/**
 * agent_talent — hire paid AI skills from the BlockRun agent marketplace.
 *
 * The autonomous counterpart to the `/market` slash command: where `/market`
 * lets a human browse and hire, this capability lets the agent discover and
 * hire talent mid-task. `action: "list"` returns the catalog (free GET);
 * `action: "run"` hires a skill by slug, signing ONE standard `exact` x402
 * USDC payment from the user wallet on Base (only on a successful run), and
 * returns the skill's output plus the USD paid.
 *
 * Both actions delegate to src/market/client.ts, the single payment path
 * shared with the command — see that file for the x402 details.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { fetchCatalog, runMarketSkill, fmtUsd, type MarketSkill } from '../market/client.js';
import { recordUsage } from '../stats/tracker.js';
import { frameUntrusted } from './untrusted.js';
import { logger } from '../logger.js';

interface AgentTalentInput {
  action?: string;
  query?: string;
  slug?: string;
  input?: string;
  limit?: number;
}

// A model-facing line per skill: enough to choose, not a wall of text.
function listLine(s: MarketSkill): string {
  const type = s.execution_type === 'agent' && s.data_sources?.length
    ? `live-data(${s.data_sources.join(',')})`
    : s.execution_type;
  const sample = s.sample_input ? ` | e.g. ${JSON.stringify(s.sample_input)}` : '';
  const by = s.creator?.x ? ` | by @${s.creator.x}` : '';
  return `- ${s.slug} — ${s.name} [${type}] ${fmtUsd(s.price_usd)}/run${by}\n  ${s.description}${sample}`;
}

export const agentTalentCapability: CapabilityHandler = {
  spec: {
    name: 'agent_talent',
    description:
      'Browse and hire paid AI skills ("talents") from the BlockRun agent marketplace — specialized agents other creators published. ' +
      'action="list" returns the catalog for free. Use it whenever the user asks you to find, search, browse, or recommend an agent / skill / talent for some domain or task (pass their topic as `query`), OR when you yourself need talent for a sub-task you cannot do well (live market/on-chain data, a domain-specific analysis, a niche transform). ' +
      '`query` filters by name, description, and data source; the match is semantic on your part — map the user\'s intent (e.g. "track gas prices" -> "gas", a request in any language) to a sensible keyword. Omit `query` to list the most popular. ' +
      'action="run" hires one skill by `slug` with your `input`: it signs ONE standard USDC x402 payment from the user wallet on Base and returns the skill\'s output. ' +
      'The wallet is charged automatically and ONLY on a successful run (the response reports the USD paid); a failed run is free. ' +
      'Prefer listing first to get the exact slug and price before running.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'run'],
          description: '"list" to browse/search the catalog (free); "run" to hire a skill (paid).',
        },
        query: {
          type: 'string',
          description: 'For list: optional keyword filter over name, description, and data sources.',
        },
        slug: {
          type: 'string',
          description: 'For run: the skill slug to hire (get it from list).',
        },
        input: {
          type: 'string',
          description: 'For run: the input text to send the skill.',
        },
        limit: {
          type: 'number',
          description: 'For list: max skills to return (default 20, max 200).',
        },
      },
      required: ['action'],
    },
  },
  // list is a free read; run signs a payment. Only the read is parallel-safe.
  isConcurrentSafe: (input) => (input as AgentTalentInput).action === 'list',

  async execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
    const raw = input as AgentTalentInput;
    const action = typeof raw.action === 'string' ? raw.action.toLowerCase() : '';

    if (action === 'list') {
      try {
        const limit = Math.min(Math.max(typeof raw.limit === 'number' ? raw.limit : 20, 1), 200);
        const skills = await fetchCatalog({
          limit,
          query: typeof raw.query === 'string' ? raw.query : undefined,
          signal: ctx.abortSignal,
        });
        if (skills.length === 0) {
          return { output: raw.query ? `No marketplace skills match "${raw.query}".` : 'The marketplace has no runnable skills right now.' };
        }
        const head = raw.query
          ? `BlockRun agent talents — ${skills.length} skill(s) matching "${raw.query}":`
          : `BlockRun agent talents — ${skills.length} skill(s):`;
        const body = frameUntrusted('BlockRun marketplace catalog (untrusted, creator-authored)', skills.map(listLine).join('\n'));
        const out = `${head}\n${body}\n\nTo hire one: agent_talent { action: "run", slug: "<slug>", input: "<input>" }.`;
        return { output: out, fullOutput: out };
      } catch (err) {
        return { output: `Could not reach the marketplace: ${(err as Error).message}`, isError: true };
      }
    }

    if (action === 'run') {
      const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
      const userInput = typeof raw.input === 'string' ? raw.input : '';
      if (!slug) return { output: 'Error: `slug` is required for action="run" (list first to find it).', isError: true };
      if (!userInput.trim()) return { output: 'Error: `input` is required for action="run".', isError: true };

      const outcome = await runMarketSkill(slug, userInput, { signal: ctx.abortSignal });

      try {
        recordUsage(`agent_talent:${slug}`, 0, 0, outcome.paidUsd, 0);
      } catch { /* best-effort telemetry */ }

      if (!outcome.ok) {
        logger.warn(`[franklin] agent_talent run ${slug} failed (${outcome.status}): ${outcome.error}`);
        return {
          output: `Hiring "${slug}" failed: ${outcome.error ?? `HTTP ${outcome.status}`}. No charge (the marketplace settles only on success).`,
          isError: true,
        };
      }

      const receipt = `Hired ${slug} — paid ${fmtUsd(outcome.paidUsd)}${outcome.txHash ? ` (tx ${outcome.txHash.slice(0, 10)}…)` : ''}`;
      const out = `${receipt}\n\n${frameUntrusted('BlockRun marketplace skill output (untrusted, third-party)', outcome.result ?? '')}`;
      return { output: out, fullOutput: out };
    }

    return { output: `Error: unknown action "${raw.action}". Use "list" or "run".`, isError: true };
  },
};
