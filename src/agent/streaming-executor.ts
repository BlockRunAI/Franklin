/**
 * Streaming Tool Executor for runcode.
 * Starts executing concurrent-safe tools while the model is still streaming.
 * Non-concurrent tools wait until the full response is received.
 */

import type {
  CapabilityHandler,
  CapabilityInvocation,
  CapabilityResult,
  ExecutionScope,
} from './types.js';
import type { PermissionManager } from './permissions.js';
import { recordFailure } from '../stats/failures.js';

interface PendingTool {
  invocation: CapabilityInvocation;
  promise: Promise<CapabilityResult>;
}

export class StreamingExecutor {
  private handlers: Map<string, CapabilityHandler>;
  private scope: ExecutionScope;
  private permissions?: PermissionManager;
  private onStart: (id: string, name: string, preview?: string) => void;
  private onProgress?: (id: string, text: string) => void;
  private pending: PendingTool[] = [];

  constructor(opts: {
    handlers: Map<string, CapabilityHandler>;
    scope: ExecutionScope;
    permissions?: PermissionManager;
    onStart: (id: string, name: string, preview?: string) => void;
    onProgress?: (id: string, text: string) => void;
  }) {
    this.handlers = opts.handlers;
    this.scope = opts.scope;
    this.permissions = opts.permissions;
    this.onStart = opts.onStart;
    this.onProgress = opts.onProgress;
  }

  /**
   * Called when a tool_use block is fully received from the stream.
   * If the tool is concurrent-safe, start executing immediately.
   * Otherwise, queue it for later.
   */
  onToolReceived(invocation: CapabilityInvocation): void {
    const handler = this.handlers.get(invocation.name);
    const isConcurrent = handler?.concurrent ?? false;

    if (isConcurrent) {
      // Concurrent tools are auto-allowed — start immediately and time from here
      const preview = this.inputPreview(invocation);
      this.onStart(invocation.id, invocation.name, preview);
      const promise = this.executeWithPermissions(invocation, 1, false);
      this.pending.push({ invocation, promise });
    }
    // Non-concurrent tools are NOT started here — executed via collectResults
  }

  /**
   * After the model finishes streaming, execute any non-concurrent tools
   * and collect all results (including concurrent ones that may already be done).
   */
  async collectResults(
    allInvocations: CapabilityInvocation[]
  ): Promise<[CapabilityInvocation, CapabilityResult][]> {
    const results: [CapabilityInvocation, CapabilityResult][] = [];
    const alreadyStarted = new Set(this.pending.map(p => p.invocation.id));
    const pendingSnapshot = [...this.pending];
    this.pending = []; // Clear immediately so errors don't leave stale state

    // Pre-count pending sequential invocations per tool type.
    // Shown in permission dialog: "N pending — press [a] to allow all".
    const pendingCounts: Map<string, number> = new Map();
    for (const inv of allInvocations) {
      if (!alreadyStarted.has(inv.id)) {
        pendingCounts.set(inv.name, (pendingCounts.get(inv.name) || 0) + 1);
      }
    }
    const remainingCounts = new Map(pendingCounts);

    try {
      // Wait for concurrent results that were started during streaming
      for (const p of pendingSnapshot) {
        const result = await p.promise;
        results.push([p.invocation, result]);
      }

      // Execute sequential (non-concurrent) tools now
      for (const inv of allInvocations) {
        if (alreadyStarted.has(inv.id)) continue;

        const remaining = remainingCounts.get(inv.name) ?? 1;
        remainingCounts.set(inv.name, remaining - 1);

        // NOTE: onStart is called INSIDE executeWithPermissions, AFTER permission is granted.
        // This ensures elapsed time reflects actual execution time, not permission wait time.
        const result = await this.executeWithPermissions(inv, remaining, true);
        results.push([inv, result]);
      }
    } catch (err) {
      // Return partial results rather than losing them; caller handles errors
      throw err;
    }

    return results;
  }

  private async executeWithPermissions(
    invocation: CapabilityInvocation,
    pendingCount = 1,
    callStart = true  // false for concurrent tools (already called in onToolReceived)
  ): Promise<CapabilityResult> {
    // Permission check
    if (this.permissions) {
      const decision = await this.permissions.check(invocation.name, invocation.input);
      if (decision.behavior === 'deny') {
        return {
          output: `Permission denied for ${invocation.name}: ${decision.reason || 'denied by policy'}. Do not retry — explain to the user what you were trying to do and ask how they'd like to proceed.`,
          isError: true,
        };
      }
      if (decision.behavior === 'ask') {
        const allowed = await this.permissions.promptUser(invocation.name, invocation.input, pendingCount);
        if (!allowed) {
          return {
            output: `User denied permission for ${invocation.name}. Do not retry — ask the user what they'd like to do instead.`,
            isError: true,
          };
        }
      }
    }

    // Start timing AFTER permission is granted (accurate elapsed time)
    if (callStart) {
      const preview = this.inputPreview(invocation);
      this.onStart(invocation.id, invocation.name, preview);
    }

    const handler = this.handlers.get(invocation.name);
    if (!handler) {
      return { output: `Unknown capability: ${invocation.name}`, isError: true };
    }

    // Wire per-invocation progress to onProgress callback
    const progressScope: ExecutionScope = this.onProgress
      ? {
          ...this.scope,
          onProgress: (text: string) => this.onProgress!(invocation.id, text),
        }
      : this.scope;

    try {
      return await handler.execute(invocation.input, progressScope);
    } catch (err) {
      recordFailure({
        timestamp: Date.now(),
        model: '', // not available at tool level
        failureType: 'tool_error',
        toolName: invocation.name,
        errorMessage: (err as Error).message,
      });
      return {
        output: `Error executing ${invocation.name}: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  /** Extract a short preview string from a tool invocation's input. */
  private inputPreview(invocation: CapabilityInvocation): string | undefined {
    const input = invocation.input;
    switch (invocation.name) {
      case 'Bash': {
        const cmd = (input.command as string) || '';
        return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
      }
      case 'Write':
      case 'Read':
      case 'Edit':
        return (input.file_path as string) || undefined;
      case 'Grep':
        return (input.pattern as string) || undefined;
      case 'Glob':
        return (input.pattern as string) || undefined;
      case 'WebFetch':
      case 'WebSearch':
        return ((input.url ?? input.query) as string) || undefined;
      default:
        return undefined;
    }
  }
}
