/**
 * In-session scheduler service. A 30s tick checks due tasks and fires them
 * by enqueueing the prompt into the session's input multiplexer — firings
 * always land at turn boundaries, never mid-turn.
 *
 * Catch-up semantics: on service start, durable tasks whose nextFireAt
 * passed while no session was running fire once (a slept-through task
 * fires once, not once per missed interval — see markFired).
 *
 * Firing when NO session is running is out of scope here: the launchd
 * agent hosts the payment proxy, not an agent loop. Durable tasks simply
 * wait for the next session.
 */

import { listScheduledTasks, markFired } from './store.js';
import type { ScheduledTask } from './types.js';

const TICK_MS = 30_000;

export interface SchedulerService {
  stop: () => void;
  /** Immediate due-check — used by tests and session-start catch-up. */
  tick: () => number;
}

export function startSchedulerService(opts: {
  sessionId: string;
  enqueue: (text: string) => void;
  /** Visibility line pushed to the transcript when a task fires. */
  notify?: (line: string) => void;
}): SchedulerService {
  const fire = (task: ScheduledTask): void => {
    markFired(task);
    opts.notify?.(
      `[scheduler] firing task ${task.id} (${task.firedCount + 1}× so far): ${task.prompt.slice(0, 120)}\n`
    );
    opts.enqueue(task.prompt);
  };

  const tick = (): number => {
    const now = Date.now();
    let fired = 0;
    for (const task of listScheduledTasks()) {
      if (!task.enabled || task.nextFireAt > now) continue;
      // Non-durable tasks belong to the session that created them.
      if (!task.durable && task.sessionId !== opts.sessionId) continue;
      fire(task);
      fired++;
    }
    return fired;
  };

  // Session-start catch-up for durable tasks that slept through their slot.
  tick();

  const timer = setInterval(tick, TICK_MS);
  timer.unref(); // never keep the process alive just for the scheduler

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
