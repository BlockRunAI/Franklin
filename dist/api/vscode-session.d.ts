/**
 * Headless agent session for VS Code (or any host that supplies getUserInput + onEvent).
 */
import type { AgentConfig, StreamEvent } from '../agent/types.js';
export type { StreamEvent } from '../agent/types.js';
export type { Dialogue } from '../agent/types.js';
export { estimateCost } from '../pricing.js';
export { listSessions, loadSessionHistory, loadSessionMeta } from '../session/storage.js';
export type { SessionMeta } from '../session/storage.js';
/** Welcome panel: same branding as CLI, plus live wallet / model / workspace. */
export interface VsCodeWelcomeInfo {
    bannerLines: string[];
    footerLines: string[];
    model: string;
    chain: 'base' | 'solana';
    walletAddress: string;
    balance: string;
    workDir: string;
}
export declare function getBannerPlainLines(): string[];
export declare function getBannerFooterLines(version: string): string[];
/** On-chain wallet + balance only (no model). */
export declare function getVsCodeWalletStatus(_workDir: string): Promise<{
    chain: 'base' | 'solana';
    walletAddress: string;
    balance: string;
}>;
/** Load wallet, balance, and resolved model for the welcome UI (no agent loop). */
export declare function getVsCodeWelcomeInfo(workDir: string): Promise<VsCodeWelcomeInfo>;
export interface VsCodeSessionOptions {
    /** Workspace root — tools run here */
    workDir: string;
    model?: string;
    debug?: boolean;
    trust?: boolean;
    onEvent: (event: StreamEvent) => void;
    getUserInput: () => Promise<string | null>;
    onAbortReady?: (abort: () => void) => void;
    permissionPromptFn?: AgentConfig['permissionPromptFn'];
    onAskUser?: AgentConfig['onAskUser'];
    onConfigReady?: (config: AgentConfig) => void;
}
export declare function runVsCodeSession(options: VsCodeSessionOptions): Promise<void>;
