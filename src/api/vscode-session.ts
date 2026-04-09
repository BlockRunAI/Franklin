/**
 * Headless agent session for VS Code (or any host that supplies getUserInput + onEvent).
 */

import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { loadChain, API_URLS, VERSION } from '../config.js';
import { getBannerFooterLines, getBannerPlainLines } from '../banner.js';
import { flushStats } from '../stats/tracker.js';
import { loadConfig } from '../commands/config.js';
import { estimateCost } from '../pricing.js';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { resolveModel } from '../ui/model-picker.js';
import { loadMcpConfig } from '../mcp/config.js';
import { connectMcpServers, disconnectMcpServers } from '../mcp/client.js';
import type { AgentConfig, StreamEvent } from '../agent/types.js';

export type { StreamEvent } from '../agent/types.js';
export { estimateCost } from '../pricing.js';

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

function resolveEffectiveModel(explicit?: string): string {
  const config = loadConfig();
  const configModel = config['default-model'];
  if (explicit) {
    return resolveModel(explicit);
  }
  if (configModel) {
    return configModel;
  }
  const promoExpiry = new Date('2026-04-15');
  return Date.now() < promoExpiry.getTime() ? 'zai/glm-5' : 'google/gemini-2.5-flash';
}

/** On-chain wallet + balance only (no model). Session model can differ from config — use for live status bar refresh. */
export async function getVsCodeWalletStatus(_workDir: string): Promise<{
  chain: 'base' | 'solana';
  walletAddress: string;
  balance: string;
}> {
  const chain = loadChain();

  let walletAddress = '';
  if (chain === 'solana') {
    const w = await getOrCreateSolanaWallet();
    walletAddress = w.address;
  } else {
    const w = getOrCreateWallet();
    walletAddress = w.address;
  }

  let balance = 'checking…';
  try {
    if (chain === 'solana') {
      const { setupAgentSolanaWallet } = await import('@blockrun/llm');
      const client = await setupAgentSolanaWallet({ silent: true });
      balance = `$${(await client.getBalance()).toFixed(2)} USDC`;
    } else {
      const { setupAgentWallet } = await import('@blockrun/llm');
      const client = setupAgentWallet({ silent: true });
      balance = `$${(await client.getBalance()).toFixed(2)} USDC`;
    }
  } catch {
    balance = 'unknown';
  }

  return { chain, walletAddress, balance };
}

/** Load wallet, balance, and resolved model for the welcome UI (no agent loop). */
export async function getVsCodeWelcomeInfo(workDir: string): Promise<VsCodeWelcomeInfo> {
  const model = resolveEffectiveModel();
  const { chain, walletAddress, balance } = await getVsCodeWalletStatus(workDir);

  return {
    bannerLines: getBannerPlainLines(),
    footerLines: getBannerFooterLines(VERSION),
    model,
    chain,
    walletAddress,
    balance,
    workDir,
  };
}

export interface VsCodeSessionOptions {
  /** Workspace root — tools run here */
  workDir: string;
  model?: string;
  debug?: boolean;
  /**
   * When true (default), tools run without interactive permission prompts (recommended in VS Code).
   */
  trust?: boolean;
  onEvent: (event: StreamEvent) => void;
  getUserInput: () => Promise<string | null>;
  onAbortReady?: (abort: () => void) => void;
  permissionPromptFn?: AgentConfig['permissionPromptFn'];
  onAskUser?: AgentConfig['onAskUser'];
}

export async function runVsCodeSession(options: VsCodeSessionOptions): Promise<void> {
  const chain = loadChain();
  const apiUrl = API_URLS[chain];

  const model = resolveEffectiveModel(options.model);

  if (chain === 'solana') {
    await getOrCreateSolanaWallet();
  } else {
    getOrCreateWallet();
  }

  const systemInstructions = assembleInstructions(options.workDir);

  const mcpConfig = loadMcpConfig(options.workDir);
  let mcpTools: typeof allCapabilities = [];
  const mcpServerCount = Object.keys(mcpConfig.mcpServers).filter(
    (k) => !mcpConfig.mcpServers[k].disabled
  ).length;
  if (mcpServerCount > 0) {
    try {
      mcpTools = await connectMcpServers(mcpConfig, options.debug);
    } catch {
      /* non-fatal */
    }
  }

  const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities);
  const capabilities = [...allCapabilities, ...mcpTools, subAgent];

  const trust = options.trust !== false;
  const agentConfig: AgentConfig = {
    model,
    apiUrl,
    chain,
    systemInstructions,
    capabilities,
    maxTurns: 100,
    workingDir: options.workDir,
    permissionMode: trust ? 'trust' : 'default',
    debug: options.debug,
    permissionPromptFn: options.permissionPromptFn,
    onAskUser: options.onAskUser,
  };

  try {
    await interactiveSession(
      agentConfig,
      options.getUserInput,
      options.onEvent,
      options.onAbortReady
    );
  } finally {
    flushStats();
    await disconnectMcpServers();
  }
}
