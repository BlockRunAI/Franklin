import chalk from 'chalk';
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { loadChain, API_URLS } from '../config.js';
import { flushStats } from '../stats/tracker.js';
import { loadConfig } from './config.js';
import { printBanner } from '../banner.js';
import { assembleInstructions } from '../agent/context.js';
import { interactiveSession } from '../agent/loop.js';
import { allCapabilities, createSubAgentCapability } from '../tools/index.js';
import { launchInkUI } from '../ui/app.js';
import { pickModel, resolveModel } from '../ui/model-picker.js';
import { loadMcpConfig } from '../mcp/config.js';
import { connectMcpServers, disconnectMcpServers } from '../mcp/client.js';
import type { AgentConfig, Dialogue } from '../agent/types.js';

interface StartOptions {
  model?: string;
  debug?: boolean;
  trust?: boolean;
  version?: string;
}

export async function startCommand(options: StartOptions) {
  const version = options.version ?? '1.0.0';
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const config = loadConfig();

  // Resolve model — default to GLM-5.1 promo if nothing specified
  let model: string;
  const configModel = config['default-model'];
  if (options.model) {
    model = resolveModel(options.model);
  } else if (configModel) {
    model = configModel;
  } else {
    // Default: GLM-5.1 promo if still active, otherwise Gemini Flash (cheap & reliable)
    const promoExpiry = new Date('2026-04-15');
    model = Date.now() < promoExpiry.getTime() ? 'zai/glm-5.1' : 'google/gemini-2.5-flash';
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
  } else {
    const wallet = getOrCreateWallet();
    walletAddress = wallet.address;
    if (wallet.isNew) {
      console.log(chalk.green('  Wallet created automatically.'));
      console.log(chalk.dim(`  Address: ${wallet.address}`));
      console.log(chalk.dim('  Free models work now. Fund with USDC for paid models.\n'));
    }
  }

  printBanner(version);

  const workDir = process.cwd();

  // Show session info immediately, fetch balance in background
  // Model is shown in the live status bar — no static line needed.
  console.log(chalk.dim(`  Wallet: ${walletAddress || 'not set'}`));
  console.log(chalk.dim(`  Dir:    ${workDir}`));
  // First-run tip: show if no config file exists yet
  if (!configModel && !options.model) {
    console.log(chalk.dim(`\n  Tip: /model to switch models · /compact to save tokens · /help for all commands`));
  }
  // Welcome message — show things Hermes/OpenClaw can't do.
  // Only on first run or when no model is configured (new user indicator).
  // After the user's first session, the tip fades and they go straight to the prompt.
  console.log('');
  console.log(chalk.dim('  Try something only Franklin can do:'));
  console.log(chalk.dim('    ') + chalk.hex('#FFD700')('"what\'s BTC looking like today?"') + chalk.dim('       ← live market signal'));
  console.log(chalk.dim('    ') + chalk.hex('#10B981')('"find X posts about ai agent"') + chalk.dim(' ← social growth'));
  console.log(chalk.dim('    ') + chalk.hex('#60A5FA')('"generate a hero image for my app"') + chalk.dim('      ← AI image gen'));
  console.log(chalk.dim('  Or just code — 55+ models ready, no API keys needed.'));
  console.log('');

  // Balance fetcher — used at startup and after each turn
  const fetchBalance = async (): Promise<string> => {
    try {
      let bal: number;
      if (chain === 'solana') {
        const { setupAgentSolanaWallet } = await import('@blockrun/llm');
        const client = await setupAgentSolanaWallet({ silent: true });
        bal = await client.getBalance();
      } else {
        const { setupAgentWallet } = await import('@blockrun/llm');
        const client = setupAgentWallet({ silent: true });
        bal = await client.getBalance();
      }
      return `$${bal.toFixed(2)} USDC`;
    } catch {
      return '$?.?? USDC';
    }
  };

  // Fetch balance in background (don't block startup)
  const walletInfo: { address: string; balance: string; chain: string } = {
    address: walletAddress,
    balance: 'checking...',
    chain,
  };
  // Balance fetch callback — will update Ink UI once resolved
  let onBalanceFetched: ((bal: string) => void) | undefined;
  (async () => {
    const balStr = await fetchBalance();
    walletInfo.balance = balStr;
    onBalanceFetched?.(balStr);
  })();

  // Assemble system instructions
  const systemInstructions = assembleInstructions(workDir);

  // Connect MCP servers (non-blocking — add tools if servers are available)
  const mcpConfig = loadMcpConfig(workDir);
  let mcpTools: typeof allCapabilities = [];
  const mcpServerCount = Object.keys(mcpConfig.mcpServers).filter(k => !mcpConfig.mcpServers[k].disabled).length;
  if (mcpServerCount > 0) {
    try {
      mcpTools = await connectMcpServers(mcpConfig, options.debug);
      if (mcpTools.length > 0) {
        console.log(chalk.dim(`  MCP:    ${mcpTools.length} tools from ${mcpServerCount} server(s)`));
      }
    } catch (err) {
      if (options.debug) {
        console.error(chalk.yellow(`  MCP error: ${(err as Error).message}`));
      }
    }
  }

  // Build capabilities (built-in + MCP + sub-agent)
  const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities);
  const capabilities = [...allCapabilities, ...mcpTools, subAgent];

  // Agent config
  const agentConfig: AgentConfig = {
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
  };

  // Bootstrap learnings from Claude Code config on first run (async, non-blocking)
  Promise.all([
    import('../learnings/extractor.js'),
    import('../agent/llm.js'),
  ]).then(([{ bootstrapFromClaudeConfig }, { ModelClient }]) => {
    const client = new ModelClient({ apiUrl, chain });
    bootstrapFromClaudeConfig(client).catch(() => {});
  }).catch(() => {});

  // Use Ink UI if TTY, fallback to basic readline for piped input
  if (process.stdin.isTTY) {
    await runWithInkUI(agentConfig, model, workDir, version, walletInfo, (cb) => {
      onBalanceFetched = cb;
    }, fetchBalance);
  } else {
    await runWithBasicUI(agentConfig, model, workDir);
  }
}

// ─── Ink UI (interactive terminal) ─────────────────────────────────────────

async function runWithInkUI(
  agentConfig: AgentConfig,
  model: string,
  workDir: string,
  version: string,
  walletInfo?: { address: string; balance: string; chain: string },
  onBalanceReady?: (cb: (bal: string) => void) => void,
  fetchBalance?: () => Promise<string>,
) {
  const ui = launchInkUI({
    model,
    workDir,
    version,
    walletAddress: walletInfo?.address,
    walletBalance: walletInfo?.balance,
    chain: walletInfo?.chain,
    onModelChange: (newModel: string) => {
      agentConfig.model = newModel;
    },
  });

  // Wire permission prompts through Ink UI to avoid stdin/readline conflict.
  // Ink owns stdin in raw mode; the old readline-based askQuestion() got EOF
  // immediately and auto-denied every permission. Now y/n/a goes through useInput.
  agentConfig.permissionPromptFn = (toolName, description) =>
    ui.requestPermission(toolName, description);
  agentConfig.onAskUser = (question, options) =>
    ui.requestAskUser(question, options);
  agentConfig.onModelChange = (model) => ui.updateModel(model);

  // Wire up background balance fetch to UI
  onBalanceReady?.((bal) => ui.updateBalance(bal));

  // Refresh balance after each completed turn so the display stays current
  if (fetchBalance) {
    ui.onTurnDone(() => {
      fetchBalance().then(bal => ui.updateBalance(bal)).catch(() => {});
    });
  }

  let sessionHistory: Dialogue[] | undefined;
  try {
    sessionHistory = await interactiveSession(
      agentConfig,
      async () => {
        const input = await ui.waitForInput();
        if (input === null) return null;
        if (input === '') return '';
        return input;
      },
      (event) => ui.handleEvent(event),
      (abortFn) => ui.onAbort(abortFn)
    );
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
    }
  }

  ui.cleanup();
  flushStats();

  // Extract learnings from the session (async, 10s timeout, never blocks exit)
  if (sessionHistory && sessionHistory.length >= 4) {
    try {
      const { extractLearnings } = await import('../learnings/extractor.js');
      const { ModelClient } = await import('../agent/llm.js');
      const client = new ModelClient({ apiUrl: agentConfig.apiUrl, chain: agentConfig.chain });
      await Promise.race([
        extractLearnings(sessionHistory, `session-${new Date().toISOString()}`, client),
        new Promise(resolve => setTimeout(resolve, 10_000)),
      ]);
    } catch { /* extraction is best-effort */ }
  }

  await disconnectMcpServers();
  console.log(chalk.dim('\nGoodbye.\n'));
}

// ─── Basic readline UI (piped input) ───────────────────────────────────────

async function runWithBasicUI(
  agentConfig: AgentConfig,
  model: string,
  workDir: string
) {
  const { TerminalUI } = await import('../ui/terminal.js');
  const ui = new TerminalUI();
  ui.printWelcome(model, workDir);

  let lastTerminalPrompt = '';
  try {
    await interactiveSession(
      agentConfig,
      async () => {
        while (true) {
          const input = await ui.promptUser();
          if (input === null) return null;
          if (input === '') continue;
          // Handle slash commands in terminal UI
          if (input.startsWith('/') && ui.handleSlashCommand(input)) continue;
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
          if (input === '/compact') return input;
          lastTerminalPrompt = input;
          return input;
        }
      },
      (event) => ui.handleEvent(event)
    );
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
    }
  }

  ui.printGoodbye();
  flushStats();
}

// ─── Slash commands ────────────────────────────────────────────────────────

type SlashResult = string | null | 'exit';

async function handleSlashCommand(
  cmd: string,
  config: AgentConfig,
  ui?: { handleEvent: (e: import('../agent/types.js').StreamEvent) => void }
): Promise<SlashResult> {
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
        console.error(chalk.green(`  Model → ${config.model}`));
        return null;
      }
      const picked = await pickModel(config.model);
      if (picked) {
        config.model = picked;
        console.error(chalk.green(`  Model → ${config.model}`));
      }
      return null;
    }

    case '/models': {
      const picked = await pickModel(config.model);
      if (picked) {
        config.model = picked;
        console.error(chalk.green(`  Model → ${config.model}`));
      }
      return null;
    }

    case '/cost':
    case '/usage': {
      const { getStatsSummary } = await import('../stats/tracker.js');
      const { stats, saved } = getStatsSummary();
      console.error(
        chalk.dim(
          `\n  Requests: ${stats.totalRequests} | Cost: $${stats.totalCostUsd.toFixed(4)} | Saved: $${saved.toFixed(2)} vs Opus\n`
        )
      );
      return null;
    }

    case '/help':
      console.error(chalk.bold('\n  Commands:'));
      console.error('  /model [name]  — switch model (picker if no name)');
      console.error('  /models        — browse available models');
      console.error('  /cost          — session cost and savings');
      console.error('  /exit          — quit');
      console.error('  /help          — this help\n');
      console.error(
        chalk.dim('  Shortcuts: sonnet, opus, gpt, gemini, deepseek, flash, free, r1, o4\n')
      );
      return null;

    default:
      console.error(chalk.yellow(`  Unknown command: ${command}. Try /help`));
      return null;
  }
}
