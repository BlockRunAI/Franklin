/**
 * UpdateGoal capability — the model's control surface for an active goal.
 * Completion claims are intercepted by an adversarial verifier panel before
 * they are accepted; blocked claims escalate to the user.
 */

import type { CapabilityHandler } from '../agent/types.js';
import { processGoalClaim } from '../goal/runtime.js';

export function createUpdateGoalCapability(): CapabilityHandler {
  return {
    spec: {
      name: 'UpdateGoal',
      description:
        'Update the active goal (started with /goal). Set completed: true ONLY when every acceptance ' +
        'criterion in the goal plan is demonstrably met and you have run the plan\'s verification yourself — ' +
        'an adversarial reviewer panel audits the claim and refutes anything unsupported by real evidence. ' +
        'Set blocked_reason when you genuinely need a user decision to proceed. ' +
        'Use message alone for a progress note. No active goal = this tool errors.',
      input_schema: {
        type: 'object',
        properties: {
          completed: { type: 'boolean', description: 'true = claim the goal is fully achieved (triggers verification).' },
          blocked_reason: { type: 'string', description: 'Why the goal cannot proceed without a user decision.' },
          message: { type: 'string', description: 'Progress note, or evidence summary accompanying a completion claim.' },
        },
      },
    },
    // Verification can take minutes and must not race other tools.
    concurrent: false,
    execute: (input, ctx) => processGoalClaim(input, ctx),
  };
}
