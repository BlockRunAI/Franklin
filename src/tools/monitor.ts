/**
 * Monitor capability — watch a long-running command and receive its output
 * as conversation events at turn boundaries.
 *
 * Built on the detached-task substrate: the command runs as a background
 * task (survives turn ends), and the monitor registry sweeps its log at
 * each turn boundary, delivering fresh lines as a [monitor: <label>] block
 * in the next turn. Flooding monitors auto-pause (volume cutoff).
 */

import type { CapabilityHandler } from '../agent/types.js';
import { startDetachedTask } from '../tasks/spawn.js';
import { readTaskMeta } from '../tasks/store.js';
import {
  listMonitors,
  registerMonitor,
  removeMonitor,
  getMonitor,
  MAX_EVENTS_PER_SESSION,
  MAX_LINES_PER_SWEEP,
} from '../monitors/registry.js';

export function createMonitorCapability(): CapabilityHandler {
  return {
    spec: {
      name: 'Monitor',
      description:
        'Watch a long-running shell command; each new stdout/stderr line is delivered to you ' +
        'at the next turn boundary as a [monitor] block — you can keep working meanwhile. ' +
        'Actions: "start" (needs command + description; optional pattern regex to filter lines), ' +
        '"stop" (needs monitor_id), "list". ' +
        'Use for price feeds, position watchers, log tails, or slow jobs — never sleep-poll in Bash. ' +
        `Filter aggressively: a monitor is auto-paused after ${MAX_LINES_PER_SWEEP} lines in one sweep ` +
        `or ${MAX_EVENTS_PER_SESSION} lines per session. In shell pipelines use grep --line-buffered ` +
        'so lines flush promptly.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'list'], description: 'Operation to perform.' },
          command: { type: 'string', description: 'start: shell command to run and watch.' },
          description: { type: 'string', description: 'start: short label shown on delivered blocks (3-6 words).' },
          pattern: { type: 'string', description: 'start: optional regex — only matching lines are delivered.' },
          monitor_id: { type: 'string', description: 'stop: id returned by start.' },
        },
        required: ['action'],
      },
    },
    concurrent: true,
    execute: async (input, ctx) => {
      const action = String(input.action || '');

      if (action === 'start') {
        const command = String(input.command || '').trim();
        const label = String(input.description || '').trim() || command.slice(0, 40);
        if (!command) return { output: 'Error: command is required for start.', isError: true };

        let pattern: RegExp | undefined;
        if (typeof input.pattern === 'string' && input.pattern.length > 0) {
          try {
            pattern = new RegExp(input.pattern);
          } catch (err) {
            return { output: `Error: invalid pattern regex: ${(err as Error).message}`, isError: true };
          }
        }

        const runId = startDetachedTask({
          label: `monitor: ${label}`,
          command,
          workingDir: ctx.workingDir,
        });
        registerMonitor({ taskRunId: runId, label, pattern });
        return {
          output:
            `Monitor ${runId} started: "${label}". New${pattern ? ' matching' : ''} output lines will arrive ` +
            'as [monitor] blocks at turn boundaries. Stop it with action "stop" when no longer needed.',
        };
      }

      if (action === 'stop') {
        const id = String(input.monitor_id || '');
        if (!id) return { output: 'Error: monitor_id is required for stop.', isError: true };
        const entry = getMonitor(id);
        if (!entry) return { output: `No active monitor ${id}.`, isError: true };
        removeMonitor(id);
        // Best-effort terminate the underlying task process.
        const meta = readTaskMeta(id);
        if (meta?.pid) {
          try {
            process.kill(meta.pid, 'SIGTERM');
          } catch {
            /* already gone */
          }
        }
        return { output: `Monitor ${id} ("${entry.label}") stopped.` };
      }

      if (action === 'list') {
        const entries = listMonitors();
        if (entries.length === 0) return { output: 'No active monitors.' };
        const lines = entries.map(e =>
          `${e.taskRunId} · "${e.label}" · ${e.eventsDelivered} lines delivered` +
          `${e.pattern ? ` · filter /${e.pattern.source}/` : ''}${e.paused ? ` · PAUSED (${e.pausedReason})` : ''}`
        );
        return { output: `${entries.length} monitor(s):\n${lines.join('\n')}` };
      }

      return { output: `Unknown action "${action}". Use start, stop, or list.`, isError: true };
    },
  };
}
