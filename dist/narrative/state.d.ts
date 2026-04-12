export interface SignalRecord {
    asset: string;
    direction: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
    summary: string;
    ts: string;
}
export interface PostRecord {
    platform: string;
    url: string;
    text: string;
    referencesAssets?: string[];
    ts: string;
}
export interface BudgetEnvelope {
    dailyCapUsd: number;
    spentTodayUsd: number;
    date: string;
}
export interface NarrativeState {
    watchlist: string[];
    recentSignals: SignalRecord[];
    recentPosts: PostRecord[];
    budget: BudgetEnvelope;
}
export declare function loadNarrative(): NarrativeState;
export declare function saveNarrative(s: NarrativeState): void;
export declare function updateNarrative(patch: Partial<NarrativeState>): NarrativeState;
export declare function addSignal(signal: SignalRecord): void;
export declare function addPost(post: PostRecord): void;
