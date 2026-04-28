import type { Dialogue } from './types.js';

/**
 * Cap on how many times a single user turn can auto-continue after a
 * stream-timeout. One is enough: if the first chunked attempt also times
 * out, the model isn't going to figure it out by recursion — fall through
 * to the normal error path so the user can intervene.
 */
export const MAX_AUTO_CONTINUATIONS_PER_TURN = 1;

export function isAutoContinuationDisabled(): boolean {
  return process.env.FRANKLIN_NO_AUTO_CONTINUE === '1';
}

/**
 * Built when a model call times out at the streaming layer on a task
 * that's too big to complete in one turn (multi-file scaffolds,
 * dashboard builds, etc.). Pushed into history before re-firing so the
 * model treats the next attempt as a single narrow chunk rather than
 * retrying the whole job and timing out again.
 */
export function buildContinuationPrompt(): Dialogue {
  return {
    role: 'user',
    content: [
      'Your previous attempt timed out at the streaming layer — the task is too large for a single streaming turn.',
      '',
      'DO:',
      '- Pick ONE narrowly scoped next step (one file, one component, one logical chunk).',
      '- Complete just that step in this response.',
      '- Save work via Write/Edit and stop. The user will continue from there.',
      '',
      'DO NOT:',
      '- Re-attempt the entire original task in one shot.',
      '- Make more than 3-4 tool calls before producing a result.',
      '- Plan the whole multi-stage job — execute one chunk now.',
    ].join('\n'),
  };
}
