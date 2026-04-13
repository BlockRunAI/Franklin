import type { CapabilityInvocation, CapabilityResult, ExecutionScope } from './types.js';
export declare function normalizeSearchQuery(query: string): {
    normalized: string;
    tokens: string[];
};
export declare class SessionToolGuard {
    private turn;
    private webSearchesThisTurn;
    private searchFamilies;
    private searchCache;
    private pendingSearches;
    private recentReads;
    private pendingReads;
    private recentFetches;
    private pendingFetches;
    private toolErrorCounts;
    startTurn(): void;
    beforeExecute(invocation: CapabilityInvocation, scope: ExecutionScope): Promise<CapabilityResult | null>;
    afterExecute(invocation: CapabilityInvocation, result: CapabilityResult): void;
    cancelInvocation(invocationId: string): void;
    private beforeWebSearch;
    private beforeRead;
    private beforeWebFetch;
    private afterWebSearch;
    private afterRead;
    private afterWebFetch;
}
