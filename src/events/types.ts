import crypto from 'node:crypto';

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

// ─── Agent lifecycle events (AgentHost / dashboard) ────────────────────────

export type AgentRunState = 'working' | 'idle' | 'needs-input' | 'completed' | 'failed';

export interface AgentStateEvent extends BaseEvent {
  type: 'agent.state';
  data: {
    sessionId: string;
    state: AgentRunState;
    label: string;
    model: string;
  };
}

export interface AgentTurnEvent extends BaseEvent {
  type: 'agent.turn';
  data: {
    sessionId: string;
    phase: 'start' | 'done';
    reason?: string;
  };
}

export interface ApprovalRequestedEvent extends BaseEvent {
  type: 'approval.requested';
  data: {
    sessionId: string;
    requestId: string;
    kind: string;
    title: string;
    options: string[];
  };
}

export interface ApprovalResolvedEvent extends BaseEvent {
  type: 'approval.resolved';
  data: {
    sessionId: string;
    requestId: string;
    choice: string;
    by: string;
  };
}

export type FranklinEvent =
  | SignalDetectedEvent
  | PostPublishedEvent
  | MentionReceivedEvent
  | BudgetExceededEvent
  | AgentStateEvent
  | AgentTurnEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent;

export function makeEvent<T extends FranklinEvent>(
  props: Omit<T, 'id' | 'ts'>,
): T {
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...props,
  } as T;
}
