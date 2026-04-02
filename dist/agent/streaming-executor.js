/**
 * Streaming Tool Executor for runcode.
 * Starts executing concurrent-safe tools while the model is still streaming.
 * Non-concurrent tools wait until the full response is received.
 */
export class StreamingExecutor {
    handlers;
    scope;
    permissions;
    onStart;
    pending = [];
    constructor(opts) {
        this.handlers = opts.handlers;
        this.scope = opts.scope;
        this.permissions = opts.permissions;
        this.onStart = opts.onStart;
    }
    /**
     * Called when a tool_use block is fully received from the stream.
     * If the tool is concurrent-safe, start executing immediately.
     * Otherwise, queue it for later.
     */
    onToolReceived(invocation) {
        const handler = this.handlers.get(invocation.name);
        const isConcurrent = handler?.concurrent ?? false;
        if (isConcurrent) {
            // Start executing immediately
            this.onStart(invocation.id, invocation.name);
            const promise = this.executeWithPermissions(invocation);
            this.pending.push({ invocation, promise });
        }
        // Non-concurrent tools are NOT started here — they'll be executed
        // via getRemainingResults after the model finishes streaming
    }
    /**
     * After the model finishes streaming, execute any non-concurrent tools
     * and collect all results (including concurrent ones that may already be done).
     */
    async collectResults(allInvocations) {
        const results = [];
        const alreadyStarted = new Set(this.pending.map(p => p.invocation.id));
        // Wait for concurrent results that were started during streaming
        for (const p of this.pending) {
            const result = await p.promise;
            results.push([p.invocation, result]);
        }
        // Execute sequential (non-concurrent) tools now
        for (const inv of allInvocations) {
            if (alreadyStarted.has(inv.id))
                continue;
            this.onStart(inv.id, inv.name);
            const result = await this.executeWithPermissions(inv);
            results.push([inv, result]);
        }
        // Clear for next round
        this.pending = [];
        return results;
    }
    async executeWithPermissions(invocation) {
        // Permission check
        if (this.permissions) {
            const decision = await this.permissions.check(invocation.name, invocation.input);
            if (decision.behavior === 'deny') {
                return {
                    output: `Permission denied for ${invocation.name}: ${decision.reason || 'denied by policy'}`,
                    isError: true,
                };
            }
            if (decision.behavior === 'ask') {
                const allowed = await this.permissions.promptUser(invocation.name, invocation.input);
                if (!allowed) {
                    return {
                        output: `User denied permission for ${invocation.name}`,
                        isError: true,
                    };
                }
            }
        }
        const handler = this.handlers.get(invocation.name);
        if (!handler) {
            return { output: `Unknown capability: ${invocation.name}`, isError: true };
        }
        try {
            return await handler.execute(invocation.input, this.scope);
        }
        catch (err) {
            return {
                output: `Error executing ${invocation.name}: ${err.message}`,
                isError: true,
            };
        }
    }
}
