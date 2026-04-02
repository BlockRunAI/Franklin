/**
 * Task capability — in-session task tracking for the agent.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

interface TaskEntry {
  id: number;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  description?: string;
}

// In-memory task store (per session)
const tasks: TaskEntry[] = [];
let nextId = 1;

interface TaskInput {
  action: 'create' | 'update' | 'list';
  subject?: string;
  description?: string;
  task_id?: number;
  status?: 'pending' | 'in_progress' | 'completed';
}

async function execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
  const { action, subject, description, task_id, status } = input as unknown as TaskInput;

  switch (action) {
    case 'create': {
      if (!subject) {
        return { output: 'Error: subject is required for create', isError: true };
      }
      const task: TaskEntry = {
        id: nextId++,
        subject,
        status: 'pending',
        description,
      };
      tasks.push(task);
      return { output: `Task #${task.id} created: ${task.subject}` };
    }

    case 'update': {
      if (!task_id) {
        return { output: 'Error: task_id is required for update', isError: true };
      }
      const task = tasks.find(t => t.id === task_id);
      if (!task) {
        return { output: `Error: task #${task_id} not found`, isError: true };
      }
      if (status) task.status = status;
      if (subject) task.subject = subject;
      if (description) task.description = description;
      return { output: `Task #${task.id} updated: ${task.status} — ${task.subject}` };
    }

    case 'list': {
      if (tasks.length === 0) {
        return { output: 'No tasks.' };
      }
      const lines = tasks.map(t => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
        return `${icon} #${t.id} [${t.status}] ${t.subject}`;
      });
      return { output: lines.join('\n') };
    }

    default:
      return { output: `Error: unknown action "${action}". Use create, update, or list.`, isError: true };
  }
}

export const taskCapability: CapabilityHandler = {
  spec: {
    name: 'Task',
    description: 'Manage in-session tasks. Actions: create (new task), update (change status), list (show all).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: "create", "update", or "list"',
        },
        subject: { type: 'string', description: 'Task title (for create/update)' },
        description: { type: 'string', description: 'Task description (for create/update)' },
        task_id: { type: 'number', description: 'Task ID (for update)' },
        status: {
          type: 'string',
          description: 'New status: "pending", "in_progress", or "completed" (for update)',
        },
      },
      required: ['action'],
    },
  },
  execute,
  concurrent: false,
};
