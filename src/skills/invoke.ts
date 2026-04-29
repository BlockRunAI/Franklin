/**
 * Skill invocation helpers.
 *
 * `substituteVariables` is the only piece of the invocation path that runs
 * for every skill: it inlines `{{wallet_balance}}` and similar runtime
 * context, then expands `$ARGUMENTS` to the trailing slash-command argument.
 *
 * Both substitutions use function-form replacement so that values containing
 * `$` or other replacement-pattern meta-characters (like a user task that
 * mentions "find $5 of value") are inserted verbatim.
 */

const VAR_PATTERN = /\{\{(\w+)\}\}/g;

export function substituteVariables(
  body: string,
  vars: Record<string, string>,
  args: string,
): string {
  const withVars = body.replace(VAR_PATTERN, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
  return withVars.replaceAll('$ARGUMENTS', () => args);
}

import type { Registry } from './registry.js';

export interface SkillMatch {
  rewritten: string;
}

/**
 * Pure dispatch: given a slash-command input line, look up the skill in the
 * registry, render its body against runtime variables and arguments, and
 * return the prompt the agent should run. Returns null when the input is
 * not a slash command, the slash is bare, or no skill of that name exists.
 */
export function matchSkill(
  input: string,
  registry: Registry,
  vars: Record<string, string>,
): SkillMatch | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = (space < 0 ? input : input.slice(0, space)).slice(1);
  if (name.length === 0) return null;
  const skill = registry.lookup(name);
  if (!skill) return null;

  const args = space < 0 ? '' : input.slice(space + 1).trim();
  const rewritten = substituteVariables(skill.skill.body, vars, args);
  return { rewritten };
}
