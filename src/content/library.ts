/**
 * ContentLibrary — persistent, cross-session state for content generation work.
 *
 * Mirrors the Trading vertical: Library is the state object, Budget is the
 * risk engine, store.ts is the persistence adapter, and tools/content-execute.ts
 * wires everything into agent-facing capabilities.
 *
 * Why this exists: Claude Code / Cursor cannot carry a content project across
 * sessions. If you start drafting a podcast episode Monday and come back
 * Wednesday, there's no concept of *the same* piece of work. Franklin tracks
 * outline → drafts → assets → distribution as one durable object and lets
 * the agent spend USDC (image generation, audio, stock footage) against a
 * budget that survives session boundaries.
 */
import { randomUUID } from 'node:crypto';

export type ContentType =
  | 'x-thread'
  | 'blog'
  | 'podcast'
  | 'video'
  | 'ad-copy'
  | 'image';

export type ContentStatus =
  | 'outline'
  | 'drafting'
  | 'assets'
  | 'review'
  | 'published';

export type AssetKind = 'image' | 'audio' | 'video' | 'text';

export interface ContentAsset {
  kind: AssetKind;
  /** Producer of the asset: model ID like "openai/dall-e-3", or "manual". */
  source: string;
  /** USD actually spent producing this asset. 0 is valid (free models). */
  costUsd: number;
  /** Optional payload reference — URL, file path, or short inline text. */
  data?: string;
  createdAt: number;
}

export interface ContentDraft {
  text: string;
  createdAt: number;
}

export interface DistributionEntry {
  channel: string; // "x", "substack", "linkedin", ...
  url?: string;
  at: number;
}

export interface Content {
  id: string;
  type: ContentType;
  title: string;
  status: ContentStatus;
  outline?: string;
  drafts: ContentDraft[];
  assets: ContentAsset[];
  spentUsd: number;
  budgetUsd: number;
  createdAt: number;
  publishedAt?: number;
  distribution: DistributionEntry[];
}

export interface CreateContentOptions {
  type: ContentType;
  title: string;
  budgetUsd: number;
}

export class ContentLibrary {
  private byId = new Map<string, Content>();

  create(opts: CreateContentOptions): Content {
    if (opts.budgetUsd < 0) {
      throw new Error('budgetUsd must be non-negative');
    }
    const now = Date.now();
    const content: Content = {
      id: randomUUID(),
      type: opts.type,
      title: opts.title,
      status: 'outline',
      drafts: [],
      assets: [],
      spentUsd: 0,
      budgetUsd: opts.budgetUsd,
      createdAt: now,
      distribution: [],
    };
    this.byId.set(content.id, content);
    return content;
  }

  get(id: string): Content | undefined {
    return this.byId.get(id);
  }

  list(): Content[] {
    return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Replace a content record wholesale — used by the persistence layer. */
  restore(content: Content): void {
    this.byId.set(content.id, content);
  }

  /**
   * Record a generated asset against a content, enforcing the budget cap.
   * Returns `{ ok: false, reason }` on rejection so callers (including the
   * agent-facing capability) can surface the reason instead of catching an
   * exception. On the happy path mutates the Content in place and returns
   * the updated spendUsd.
   */
  addAsset(
    id: string,
    asset: Omit<ContentAsset, 'createdAt'>,
  ): { ok: true; spentUsd: number } | { ok: false; reason: string } {
    const content = this.byId.get(id);
    if (!content) {
      return { ok: false, reason: `Content ${id} not found` };
    }
    if (asset.costUsd < 0) {
      return { ok: false, reason: 'costUsd must be non-negative' };
    }
    const projected = content.spentUsd + asset.costUsd;
    if (projected > content.budgetUsd + 1e-9) {
      return {
        ok: false,
        reason:
          `Exceeds budget: spent $${content.spentUsd.toFixed(2)} + proposed ` +
          `$${asset.costUsd.toFixed(2)} > cap $${content.budgetUsd.toFixed(2)}`,
      };
    }
    content.assets.push({ ...asset, createdAt: Date.now() });
    content.spentUsd = projected;
    return { ok: true, spentUsd: projected };
  }
}
