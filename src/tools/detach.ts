/**
 * Detach capability — start a detached background Bash command.
 *
 * Returns immediately with a runId. The command continues even if Franklin
 * exits or the user closes their terminal. Manage running tasks with
 * `franklin task list / tail / wait / cancel`.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { startDetachedTask } from '../tasks/spawn.js';

interface DetachInput {
  label: string;
  command: string;
}

async function execute(
  input: Record<string, unknown>,
  ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const { label, command } = input as unknown as DetachInput;
  if (typeof label !== 'string' || label.length === 0) {
    return { output: 'Error: label is required (non-empty string)', isError: true };
  }
  if (typeof command !== 'string' || command.length === 0) {
    return { output: 'Error: command is required (non-empty string)', isError: true };
  }
  const runId = startDetachedTask({ label, command, workingDir: ctx.workingDir });
  return {
    output:
      `Detached task started.\n` +
      `runId: ${runId}\n` +
      `label: ${label}\n` +
      `command: ${command}\n\n` +
      `Inspect with:\n` +
      `  franklin task tail ${runId}              # non-blocking status snapshot — safe inside Bash\n` +
      `  franklin task wait ${runId} --timeout-s 600   # block up to 10min; pair with Bash timeout >= same\n` +
      `  franklin task cancel ${runId}\n` +
      `\n` +
      `WARNING: do NOT call \`franklin task tail ${runId} --follow\` from a Bash tool — \`--follow\`\n` +
      `blocks until the task reaches a terminal state, which routinely outlasts the Bash tool's\n` +
      `default 2-minute timeout and gives you "command killed". Use \`franklin task tail <runId>\`\n` +
      `(no flag) for non-blocking status, or \`franklin task wait\` with explicit \`--timeout-s\` plus\n` +
      `a matching Bash \`timeout\`.\n`,
  };
}

export const detachCapability: CapabilityHandler = {
  spec: {
    name: 'Detach',
    description:
      "Run a Bash command as a detached background job. Returns immediately " +
      "with a runId. The command continues even if Franklin exits or the user " +
      "closes their terminal. Use this for any iteration over more than ~20 " +
      "items, large data fetches, paginated API loops, polling external async " +
      "jobs (waiting for an Apify run / video generation / deploy / build to " +
      "complete), or anything you'd otherwise loop on turn-by-turn (which " +
      "would burn turns and trip timeouts). The agent's job is to design and " +
      "orchestrate, not to be the for-loop. Pair with a script that writes a " +
      "checkpoint file so progress survives restarts. Inspect with " +
      "`franklin task tail <runId>` (NON-blocking snapshot — safe inside " +
      "Bash) — DO NOT use `--follow` from a Bash tool, it blocks until the " +
      "task is done and will trip the Bash timeout. Block-until-done belongs " +
      "in `franklin task wait <runId> --timeout-s N` paired with a matching " +
      "Bash `timeout` parameter. ALWAYS prefer Detach over a single " +
      "foreground Bash call with `sleep` inside a for/while/until loop — that " +
      "antipattern blocks the agent for the full duration and looks frozen.",
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short human-readable label, e.g. "scrape stargazers"' },
        command: { type: 'string', description: 'Bash command to run. Will be executed via `bash -lc`.' },
      },
      required: ['label', 'command'],
    },
  },
  execute,
  concurrent: true,
};
