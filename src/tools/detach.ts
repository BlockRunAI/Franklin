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
      `  franklin task tail ${runId} --follow\n` +
      `  franklin task wait ${runId}\n` +
      `  franklin task cancel ${runId}\n`,
  };
}

export const detachCapability: CapabilityHandler = {
  spec: {
    name: 'Detach',
    description:
      "Run a Bash command as a detached background job. Returns immediately " +
      "with a runId. The command continues even if Franklin exits or the user " +
      "closes their terminal. Use this for any iteration over more than ~20 " +
      "items, large data fetches, paginated API loops, or anything you'd " +
      "otherwise loop on turn-by-turn (which would burn turns and trip " +
      "timeouts). The agent's job is to design and orchestrate, not to be " +
      "the for-loop. Pair with a script that writes a checkpoint file so " +
      "progress survives restarts. Tail logs with `franklin task tail " +
      "<runId> --follow` and check completion with `franklin task wait " +
      "<runId>`.",
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
