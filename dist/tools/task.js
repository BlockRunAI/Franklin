/**
 * Task capability — in-session task tracking for the agent.
 */
// In-memory task store (per session)
const tasks = [];
let nextId = 1;
async function execute(input, _ctx) {
    const { action, subject, description, activeForm, task_id, status, addBlocks, addBlockedBy } = input;
    switch (action) {
        case 'create': {
            if (!subject) {
                return { output: 'Error: subject is required for create', isError: true };
            }
            const task = {
                id: nextId++,
                subject,
                status: 'pending',
                description,
                activeForm,
                blocks: [],
                blockedBy: [],
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
            if (status)
                task.status = status;
            if (subject)
                task.subject = subject;
            if (description)
                task.description = description;
            if (activeForm)
                task.activeForm = activeForm;
            // Dependency management
            if (addBlocks) {
                for (const blockedId of addBlocks) {
                    if (!task.blocks.includes(blockedId))
                        task.blocks.push(blockedId);
                    const blocked = tasks.find(t => t.id === blockedId);
                    if (blocked && !blocked.blockedBy.includes(task.id))
                        blocked.blockedBy.push(task.id);
                }
            }
            if (addBlockedBy) {
                for (const blockerId of addBlockedBy) {
                    if (!task.blockedBy.includes(blockerId))
                        task.blockedBy.push(blockerId);
                    const blocker = tasks.find(t => t.id === blockerId);
                    if (blocker && !blocker.blocks.includes(task.id))
                        blocker.blocks.push(task.id);
                }
            }
            // Rich feedback: show status transition and dependency impact
            let feedback = `Updated task #${task.id}`;
            if (status) {
                feedback += ` → ${status}`;
                // If completed, show which tasks are now unblocked
                if (status === 'completed' && task.blocks.length > 0) {
                    const nowUnblocked = task.blocks
                        .map(id => tasks.find(t => t.id === id))
                        .filter(t => t && t.blockedBy.every(bid => {
                        const blocker = tasks.find(bt => bt.id === bid);
                        return blocker?.status === 'completed';
                    }))
                        .map(t => `#${t.id} ${t.subject}`);
                    if (nowUnblocked.length > 0) {
                        feedback += ` — unblocked: ${nowUnblocked.join(', ')}`;
                    }
                }
            }
            return { output: feedback };
        }
        case 'list': {
            if (tasks.length === 0) {
                return { output: 'No tasks.' };
            }
            const pending = tasks.filter(t => t.status !== 'completed').length;
            const done = tasks.filter(t => t.status === 'completed').length;
            const lines = tasks.map(t => {
                const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
                const deps = t.blockedBy.length > 0
                    ? ` (blocked by: ${t.blockedBy.map(id => `#${id}`).join(', ')})`
                    : '';
                return `${icon} #${t.id} [${t.status}] ${t.subject}${deps}`;
            });
            lines.push(`\n${done} done, ${pending} remaining`);
            return { output: lines.join('\n') };
        }
        case 'delete': {
            if (!task_id) {
                return { output: 'Error: task_id is required for delete', isError: true };
            }
            const idx = tasks.findIndex(t => t.id === task_id);
            if (idx === -1) {
                return { output: `Error: task #${task_id} not found`, isError: true };
            }
            const removed = tasks.splice(idx, 1)[0];
            return { output: `Task #${removed.id} deleted: ${removed.subject}` };
        }
        default:
            return { output: `Error: unknown action "${action}". Use create, update, or list.`, isError: true };
    }
}
export const taskCapability = {
    spec: {
        name: 'Task',
        description: 'Track multi-step work within a session. Use for complex tasks with 3+ steps to maintain progress. Do NOT use for simple single-step requests. Actions: create, update (status/subject), list, delete. Tasks are ephemeral — they reset when the session ends.',
        input_schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    description: 'Action: "create", "update", "list", or "delete"',
                },
                subject: { type: 'string', description: 'A brief title for the task (for create/update)' },
                description: { type: 'string', description: 'What needs to be done (for create/update)' },
                activeForm: { type: 'string', description: 'Present continuous form shown in spinner when in_progress (e.g., "Running tests", "Fixing bug"). If omitted, the subject is shown instead.' },
                task_id: { type: 'number', description: 'Task ID (for update/delete)' },
                status: {
                    type: 'string',
                    description: 'New status: "pending", "in_progress", or "completed" (for update)',
                },
                addBlocks: {
                    type: 'array',
                    description: 'Task IDs that cannot start until this task completes (for update)',
                },
                addBlockedBy: {
                    type: 'array',
                    description: 'Task IDs that must complete before this task can start (for update)',
                },
            },
            required: ['action'],
        },
    },
    execute,
    concurrent: false,
};
