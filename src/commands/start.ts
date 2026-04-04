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
import type { AgentConfig } from '../agent/types.js';

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

  // Resolve model — default to GLM-5 promo if nothing specified
  let model: string;
  const configModel = config['default-model'];
  if (options.model) {
    model = resolveModel(options.model);
  } else if (configModel) {
    model = configModel;
  } else {
    // Default: GLM-5 promo if still active, otherwise Gemini Flash (cheap & reliable)
    const promoExpiry = new Date('2026-04-15');
    model = Date.now() < promoExpiry.getTime() ? 'zai/glm-5' : 'google/gemini-2.5-flash';
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
  console.log(chalk.dim(`  Model:  ${model}`));
  console.log(chalk.dim(`  Wallet: ${walletAddress || 'not set'}`));
  console.log(chalk.dim(`  Dir:    ${workDir}`));
  // First-run tip: show if no config file exists yet
  if (!configModel && !options.model) {
    console.log(chalk.dim(`\n  Tip: /model to switch models · /compact to save tokens · /help for all commands`));
  }
  console.log('');

  // Fetch balance in background (don't block startup)
  const walletInfo: { address: string; balance: string; chain: string } = {
    address: walletAddress,
    balance: 'checking...',
    chain,
  };
  // Balance fetch callback — will update Ink UI once resolved
  let onBalanceFetched: ((bal: string) => void) | undefined;
  (async () => {
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
      const balStr = `$${bal.toFixed(2)} USDC`;
      walletInfo.balance = balStr;
      onBalanceFetched?.(balStr);
    } catch {
      const balStr = '$?.?? USDC';
      walletInfo.balance = balStr;
      onBalanceFetched?.(balStr);
    }
  })();

  // Assemble system instructions
  const systemInstructions = assembleInstructions(workDir);

  // Build capabilities
  const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities);
  const capabilities = [...allCapabilities, subAgent];

  // Agent config
  const agentConfig: AgentConfig = {
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

  // Use ink UI if TTY, fallback to basic readline for piped input
  if (process.stdin.isTTY) {
    await runWithInkUI(agentConfig, model, workDir, version, walletInfo, (cb) => {
      onBalanceFetched = cb;
    });
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

  // Wire up background balance fetch to UI
  onBalanceReady?.((bal) => ui.updateBalance(bal));

  try {
    await interactiveSession(
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
  console.log(chalk.dim('\nGoodbye.\n'));
  process.exit(0);
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
  process.exit(0);
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
