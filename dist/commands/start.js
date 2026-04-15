import chalk from 'chalk';
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { loadChain, API_URLS } from '../config.js';
import { flushStats } from '../stats/tracker.js';
import { loadConfig } from './config.js';
import { printBanner } from '../banner.js';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { validateToolDescriptions } from '../tools/validate.js';
import { launchInkUI } from '../ui/app.js';
import { pickModel, resolveModel } from '../ui/model-picker.js';
import { loadMcpConfig } from '../mcp/config.js';
import { connectMcpServers, disconnectMcpServers } from '../mcp/client.js';
export async function startCommand(options) {
    const version = options.version ?? '1.0.0';
    // Early-validate explicit resume ID so a typo fails fast — before wallet
    // creation, banner, or MCP connection. Also resolve unambiguous prefixes so
    // users don't need to paste the full 40-char session ID.
    if (typeof options.resume === 'string' && options.resume !== 'picker') {
        const { resolveSessionIdInput } = await import('../ui/session-picker.js');
        const resolved = resolveSessionIdInput(options.resume);
        if (!resolved.ok) {
            if (resolved.error === 'ambiguous') {
                console.error(chalk.red(`Ambiguous session prefix: ${options.resume}`));
                console.error(chalk.dim('Matches:'));
                for (const c of resolved.candidates) {
                    console.error(chalk.dim(`  ${c.id}  (${new Date(c.updatedAt).toLocaleString()})`));
                }
            }
            else {
                console.error(chalk.red(`No session found with id: ${options.resume}`));
                console.error(chalk.dim('Run `franklin resume` to pick from a list.'));
            }
            process.exit(1);
        }
        options.resume = resolved.id;
    }
    // Resolve --continue early so the session's model can be inherited during
    // model resolution below. If no matching session is found, we fall through
    // to a fresh session (message is printed later, near the resume banner).
    let continueResolvedId;
    if (options.continue && !options.resume) {
        const { findLatestSessionForDir } = await import('../ui/session-picker.js');
        continueResolvedId = findLatestSessionForDir(process.cwd())?.id;
    }
    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    const config = loadConfig();
    // Resolve model. Priority: explicit --model > resumed session's model > user
    // config default > FREE default. Resuming restores the same model the user was
    // on last time so the environment feels continuous. Explicit --model still wins
    // so users can cheaply retry a paid session on a free model.
    let model;
    const configModel = config['default-model'];
    let resumedSessionModel;
    const modelSourceId = (typeof options.resume === 'string' && options.resume !== 'picker') ? options.resume
        : continueResolvedId;
    if (modelSourceId) {
        const { loadSessionMeta } = await import('../session/storage.js');
        resumedSessionModel = loadSessionMeta(modelSourceId)?.model;
    }
    if (options.model) {
        model = resolveModel(options.model);
    }
    else if (resumedSessionModel && resumedSessionModel !== 'unknown') {
        model = resumedSessionModel;
    }
    else if (configModel) {
        model = configModel;
    }
    else {
        // Default: free NVIDIA model — zero wallet charges until user explicitly switches
        model = 'nvidia/nemotron-ultra-253b';
    }
    // Warn when a paid model is active so users know they'll be charged
    const FREE_MODELS = new Set([
        'nvidia/nemotron-ultra-253b',
        'nvidia/qwen3-coder-480b',
        'nvidia/devstral-2-123b',
        'blockrun/free',
    ]);
    if (!FREE_MODELS.has(model)) {
        console.log(chalk.yellow(`  Model: ${model}  (paid — charges from your wallet per call)`));
        console.log(chalk.dim(`  Switch to free with: /model free\n`));
    }
    // Auto-create wallet if needed (no interruption — free models work without funding)
    let walletAddress = '';
    if (chain === 'solana') {
        const wallet = await getOrCreateSolanaWallet();
        walletAddress = wallet.address;
        if (wallet.isNew) {
            console.log(chalk.green('  Wallet created automatically.'));
            console.log(chalk.dim(`  Address: ${wallet.address}`));
            console.log(chalk.dim('  Free models work now. Fund with USDC for paid models.\n'));
        }
    }
    else {
        const wallet = getOrCreateWallet();
        walletAddress = wallet.address;
        if (wallet.isNew) {
            console.log(chalk.green('  Wallet created automatically.'));
            console.log(chalk.dim(`  Address: ${wallet.address}`));
            console.log(chalk.dim('  Free models work now. Fund with USDC for paid models.\n'));
        }
    }
    // First-run: detect other AI tools and offer migration
    if (process.stdin.isTTY) {
        try {
            const { checkAndSuggestMigration } = await import('./migrate.js');
            await checkAndSuggestMigration();
        }
        catch { /* migration is optional */ }
    }
    printBanner(version);
    const workDir = process.cwd();
    // Session info — aligned, minimal. Model + balance live in the input bar below.
    // Full wallet address is shown so the user can copy-paste it to fund the wallet.
    console.log(chalk.dim('  Wallet:    ') + (walletAddress || chalk.yellow('not set')));
    console.log(chalk.dim('  Dir:       ') + workDir);
    console.log(chalk.dim('  Dashboard: ') + chalk.cyan('franklin panel') + chalk.dim(' → http://localhost:3100'));
    console.log(chalk.dim('  Help:      ') + chalk.cyan('/help'));
    console.log('');
    // Balance fetcher — used at startup and after each turn
    const fetchBalance = async () => {
        try {
            let bal;
            if (chain === 'solana') {
                const { setupAgentSolanaWallet } = await import('@blockrun/llm');
                const client = await setupAgentSolanaWallet({ silent: true });
                bal = await client.getBalance();
            }
            else {
                const { setupAgentWallet } = await import('@blockrun/llm');
                const client = setupAgentWallet({ silent: true });
                bal = await client.getBalance();
            }
            return `$${bal.toFixed(2)} USDC`;
        }
        catch {
            return '$?.?? USDC';
        }
    };
    // Fetch balance in background (don't block startup)
    const walletInfo = {
        address: walletAddress,
        balance: 'checking...',
        chain,
    };
    // Balance fetch callback — will update Ink UI once resolved
    let onBalanceFetched;
    (async () => {
        const balStr = await fetchBalance();
        walletInfo.balance = balStr;
        onBalanceFetched?.(balStr);
    })();
    // Assemble system instructions
    const systemInstructions = assembleInstructions(workDir, model);
    // Connect MCP servers (non-blocking — add tools if servers are available)
    const mcpConfig = loadMcpConfig(workDir);
    let mcpTools = [];
    const mcpServerCount = Object.keys(mcpConfig.mcpServers).filter(k => !mcpConfig.mcpServers[k].disabled).length;
    if (mcpServerCount > 0) {
        try {
            mcpTools = await connectMcpServers(mcpConfig, options.debug);
            if (mcpTools.length > 0) {
                console.log(chalk.dim(`  MCP:    ${mcpTools.length} tools from ${mcpServerCount} server(s)`));
            }
        }
        catch (err) {
            if (options.debug) {
                console.error(chalk.yellow(`  MCP error: ${err.message}`));
            }
        }
    }
    // Build capabilities (built-in + MCP + sub-agent + MoA)
    // Pass parent model so sub-agents inherit it (no silent paid spawns from free parents)
    const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities, model);
    // Register MoA tool config (needs API URL for parallel model queries)
    const { registerMoAConfig } = await import('../tools/moa.js');
    registerMoAConfig(apiUrl, chain, model);
    const capabilities = [...allCapabilities, ...mcpTools, subAgent];
    // Validate tool descriptions (self-evolution: detect SearchX-style description bugs)
    if (options.debug) {
        const issues = validateToolDescriptions(capabilities);
        for (const issue of issues) {
            console.error(`[validate] ${issue.severity}: ${issue.toolName} — ${issue.issue}`);
        }
    }
    // Resolve resume target, if requested.
    let resumeSessionId;
    if (options.resume || options.continue) {
        const { pickSession } = await import('../ui/session-picker.js');
        const { loadSessionMeta, loadSessionHistory } = await import('../session/storage.js');
        if (typeof options.resume === 'string' && options.resume !== 'picker') {
            // Explicit ID — already validated above
            resumeSessionId = options.resume;
        }
        else if (options.continue) {
            if (!continueResolvedId) {
                console.error(chalk.yellow(`  No prior session found in ${workDir} — starting a new one.`));
            }
            else {
                resumeSessionId = continueResolvedId;
            }
        }
        else {
            // --resume with no value → interactive picker
            const picked = await pickSession({ workDir });
            if (!picked) {
                console.error(chalk.dim('  No session picked — starting a new one.'));
            }
            else {
                resumeSessionId = picked;
            }
        }
        if (resumeSessionId) {
            const meta = loadSessionMeta(resumeSessionId);
            const msgs = loadSessionHistory(resumeSessionId).length;
            const when = meta ? new Date(meta.updatedAt).toLocaleString() : 'unknown';
            console.log(chalk.green(`  Resuming session ${resumeSessionId.slice(0, 24)}…`));
            console.log(chalk.dim(`  ${msgs} messages · last active ${when}\n`));
        }
    }
    // Agent config
    const agentConfig = {
        model,
        apiUrl,
        chain,
        systemInstructions,
        capabilities,
        maxTurns: 100,
        workingDir: workDir,
        // Non-TTY (piped) input = scripted mode → trust all tools automatically.
        // Interactive TTY = default mode (prompts for Bash/Write/Edit).
        permissionMode: (options.trust || !process.stdin.isTTY) ? 'trust' : 'default',
        debug: options.debug,
        resumeSessionId,
    };
    // Bootstrap learnings from Claude Code config on first run (async, non-blocking)
    Promise.all([
        import('../learnings/extractor.js'),
        import('../agent/llm.js'),
    ]).then(([{ bootstrapFromClaudeConfig }, { ModelClient }]) => {
        const client = new ModelClient({ apiUrl, chain });
        bootstrapFromClaudeConfig(client).catch(() => { });
    }).catch(() => { });
    // Use Ink UI if TTY, fallback to basic readline for piped input
    if (process.stdin.isTTY) {
        await runWithInkUI(agentConfig, model, workDir, version, walletInfo, (cb) => {
            onBalanceFetched = cb;
        }, fetchBalance);
    }
    else {
        await runWithBasicUI(agentConfig, model, workDir);
    }
}
// ─── Ink UI (interactive terminal) ─────────────────────────────────────────
async function runWithInkUI(agentConfig, model, workDir, version, walletInfo, onBalanceReady, fetchBalance) {
    const ui = launchInkUI({
        model,
        workDir,
        version,
        walletAddress: walletInfo?.address,
        walletBalance: walletInfo?.balance,
        chain: walletInfo?.chain,
        onModelChange: (newModel, reason) => {
            agentConfig.model = newModel;
            // User-initiated switch must also update baseModel so the agent loop
            // doesn't revert to the previous model on the next turn.
            if (reason === 'user') {
                agentConfig.baseModel = newModel;
            }
        },
    });
    // Wire permission prompts through Ink UI to avoid stdin/readline conflict.
    // Ink owns stdin in raw mode; the old readline-based askQuestion() got EOF
    // immediately and auto-denied every permission. Now y/n/a goes through useInput.
    agentConfig.permissionPromptFn = (toolName, description) => ui.requestPermission(toolName, description);
    agentConfig.onAskUser = (question, options) => ui.requestAskUser(question, options);
    agentConfig.onModelChange = (model) => ui.updateModel(model);
    // Wire up background balance fetch to UI
    onBalanceReady?.((bal) => ui.updateBalance(bal));
    // Refresh balance after each completed turn so the display stays current
    if (fetchBalance) {
        ui.onTurnDone(() => {
            fetchBalance().then(bal => ui.updateBalance(bal)).catch(() => { });
        });
    }
    let sessionHistory;
    try {
        sessionHistory = await interactiveSession(agentConfig, async () => {
            const input = await ui.waitForInput();
            if (input === null)
                return null;
            if (input === '')
                return '';
            return input;
        }, (event) => ui.handleEvent(event), (abortFn) => ui.onAbort(abortFn));
    }
    catch (err) {
        if (err.name !== 'AbortError') {
            console.error(chalk.red(`\nError: ${err.message}`));
        }
    }
    ui.cleanup();
    flushStats();
    // Extract learnings from the session (async, 10s timeout, never blocks exit)
    if (sessionHistory && sessionHistory.length >= 4) {
        try {
            const { extractLearnings } = await import('../learnings/extractor.js');
            const { extractBrainEntities } = await import('../brain/extract.js');
            const { ModelClient } = await import('../agent/llm.js');
            const client = new ModelClient({ apiUrl: agentConfig.apiUrl, chain: agentConfig.chain });
            const sid = `session-${new Date().toISOString()}`;
            await Promise.race([
                Promise.all([
                    extractLearnings(sessionHistory, sid, client),
                    extractBrainEntities(sessionHistory, sid, client),
                ]),
                new Promise(resolve => setTimeout(resolve, 15_000)),
            ]);
        }
        catch { /* extraction is best-effort */ }
    }
    await disconnectMcpServers();
    // Session summary — show cost and usage before goodbye
    try {
        const { getStatsSummary } = await import('../stats/tracker.js');
        const { stats, saved } = getStatsSummary();
        if (stats.totalRequests > 0) {
            const cost = stats.totalCostUsd.toFixed(4);
            const savedStr = saved > 0.001 ? ` · saved $${saved.toFixed(2)} vs Opus` : '';
            const tokens = `${(stats.totalInputTokens / 1000).toFixed(0)}k in / ${(stats.totalOutputTokens / 1000).toFixed(0)}k out`;
            console.log(chalk.dim(`\n  Session: ${stats.totalRequests} requests · $${cost} USDC${savedStr} · ${tokens}`));
        }
    }
    catch { /* stats unavailable */ }
    console.log(chalk.dim('\nGoodbye.\n'));
}
// ─── Basic readline UI (piped input) ───────────────────────────────────────
async function runWithBasicUI(agentConfig, model, workDir) {
    const { TerminalUI } = await import('../ui/terminal.js');
    const ui = new TerminalUI();
    ui.printWelcome(model, workDir);
    let lastTerminalPrompt = '';
    try {
        await interactiveSession(agentConfig, async () => {
            while (true) {
                const input = await ui.promptUser();
                if (input === null)
                    return null;
                if (input === '')
                    continue;
                // Handle slash commands in terminal UI
                if (input.startsWith('/') && ui.handleSlashCommand(input))
                    continue;
                // Handle model switch via /model shortcut
                if (input === '/model' || input === '/models') {
                    console.error(chalk.dim(`  Current model: ${agentConfig.model}`));
                    console.error(chalk.dim('  Switch with: /model <name> (e.g. /model sonnet, /model free)'));
                    continue;
                }
                if (input.startsWith('/model ')) {
                    const newModel = resolveModel(input.slice(7).trim());
                    agentConfig.model = newModel;
                    console.error(chalk.green(`  Model → ${newModel}`));
                    continue;
                }
                // /retry — resend last prompt
                if (input === '/retry') {
                    if (!lastTerminalPrompt) {
                        console.error(chalk.yellow('  No previous prompt to retry'));
                        continue;
                    }
                    return lastTerminalPrompt;
                }
                // /compact passes through to loop
                if (input === '/compact')
                    return input;
                lastTerminalPrompt = input;
                return input;
            }
        }, (event) => ui.handleEvent(event));
    }
    catch (err) {
        if (err.name !== 'AbortError') {
            console.error(chalk.red(`\nError: ${err.message}`));
        }
    }
    // Session summary for piped mode
    try {
        const { getStatsSummary } = await import('../stats/tracker.js');
        const { stats, saved } = getStatsSummary();
        if (stats.totalRequests > 0) {
            const cost = stats.totalCostUsd.toFixed(4);
            const savedStr = saved > 0.001 ? ` · saved $${saved.toFixed(2)} vs Opus` : '';
            const tokens = `${(stats.totalInputTokens / 1000).toFixed(0)}k in / ${(stats.totalOutputTokens / 1000).toFixed(0)}k out`;
            console.error(`Session: ${stats.totalRequests} requests · $${cost} USDC${savedStr} · ${tokens}`);
        }
    }
    catch { /* stats unavailable */ }
    ui.printGoodbye();
    flushStats();
}
async function handleSlashCommand(cmd, config, ui) {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    switch (command) {
        case '/exit':
        case '/quit':
            return 'exit';
        case '/model': {
            const newModel = parts[1];
            if (newModel) {
                config.model = resolveModel(newModel);
                config.baseModel = config.model;
                console.error(chalk.green(`  Model → ${config.model}`));
                return null;
            }
            const picked = await pickModel(config.model);
            if (picked) {
                config.model = picked;
                config.baseModel = picked;
                console.error(chalk.green(`  Model → ${config.model}`));
            }
            return null;
        }
        case '/models': {
            const picked = await pickModel(config.model);
            if (picked) {
                config.model = picked;
                config.baseModel = picked;
                console.error(chalk.green(`  Model → ${config.model}`));
            }
            return null;
        }
        case '/cost':
        case '/usage': {
            const { getStatsSummary } = await import('../stats/tracker.js');
            const { stats, saved } = getStatsSummary();
            console.error(chalk.dim(`\n  Requests: ${stats.totalRequests} | Cost: $${stats.totalCostUsd.toFixed(4)} | Saved: $${saved.toFixed(2)} vs Opus\n`));
            return null;
        }
        case '/help':
            console.error(chalk.bold('\n  Commands:'));
            console.error('  /model [name]  — switch model (picker if no name)');
            console.error('  /models        — browse available models');
            console.error('  /cost          — session cost and savings');
            console.error('  /exit          — quit');
            console.error('  /help          — this help\n');
            console.error(chalk.dim('  Shortcuts: sonnet, opus, gpt, gemini, deepseek, flash, free, r1, o4\n'));
            return null;
        default:
            console.error(chalk.yellow(`  Unknown command: ${command}. Try /help`));
            return null;
    }
}
