/**
 * Headless agent session for VS Code (or any host that supplies getUserInput + onEvent).
 */
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { loadChain, API_URLS, VERSION } from '../config.js';
import { flushStats } from '../stats/tracker.js';
import { loadConfig } from '../commands/config.js';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { resolveModel } from '../ui/model-picker.js';
import { loadMcpConfig } from '../mcp/config.js';
import { connectMcpServers, disconnectMcpServers } from '../mcp/client.js';
export { estimateCost } from '../pricing.js';
// ─── FRANKLIN plain-text banner for webview (no ANSI) ──────────────────────
const FRANKLIN_ART = [
    ' ███████╗██████╗  █████╗ ███╗   ██╗██╗  ██╗██╗     ██╗███╗   ██╗',
    ' ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║ ██╔╝██║     ██║████╗  ██║',
    ' █████╗  ██████╔╝███████║██╔██╗ ██║█████╔╝ ██║     ██║██╔██╗ ██║',
    ' ██╔══╝  ██╔══██╗██╔══██║██║╚██╗██║██╔═██╗ ██║     ██║██║╚██╗██║',
    ' ██║     ██║  ██║██║  ██║██║ ╚████║██║  ██╗███████╗██║██║ ╚████║',
    ' ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝',
];
export function getBannerPlainLines() {
    return [...FRANKLIN_ART];
}
export function getBannerFooterLines(version) {
    return [
        `Franklin v${version}`,
        'blockrun.ai  ·  The AI agent with a wallet',
    ];
}
function resolveEffectiveModel(explicit) {
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
/** On-chain wallet + balance only (no model). */
export async function getVsCodeWalletStatus(_workDir) {
    const chain = loadChain();
    let walletAddress = '';
    if (chain === 'solana') {
        const w = await getOrCreateSolanaWallet();
        walletAddress = w.address;
    }
    else {
        const w = getOrCreateWallet();
        walletAddress = w.address;
    }
    let balance = 'checking…';
    try {
        if (chain === 'solana') {
            const { setupAgentSolanaWallet } = await import('@blockrun/llm');
            const client = await setupAgentSolanaWallet({ silent: true });
            balance = `$${(await client.getBalance()).toFixed(2)} USDC`;
        }
        else {
            const { setupAgentWallet } = await import('@blockrun/llm');
            const client = setupAgentWallet({ silent: true });
            balance = `$${(await client.getBalance()).toFixed(2)} USDC`;
        }
    }
    catch {
        balance = 'unknown';
    }
    return { chain, walletAddress, balance };
}
/** Load wallet, balance, and resolved model for the welcome UI (no agent loop). */
export async function getVsCodeWelcomeInfo(workDir) {
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
export async function runVsCodeSession(options) {
    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    const model = resolveEffectiveModel(options.model);
    if (chain === 'solana') {
        await getOrCreateSolanaWallet();
    }
    else {
        getOrCreateWallet();
    }
    const systemInstructions = assembleInstructions(options.workDir);
    const mcpConfig = loadMcpConfig(options.workDir);
    let mcpTools = [];
    const mcpServerCount = Object.keys(mcpConfig.mcpServers).filter((k) => !mcpConfig.mcpServers[k].disabled).length;
    if (mcpServerCount > 0) {
        try {
            mcpTools = await connectMcpServers(mcpConfig, options.debug);
        }
        catch {
            /* non-fatal */
        }
    }
    const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities);
    const capabilities = [...allCapabilities, ...mcpTools, subAgent];
    const trust = options.trust !== false;
    const agentConfig = {
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
    options.onConfigReady?.(agentConfig);
    try {
        await interactiveSession(agentConfig, options.getUserInput, options.onEvent, options.onAbortReady);
    }
    finally {
        flushStats();
        await disconnectMcpServers();
    }
}
