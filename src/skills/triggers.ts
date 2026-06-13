/**
 * Trigger-based skill auto-invoke.
 *
 * A skill may declare a list of trigger phrases in its frontmatter. When the
 * user message contains one of those phrases, the agent can:
 *   - inject the skill body as additional context for this turn (`mode: hint`)
 *   - rewrite the user message through the skill's prompt (`mode: replace`)
 *
 * We default to `hint` because it is non-destructive: the user's literal
 * intent is preserved and the skill body becomes a guidance block the model
 * can choose to follow. `replace` is reserved for skills that explicitly
 * opt-in via a frontmatter flag (not yet wired — future extension).
 *
 * Anti-spam guard:
 *   - skills with `disableModelInvocation: true` never auto-invoke
 *   - scoring must clear a non-trivial threshold (≥4) to avoid one-word
 *     coincidences ("buy" / "long") firing trade-signal in random chatter
 *   - longer trigger phrases score higher; multi-token matches score more
 *     than single-word matches
 */

import type { LoadedSkill } from './types.js';

const SCORE_THRESHOLD = 4;
const MAX_MATCHES = 3;

export interface SkillMatch {
  skill: LoadedSkill;
  score: number;
  triggers: string[];
}

export function matchSkillTriggers(input: string, skills: LoadedSkill[]): SkillMatch[] {
  if (!input || skills.length === 0) return [];
  const lower = input.toLowerCase();
  const out: SkillMatch[] = [];

  for (const loaded of skills) {
    const skill = loaded.skill;
    if (skill.disableModelInvocation) continue;
    const triggers = skill.triggers ?? [];
    if (triggers.length === 0) continue;

    let score = 0;
    const matched: string[] = [];
    for (const raw of triggers) {
      const t = raw.toLowerCase().trim();
      if (!t) continue;
      if (!lower.includes(t)) continue;
      // Multi-token phrases score 3, single tokens score 1 — keeps short
      // generic verbs from being decisive while making rich phrases land.
      const weight = t.includes(' ') ? 3 : 1;
      score += weight;
      matched.push(raw);
    }
    if (lower.includes(skill.name.toLowerCase())) {
      score += 3; // explicit name mention is a strong signal
    }
    // Slight preference for skills the user has used before.
    if (skill.uses && skill.uses > 0) {
      score += Math.min(skill.uses * 0.5, 2);
    }
    if (score >= SCORE_THRESHOLD) {
      out.push({ skill: loaded, score, triggers: matched });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_MATCHES);
}

/**
 * Format a matched-skills hint block to append to the system prompt for a
 * single turn. Reads as a soft suggestion to the model — not a rewrite.
 */
export function formatSkillHints(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';
  const blocks: string[] = ['# Skill hints', 'The user message matches these skill triggers — if relevant, follow the skill\'s procedure:'];
  for (const m of matches) {
    const skill = m.skill.skill;
    const triggers = m.triggers.length > 0 ? ` (matched: ${m.triggers.slice(0, 3).join(', ')})` : '';
    blocks.push('');
    blocks.push(`## /${skill.name}${triggers}`);
    blocks.push(skill.description);
    blocks.push('');
    blocks.push(skill.body.trim());
  }
  return blocks.join('\n');
}
