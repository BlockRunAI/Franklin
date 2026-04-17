/**
 * Agent-facing Content capabilities. Four tools, deliberately mirroring the
 * Trading vertical's shape:
 *
 *   ContentCreate     — start a new piece with type/title/budgetUsd
 *   ContentAddAsset   — record a generated asset (image/audio/etc.) with its
 *                       cost; rejected (as normal text, not an error) if it
 *                       would breach the per-piece budget
 *   ContentShow       — dump a single piece's state as actionable markdown
 *   ContentList       — summary of every piece, newest first
 *
 * This is the surface Claude Code and Cursor cannot cover: durable content
 * state with autonomous spending gating. An agent can spin up "Franklin
 * launch thread" with a $3 budget, hit DALL-E twice for hero images, blow
 * the budget, read the refusal, pick a cheaper model, and continue — all
 * without human intervention and with the project surviving to the next
 * session.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import type {
  AssetKind,
  Content,
  ContentLibrary,
  ContentType,
} from '../content/library.js';

const VALID_TYPES: readonly ContentType[] = [
  'x-thread', 'blog', 'podcast', 'video', 'ad-copy', 'image',
];
const VALID_ASSET_KINDS: readonly AssetKind[] = ['image', 'audio', 'video', 'text'];

export interface ContentCapabilitiesDeps {
  library: ContentLibrary;
  /** Invoked after mutating calls so callers can persist to disk. */
  onStateChange?: () => void | Promise<void>;
}

function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatAssetLine(a: Content['assets'][number]): string {
  const when = new Date(a.createdAt).toISOString().replace('T', ' ').slice(0, 16);
  const data = a.data ? ` · ${a.data}` : '';
  return `- ${when}  ${a.kind} via ${a.source} (${formatUsd(a.costUsd)})${data}`;
}

function formatContent(c: Content): string {
  const lines: string[] = [];
  lines.push(`## ${c.title}`);
  lines.push(`- id: \`${c.id}\``);
  lines.push(`- type: ${c.type}   status: ${c.status}`);
  lines.push(`- budget: ${formatUsd(c.spentUsd)} spent / ${formatUsd(c.budgetUsd)} cap`);
  lines.push(`- drafts: ${c.drafts.length}   assets: ${c.assets.length}`);
  if (c.publishedAt) {
    lines.push(`- published: ${new Date(c.publishedAt).toISOString()}`);
  }
  if (c.assets.length > 0) {
    lines.push('');
    lines.push('### Assets');
    for (const a of c.assets) lines.push(formatAssetLine(a));
  }
  return lines.join('\n');
}

export function createContentCapabilities(
  deps: ContentCapabilitiesDeps,
): CapabilityHandler[] {
  const { library, onStateChange } = deps;

  const contentCreate: CapabilityHandler = {
    spec: {
      name: 'ContentCreate',
      description:
        'Start a new content piece with a budget. The piece is durable across ' +
        'sessions. Use types: x-thread, blog, podcast, video, ad-copy, image. ' +
        'Budget is a hard USD cap on asset spending for this piece.',
      input_schema: {
        type: 'object',
        required: ['type', 'title', 'budgetUsd'],
        properties: {
          type: { type: 'string', description: 'Content kind (x-thread, blog, podcast, video, ad-copy, image)' },
          title: { type: 'string', description: 'Human-readable title' },
          budgetUsd: { type: 'number', description: 'Hard USD spending cap for asset generation' },
        },
        additionalProperties: false,
      },
    },
    concurrent: false,
    async execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
      const rawType = String(input.type ?? '');
      const title = String(input.title ?? '').trim();
      const budgetUsd = Number(input.budgetUsd);

      if (!VALID_TYPES.includes(rawType as ContentType)) {
        return {
          output: `Error: type must be one of ${VALID_TYPES.join(', ')}. Got "${rawType}".`,
          isError: true,
        };
      }
      if (!title) {
        return { output: 'Error: title is required.', isError: true };
      }
      if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
        return { output: 'Error: budgetUsd must be a non-negative number.', isError: true };
      }

      const c = library.create({ type: rawType as ContentType, title, budgetUsd });
      if (onStateChange) await onStateChange();
      return {
        output:
          `## Content created\n` +
          `- id: \`${c.id}\`\n` +
          `- title: ${c.title}\n` +
          `- type: ${c.type}\n` +
          `- budget: ${formatUsd(c.budgetUsd)} (spent ${formatUsd(c.spentUsd)})\n` +
          `- status: ${c.status}\n\n` +
          `Use this id with ContentAddAsset / ContentShow.`,
      };
    },
  };

  const contentAddAsset: CapabilityHandler = {
    spec: {
      name: 'ContentAddAsset',
      description:
        'Record a generated asset (image, audio, video, or text) against a ' +
        'content piece, debiting its budget. If the asset would exceed the ' +
        'budget cap the call is refused and returned as a normal text result ' +
        '— not an error — so the agent can read the refusal and try a cheaper ' +
        'model. Cost must reflect what was actually spent (zero for free ' +
        'models, positive for paid).',
      input_schema: {
        type: 'object',
        required: ['id', 'kind', 'source', 'costUsd'],
        properties: {
          id: { type: 'string', description: 'Content id returned by ContentCreate' },
          kind: { type: 'string', description: 'image, audio, video, or text' },
          source: { type: 'string', description: 'Generator model or "manual" (e.g. "openai/dall-e-3")' },
          costUsd: { type: 'number', description: 'Actual USD spent producing this asset' },
          data: { type: 'string', description: 'Optional URL or inline text reference to the asset' },
        },
        additionalProperties: false,
      },
    },
    concurrent: false,
    async execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
      const id = String(input.id ?? '').trim();
      const kind = String(input.kind ?? '') as AssetKind;
      const source = String(input.source ?? '').trim();
      const costUsd = Number(input.costUsd);
      const data = input.data == null ? undefined : String(input.data);

      if (!id) return { output: 'Error: id is required.', isError: true };
      if (!VALID_ASSET_KINDS.includes(kind)) {
        return {
          output: `Error: kind must be one of ${VALID_ASSET_KINDS.join(', ')}. Got "${kind}".`,
          isError: true,
        };
      }
      if (!source) return { output: 'Error: source is required.', isError: true };
      if (!Number.isFinite(costUsd) || costUsd < 0) {
        return { output: 'Error: costUsd must be a non-negative number.', isError: true };
      }

      const decision = library.addAsset(id, { kind, source, costUsd, data });
      if (!decision.ok) {
        // Normal text: the agent should read this and adapt, not retry.
        return { output: `## Asset rejected\n- ${decision.reason}` };
      }

      if (onStateChange) await onStateChange();
      const c = library.get(id)!;
      return {
        output:
          `## Asset recorded\n` +
          `- ${kind} via ${source}: ${formatUsd(costUsd)}\n` +
          `- Spent so far: ${formatUsd(c.spentUsd)} / ${formatUsd(c.budgetUsd)} cap\n` +
          `- Remaining: ${formatUsd(c.budgetUsd - c.spentUsd)}`,
      };
    },
  };

  const contentShow: CapabilityHandler = {
    spec: {
      name: 'ContentShow',
      description:
        'Dump a single content piece\'s full state as markdown: title, budget, ' +
        'assets, drafts, distribution, status. Use before deciding the next step ' +
        'on a piece (another asset, draft revision, publish).',
      input_schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Content id' },
        },
        additionalProperties: false,
      },
    },
    concurrent: true,
    async execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
      const id = String(input.id ?? '').trim();
      if (!id) return { output: 'Error: id is required.', isError: true };
      const c = library.get(id);
      if (!c) return { output: `No content with id ${id}.` };
      return { output: formatContent(c) };
    },
  };

  const contentList: CapabilityHandler = {
    spec: {
      name: 'ContentList',
      description:
        'List every content piece in the library (newest first) with its title, ' +
        'status, and budget utilization. No inputs.',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    concurrent: true,
    async execute(_input, _ctx: ExecutionScope): Promise<CapabilityResult> {
      const contents = library.list();
      if (contents.length === 0) {
        return { output: '_No content pieces yet. Use ContentCreate to start one._' };
      }
      const lines = ['## Content library', ''];
      for (const c of contents) {
        const pct = c.budgetUsd > 0 ? (c.spentUsd / c.budgetUsd) * 100 : 0;
        lines.push(
          `- \`${c.id}\` · **${c.title}** · ${c.type}/${c.status} · ` +
          `${formatUsd(c.spentUsd)} / ${formatUsd(c.budgetUsd)} (${pct.toFixed(0)}%) ` +
          `· ${c.assets.length} assets`,
        );
      }
      return { output: lines.join('\n') };
    },
  };

  return [contentCreate, contentAddAsset, contentShow, contentList];
}
