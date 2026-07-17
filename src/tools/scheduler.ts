/**
 * Scheduler capability — lets the model self-schedule recurring or one-shot
 * prompts ("check the BTC funding rate every hour and alert me on a flip").
 *
 * Firings are synthetic user inputs delivered at turn boundaries; every
 * fired prompt flows through the normal permission/hook/spend pipeline, so
 * self-scheduling grants no extra authority.
 */

import type { CapabilityHandler } from '../agent/types.js';
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
} from '../scheduler/store.js';
import { formatInterval, MIN_INTERVAL_SEC } from '../scheduler/types.js';

export function createSchedulerCapability(opts: { sessionId: () => string }): CapabilityHandler {
  return {
    spec: {
      name: 'Scheduler',
      description:
        'Schedule prompts to fire later as if the user typed them. Actions: ' +
        '"create" (needs prompt + interval_sec; optional recurring=true, durable=true, fire_immediately=false), ' +
        '"list", "delete" (needs task_id). Recurring tasks repeat every interval; one-shot tasks fire once. ' +
        'Durable tasks survive restarts and catch up a missed firing at the next session start. ' +
        `Minimum interval ${MIN_INTERVAL_SEC}s. Tasks auto-expire after 7 days. ` +
        'Use for periodic checks (prices, positions, feeds) instead of sleep-polling in Bash.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'delete'], description: 'Operation to perform.' },
          prompt: { type: 'string', description: 'create: the prompt to fire.' },
          interval_sec: { type: 'number', description: `create: seconds between firings (min ${MIN_INTERVAL_SEC}).` },
          recurring: { type: 'boolean', description: 'create: repeat every interval (default true). false = fire once.' },
          durable: { type: 'boolean', description: 'create: survive across sessions (default true).' },
          fire_immediately: { type: 'boolean', description: 'create: fire at the next turn boundary too (default false).' },
          task_id: { type: 'string', description: 'delete: id of the task to remove.' },
        },
        required: ['action'],
      },
    },
    concurrent: true,
    execute: async (input) => {
      const action = String(input.action || '');

      if (action === 'create') {
        const intervalSec = Number(input.interval_sec);
        if (!Number.isFinite(intervalSec)) {
          return { output: 'Error: interval_sec is required for create.', isError: true };
        }
        const result = createScheduledTask({
          prompt: String(input.prompt || ''),
          intervalSec,
          sessionId: opts.sessionId(),
          recurring: input.recurring !== false,
          durable: input.durable !== false,
          fireImmediately: input.fire_immediately === true,
        });
        if ('error' in result) return { output: `Error: ${result.error}`, isError: true };
        return {
          output:
            `Scheduled task ${result.id}: every ${formatInterval(result.intervalSec)}, ` +
            `${result.recurring ? 'recurring' : 'one-shot'}, ${result.durable ? 'durable' : 'session-only'}, ` +
            `next firing ${new Date(result.nextFireAt).toISOString()}, expires ${new Date(result.expiresAt).toISOString()}.`,
        };
      }

      if (action === 'list') {
        const tasks = listScheduledTasks();
        if (tasks.length === 0) return { output: 'No scheduled tasks.' };
        const lines = tasks.map(t =>
          `${t.id} · every ${formatInterval(t.intervalSec)} · ${t.recurring ? 'recurring' : 'one-shot'}` +
          `${t.durable ? '' : ' · session-only'} · fired ${t.firedCount}× · next ${new Date(t.nextFireAt).toISOString()}` +
          `\n  ${t.prompt.slice(0, 140)}`
        );
        return { output: `${tasks.length} scheduled task(s):\n${lines.join('\n')}` };
      }

      if (action === 'delete') {
        const id = String(input.task_id || '');
        if (!id) return { output: 'Error: task_id is required for delete.', isError: true };
        return deleteScheduledTask(id)
          ? { output: `Deleted scheduled task ${id}.` }
          : { output: `No scheduled task ${id}.`, isError: true };
      }

      return { output: `Unknown action "${action}". Use create, list, or delete.`, isError: true };
    },
  };
}
