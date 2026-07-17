/**
 * Input multiplexer — merges harness-injected inputs (scheduler firings,
 * goal continuations) with the driver's own input source.
 *
 * Injected inputs are delivered ONLY at turn boundaries: the agent loop
 * calls getUserInput() between turns and queued items win the race there.
 * Nothing is ever pushed mid-turn — turn structure, permission prompts,
 * and prompt-cache behavior stay intact.
 *
 * The base input promise is held across calls: when the driver is parked
 * waiting for the user (interactive TUI, idle) and a scheduled prompt
 * arrives, the injected item is returned immediately while the pending
 * user input keeps waiting and is delivered at the next boundary. The
 * user's typing is never dropped.
 */

export interface InputMultiplexer {
  /** Drop-in replacement for the driver's getUserInput. */
  getUserInput: () => Promise<string | null>;
  /** Queue a synthetic input for the next turn boundary. */
  enqueue: (text: string, opts?: { priority?: boolean }) => void;
  /** Number of injected inputs currently waiting. */
  pending: () => number;
}

export function createInputMultiplexer(
  base: () => Promise<string | null>
): InputMultiplexer {
  const queue: string[] = [];
  let pendingBase: Promise<string | null> | null = null;
  let baseDone = false;
  // The loop is a single consumer — at most one getUserInput() outstanding,
  // so one notifier slot suffices.
  let queueNotify: (() => void) | null = null;

  return {
    getUserInput: async () => {
      while (true) {
        if (queue.length > 0) return queue.shift()!;
        if (baseDone) return null;

        if (!pendingBase) pendingBase = base();
        const arrival = new Promise<'queued'>(resolve => {
          queueNotify = () => resolve('queued');
        });
        const raced = await Promise.race([
          pendingBase.then(v => ({ base: v })),
          arrival,
        ]);
        queueNotify = null;

        if (raced === 'queued') continue; // loop re-checks the queue

        pendingBase = null;
        if (raced.base === null) {
          baseDone = true;
          // Base exhausted (EOF/quit) — flush late-queued items first.
          if (queue.length > 0) return queue.shift()!;
          return null;
        }
        return raced.base;
      }
    },
    enqueue: (text, opts) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (opts?.priority) queue.unshift(trimmed);
      else queue.push(trimmed);
      queueNotify?.();
    },
    pending: () => queue.length,
  };
}
