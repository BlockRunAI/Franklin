/**
 * Streaming Tool Executor for 0xcode.
 * Starts executing concurrent-safe tools while the model is still streaming.
 * Non-concurrent tools wait until the full response is received.
 */
import type { CapabilityHandler, CapabilityInvocation, CapabilityResult, ExecutionScope } from './types.js';
import type { PermissionManager } from './permissions.js';
export declare class StreamingExecutor {
    private handlers;
    private scope;
    private permissions?;
    private onStart;
    private pending;
    constructor(opts: {
        handlers: Map<string, CapabilityHandler>;
        scope: ExecutionScope;
        permissions?: PermissionManager;
        onStart: (id: string, name: string) => void;
    });
    /**
     * Called when a tool_use block is fully received from the stream.
     * If the tool is concurrent-safe, start executing immediately.
     * Otherwise, queue it for later.
     */
    onToolReceived(invocation: CapabilityInvocation): void;
    /**
     * After the model finishes streaming, execute any non-concurrent tools
     * and collect all results (including concurrent ones that may already be done).
     */
    collectResults(allInvocations: CapabilityInvocation[]): Promise<[CapabilityInvocation, CapabilityResult][]>;
    private executeWithPermissions;
}
