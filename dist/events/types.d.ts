export interface BaseEvent {
    id: string;
    type: string;
    ts: string;
    source: 'trading' | 'social' | 'core';
    costUsd?: number;
    correlationId?: string;
}
export interface SignalDetectedEvent extends BaseEvent {
    type: 'signal.detected';
    data: {
        asset: string;
        direction: 'bullish' | 'bearish' | 'neutral';
        confidence: number;
        indicators: Record<string, number>;
        summary: string;
    };
}
export interface PostPublishedEvent extends BaseEvent {
    type: 'post.published';
    data: {
        platform: 'x' | 'reddit' | (string & {});
        url: string;
        text: string;
        referencesAssets?: string[];
    };
}
export interface MentionReceivedEvent extends BaseEvent {
    type: 'mention.received';
    data: {
        platform: string;
        url: string;
        text: string;
        author: string;
        sentiment?: 'positive' | 'negative' | 'neutral';
        mentionsAsset?: string;
    };
}
export interface BudgetExceededEvent extends BaseEvent {
    type: 'budget.exceeded';
    data: {
        category: 'llm' | 'data' | 'gas';
        spent: number;
        cap: number;
        blockedAction: string;
    };
}
export type FranklinEvent = SignalDetectedEvent | PostPublishedEvent | MentionReceivedEvent | BudgetExceededEvent;
export declare function makeEvent<T extends FranklinEvent>(props: Omit<T, 'id' | 'ts'>): T;
