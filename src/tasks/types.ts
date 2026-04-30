/**
 * Task subsystem types. Mirrors openclaw/openclaw src/tasks/task-registry.types.ts
 * with channel/delivery fields stripped — Franklin is CLI-first single-user.
 */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'lost';

export type TaskRuntime = 'detached-bash';

export type TaskTerminalOutcome = 'succeeded' | 'blocked';

export type TaskEventKind = TaskStatus | 'progress';

export interface TaskEventRecord {
  at: number;
  kind: TaskEventKind;
  summary?: string;
}

export interface TaskRecord {
  runId: string;
  runtime: TaskRuntime;
  label: string;
  command: string;
  workingDir: string;
  pid?: number;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  exitCode?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
}

const TERMINAL = new Set<TaskStatus>([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'lost',
]);

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return TERMINAL.has(s);
}
