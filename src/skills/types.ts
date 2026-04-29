/**
 * Public types for Franklin's skills layer.
 *
 * A "skill" is an Anthropic-spec SKILL.md file: YAML frontmatter + a markdown
 * body that becomes the prompt-rewrite for a slash command. See
 * docs/plans/2026-04-29-franklin-skills-mvp-design.md.
 */

export type SkillSource = 'bundled' | 'user' | 'project';

export interface ParsedSkill {
  /** Kebab-case skill identifier; matches the parent directory name. */
  name: string;
  /** Short description shown in /help and franklin skills list. */
  description: string;
  /** Raw markdown body (not yet variable-substituted). */
  body: string;
  /** Anthropic spec: hint shown after the slash command. */
  argumentHint?: string;
  /** Anthropic spec: when true, the model must not auto-invoke this skill. */
  disableModelInvocation?: boolean;
  /** Franklin extension: hard cap (USD) for the turn this skill kicks off. */
  budgetCapUsd?: number;
  /** Franklin extension: append a paid-call receipt under the agent reply. */
  costReceipt?: boolean;
}

export type ParseResult =
  | { skill: ParsedSkill; warnings: string[] }
  | { error: string };

export interface LoadedSkill {
  skill: ParsedSkill;
  source: SkillSource;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Non-fatal warnings raised while loading this skill. */
  warnings: string[];
}

export interface LoadError {
  /** Absolute path to the file that failed. */
  path: string;
  error: string;
}

export interface LoadResult {
  skills: LoadedSkill[];
  errors: LoadError[];
}
