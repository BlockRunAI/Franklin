import chalk from 'chalk';
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { loadChain, API_URLS } from '../config.js';
import { loadConfig } from './config.js';
import { printBanner } from '../banner.js';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { TerminalUI } from '../ui/terminal.js';
import { pickModel, resolveModel } from '../ui/model-picker.js';
export async function startCommand(options) {
    const version = options.version ?? '1.0.0';
    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    const config = loadConfig();
    // Resolve model — show picker if interactive and no model specified
    let model;
    let bannerShown = false;
    const configModel = config['default-model'];
    if (options.model) {
        model = resolveModel(options.model);
    }
    else if (configModel) {
        model = configModel;
    }
    else if (process.stdin.isTTY) {
        // Interactive — show model picker
        printBanner(version);
        bannerShown = true;
        const picked = await pickModel();
        if (!picked) {
            model = 'anthropic/claude-sonnet-4.6';
        }
        else {
            model = picked;
        }
    }
    else {
        model = 'anthropic/claude-sonnet-4.6';
    }
    // Ensure wallet exists
    if (chain === 'solana') {
        const wallet = await getOrCreateSolanaWallet();
        if (wallet.isNew) {
            console.log(chalk.yellow('No Solana wallet found — created a new one.'));
            console.log(`Address: ${chalk.cyan(wallet.address)}`);
            console.log(`\nSend USDC on Solana to this address, then run ${chalk.bold('runcode start')} again.\n`);
            return;
        }
    }
    else {
        const wallet = getOrCreateWallet();
        if (wallet.isNew) {
            console.log(chalk.yellow('No wallet found — created a new one.'));
            console.log(`Address: ${chalk.cyan(wallet.address)}`);
            console.log(`\nSend USDC on Base to this address, then run ${chalk.bold('runcode start')} again.\n`);
            return;
        }
    }
    // Print banner (skip if already shown during model pick)
    if (!bannerShown)
        printBanner(version);
    const workDir = process.cwd();
    const ui = new TerminalUI();
    ui.printWelcome(model, workDir);
    // Assemble system instructions
    const systemInstructions = assembleInstructions(workDir);
    // Build capabilities including sub-agent
    const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities);
    const capabilities = [...allCapabilities, subAgent];
    // Agent config
    const agentConfig = {
        model,
        apiUrl,
        chain,
        systemInstructions,
        capabilities,
        maxTurns: 100,
        workingDir: workDir,
        permissionMode: options.trust ? 'trust' : 'default',
        debug: options.debug,
    };
    // Run interactive session
    try {
        await interactiveSession(agentConfig, async () => {
            while (true) {
                const input = await ui.promptUser();
                if (input === null)
                    return null; // EOF
                if (input === '')
                    continue; // empty → re-prompt
                if (input.startsWith('/')) {
                    const result = await handleSlashCommand(input, agentConfig);
                    if (result === 'exit')
                        return null;
                    if (result === null)
                        continue; // command handled → re-prompt
                    return result; // string → send to agent
                }
                return input;
            }
        }, (event) => ui.handleEvent(event));
    }
    catch (err) {
        if (err.name === 'AbortError') {
            // User interrupted
        }
        else {
            console.error(chalk.red(`\nError: ${err.message}`));
        }
    }
    ui.printGoodbye();
}
async function handleSlashCommand(cmd, config) {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    switch (command) {
        case '/exit':
        case '/quit':
            return 'exit';
        case '/model': {
            const newModel = parts[1];
            if (newModel) {
                // Direct switch via shortcut or full ID
                config.model = resolveModel(newModel);
                console.error(chalk.green(`  Model → ${config.model}`));
                return null;
            }
            // No arg — show interactive picker
            const picked = await pickModel(config.model);
            if (picked) {
                config.model = picked;
                console.error(chalk.green(`  Model → ${config.model}`));
            }
            return null;
        }
        case '/models':
            // Shortcut: same as /model with no args
            const picked = await pickModel(config.model);
            if (picked) {
                config.model = picked;
                console.error(chalk.green(`  Model → ${config.model}`));
            }
            return null;
        case '/cost':
        case '/usage': {
            const { getStatsSummary } = await import('../stats/tracker.js');
            const { stats, opusCost, saved } = getStatsSummary();
            console.error(chalk.dim(`\n  Requests: ${stats.totalRequests} | Cost: $${stats.totalCostUsd.toFixed(4)} | Saved: $${saved.toFixed(2)} vs Opus\n`));
            return null;
        }
        case '/help':
            console.error(chalk.bold('\n  Commands:'));
            console.error('  /model [name]  — switch model (interactive picker if no name)');
            console.error('  /models        — browse all available models');
            console.error('  /cost          — show session cost and savings');
            console.error('  /exit          — quit');
            console.error('  /help          — this help\n');
            console.error(chalk.dim('  Shortcuts: sonnet, opus, gpt, gemini, deepseek, flash, free, r1, o4\n'));
            return null;
        default:
            console.error(chalk.yellow(`  Unknown command: ${command}. Try /help`));
            return null;
    }
}
