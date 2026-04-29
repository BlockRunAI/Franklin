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
