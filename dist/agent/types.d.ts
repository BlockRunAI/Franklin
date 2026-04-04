/**
 * Core types for the runcode agent system.
 * All type names and structures are original designs.
 */
export type Role = 'user' | 'assistant';
export interface TextSegment {
    type: 'text';
    text: string;
}
export interface CapabilityInvocation {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface ThinkingSegment {
    type: 'thinking';
    thinking: string;
    signature?: string;
}
export interface CapabilityOutcome {
    type: 'tool_result';
    tool_use_id: string;
    content: string | ContentPart[];
    is_error?: boolean;
}
export type ContentPart = TextSegment | CapabilityInvocation | ThinkingSegment;
export type UserContentPart = TextSegment | CapabilityOutcome;
export interface Dialogue {
    role: Role;
    content: ContentPart[] | UserContentPart[] | string;
}
export interface CapabilitySchema {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
}
export interface CapabilityDefinition {
    name: string;
    description: string;
    input_schema: CapabilitySchema;
}
export interface CapabilityHandler {
    spec: CapabilityDefinition;
    execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult>;
    concurrent?: boolean;
}
export interface CapabilityResult {
    output: string;
    isError?: boolean;
}
export interface ExecutionScope {
    workingDir: string;
    abortSignal: AbortSignal;
    onProgress?: (text: string) => void;
}
export interface StreamTextDelta {
    kind: 'text_delta';
    text: string;
}
export interface StreamThinkingDelta {
    kind: 'thinking_delta';
    text: string;
}
export interface StreamCapabilityStart {
    kind: 'capability_start';
    id: string;
    name: string;
}
export interface StreamCapabilityInputDelta {
    kind: 'capability_input_delta';
    id: string;
    delta: string;
}
export interface StreamCapabilityDone {
    kind: 'capability_done';
    id: string;
    result: CapabilityResult;
}
export interface StreamTurnDone {
    kind: 'turn_done';
    reason: 'completed' | 'max_turns' | 'aborted' | 'error';
    error?: string;
}
export interface StreamUsageInfo {
    kind: 'usage';
    inputTokens: number;
    outputTokens: number;
    model: string;
}
export type StreamEvent = StreamTextDelta | StreamThinkingDelta | StreamCapabilityStart | StreamCapabilityInputDelta | StreamCapabilityDone | StreamTurnDone | StreamUsageInfo;
export interface AgentConfig {
    model: string;
    apiUrl: string;
    chain: 'base' | 'solana';
    systemInstructions: string[];
    capabilities: CapabilityHandler[];
    maxTurns?: number;
    workingDir?: string;
    permissionMode?: 'default' | 'trust' | 'deny-all' | 'plan';
    onEvent?: (event: StreamEvent) => void;
    debug?: boolean;
    /** Ultrathink mode: inject deep-reasoning instruction into every prompt */
    ultrathink?: boolean;
}
