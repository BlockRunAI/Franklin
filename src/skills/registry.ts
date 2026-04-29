/**
 * Skill registry — resolves name conflicts across sources and exposes
 * lookup, list, and shadow-set queries for `/help` and
 * `franklin skills list`.
 *
 * Precedence: project > user > bundled. Within the same source, the first
 * loaded skill wins so that the order returned by the loader (which is
 * filesystem-ordered) is the deterministic tiebreaker the user can rely on.
 *
 * Built-in slash commands (e.g. `/security`) take precedence over skills
 * with the same name, but that check happens at the dispatch layer in
 * `src/agent/commands.ts`. The registry never sees the built-in list.
 */

import type { LoadedSkill, SkillSource } from './types.js';

const SOURCE_PRIORITY: Record<SkillSource, number> = {
  project: 3,
  user: 2,
  bundled: 1,
};

export interface ShadowEntry {
  winner: LoadedSkill;
  loser: LoadedSkill;
}

export class Registry {
  private readonly byName: Map<string, LoadedSkill> = new Map();
  private readonly shadows: ShadowEntry[] = [];

  static fromLoaded(loaded: LoadedSkill[]): Registry {
    const reg = new Registry();

    // Stable sort by source priority (desc); ties broken by original order
    // so that within a single source, the first-loaded skill wins.
    const indexed = loaded.map((l, i) => ({ l, i }));
    indexed.sort((a, b) => {
      const pa = SOURCE_PRIORITY[a.l.source];
      const pb = SOURCE_PRIORITY[b.l.source];
      if (pa !== pb) return pb - pa;
      return a.i - b.i;
    });

    for (const { l } of indexed) {
      const existing = reg.byName.get(l.skill.name);
      if (!existing) {
        reg.byName.set(l.skill.name, l);
      } else {
        reg.shadows.push({ winner: existing, loser: l });
      }
    }

    return reg;
  }

  lookup(name: string): LoadedSkill | undefined {
    return this.byName.get(name);
  }

  list(): LoadedSkill[] {
    return [...this.byName.values()].sort((a, b) =>
      a.skill.name.localeCompare(b.skill.name),
    );
  }

  shadowed(): ShadowEntry[] {
    return [...this.shadows];
  }
}
