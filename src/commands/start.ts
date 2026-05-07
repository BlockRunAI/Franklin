import chalk from 'chalk';
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { loadChain, API_URLS } from '../config.js';
import { retryFetchBalance } from './balance-retry.js';
import { flushStats, loadStats } from '../stats/tracker.js';
import { OPUS_PRICING, MODEL_PRICING } from '../pricing.js';
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
import type { AgentConfig, Dialogue, StreamTurnDone } from '../agent/types.js';

interface StartOptions {
  model?: string;
  debug?: boolean;
  trust?: boolean;
  version?: string;
  /** Start a new Franklin session seeded from another agent's saved context. */
  from?: string;
  /** Optional external agent session id/path for --from. If omitted, show a picker. */
  fromSessionId?: string;
  /** Resume: explicit session ID, or true for "most recent in cwd", or 'picker' to prompt */
  resume?: string | boolean | 'picker';
  /** Continue: resume most recent session matching the current working directory */
  continue?: boolean;
  /** Hard USD cap on total session spend. Stops the loop when exceeded. */
  maxSpend?: string | number;
  /** Run a single prompt non-interactively, then exit. For batch/scripted use. */
  prompt?: string;
}

export async function startCommand(options: StartOptions) {
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
      } else {
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
  let continueResolvedId: string | undefined;
  if (options.continue && !options.resume) {
    const { findLatestSessionForDir } = await import('../ui/session-picker.js');
    continueResolvedId = findLatestSessionForDir(process.cwd())?.id;
  }

  // Sessions are wallet-bound: the conversation, audit trail, and tool
  // results live on whichever chain the session was started on. If
  // we're resuming, prefer the session's recorded chain over the
  // persisted default — `franklin solana` / `franklin base` shortcuts
  // mutate that default, and a debug invocation between restarts
  // shouldn't be able to silently move the user to a different wallet.
  // Only sessions created in 3.15.35+ have the field; older sessions
  // fall back to the persisted default (matches pre-3.15.35 behavior).
  let chain = loadChain();
  const resumeIdEarly =
    (typeof options.resume === 'string' && options.resume !== 'picker') ? options.resume
    : continueResolvedId;
  if (resumeIdEarly) {
    const { loadSessionMeta } = await import('../session/storage.js');
    const sessMeta = loadSessionMeta(resumeIdEarly);
    if (sessMeta?.chain && sessMeta.chain !== chain) {
      console.log(chalk.dim(`  Restoring session's chain: ${sessMeta.chain} (default was ${chain}; session is wallet-bound to ${sessMeta.chain})`));
      chain = sessMeta.chain;
    } else if (sessMeta?.chain) {
      chain = sessMeta.chain;
    }
  }
  const apiUrl = API_URLS[chain];
  const config = loadConfig();

  // Resolve model. Priority: explicit --model > resumed session's model > user
  // config default > FREE default. Resuming restores the same model the user was
  // on last time so the environment feels continuous. Explicit --model still wins
  // so users can cheaply retry a paid session on a free model.
  let model: string;
  const configModel = config['default-model'];
  let resumedSessionModel: string | undefined;
  const modelSourceId =
    (typeof options.resume === 'string' && options.resume !== 'picker') ? options.resume
    : continueResolvedId;
  if (modelSourceId) {
    const { loadSessionMeta } = await import('../session/storage.js');
    resumedSessionModel = loadSessionMeta(modelSourceId)?.model;
  }
  if (options.model) {
    model = resolveModel(options.model);
  } else if (resumedSessionModel && resumedSessionModel !== 'unknown') {
    model = resumedSessionModel;
  } else if (configModel) {
    model = configModel;
  } else {
    // Default: blockrun/auto — the LLM router (v3.8.16) picks a model per
    // prompt. SIMPLE questions route to cheap/fast models (gemini-flash,
    // kimi); COMPLEX / REASONING to Sonnet 4.6 / Opus 4.7. Cost fallback
    // to free models on 402 is handled in the agent loop, so an unfunded
    // wallet still works — it just degrades to the free tier mid-session
    // instead of starting there. Much better first-turn quality than the
    // old nvidia-nemotron default, which stubbed tool use.
    model = 'blockrun/auto';
  }

  let workDir = process.cwd();

  let importedKickoffPrompt: string | undefined;
  if (options.from) {
    const { importExternalSessionAsFranklin, parseExternalAgentSource } = await import('../session/from-import.js');
    const source = parseExternalAgentSource(options.from);
    if (!source) {
      console.error(chalk.red(`Unknown --from source: ${options.from}`));
      console.error(chalk.dim('Supported sources: claude, codex'));
      process.exitCode = 1;
      return;
    }

    try {
      const imported = await importExternalSessionAsFranklin(source, options.fromSessionId, { model, workDir });
      if (imported.imported.cwd) {
        try {
          process.chdir(imported.imported.cwd);
          workDir = process.cwd();
        } catch {
          // Keep the caller's cwd if the source session directory no longer exists.
        }
      }
      options.resume = imported.sessionId;
      options.continue = false;
      importedKickoffPrompt = [
        `Continue from the imported ${source} handoff context.`,
        'Briefly explain what you understand the previous session was working on, what state it appears to be in, and the most likely next step.',
        'Do not claim you resumed or modified the source agent session. This is a new Franklin session with imported context awareness.',
        'If the next action is clear, offer to proceed; if it is not clear, ask one concise question.',
      ].join('\n');
      console.log(chalk.green(`  Imported ${source} context into Franklin session ${imported.sessionId.slice(0, 24)}…`));
      console.log(chalk.dim(`  Source session: ${imported.imported.id}`));
      if (imported.imported.cwd) console.log(chalk.dim(`  Dir: ${workDir}`));
      console.log('');
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
      return;
    }
  }

  // --prompt batch mode: skip all interactive startup UI/side effects so
  // stdout stays clean for scripts and one-shot callers. Keep the capability surface to the
  // built-ins only — no panel, no MCP autoconnect, no wallet/banner chatter.
  if (options.prompt) {
    if (options.resume === true || options.resume === 'picker') {
      console.error(chalk.red('`--prompt` requires `--resume` to include an explicit session id.'));
      process.exitCode = 1;
      return;
    }

    const systemInstructions = assembleInstructions(workDir, model);
    const subAgent = createSubAgentCapability(apiUrl, chain, allCapabilities, model);
    const { registerMoAConfig } = await import('../tools/moa.js');
    registerMoAConfig(apiUrl, chain, model);
    const capabilities = [...allCapabilities, subAgent];

    if (options.debug) {
      const issues = validateToolDescriptions(capabilities);
      for (const issue of issues) {
        console.error(`[validate] ${issue.severity}: ${issue.toolName} — ${issue.issue}`);
      }
    }

    const agentConfig: AgentConfig = {
      model,
      apiUrl,
      chain,
      systemInstructions,
      capabilities,
      maxTurns: 100,
      workingDir: workDir,
      permissionMode: 'trust',
      debug: options.debug,
      showPrefetchStatus: false,
      resumeSessionId:
        (typeof options.resume === 'string' && options.resume !== 'picker')
          ? options.resume
          : continueResolvedId,
      ...(options.maxSpend != null
        ? { maxSpendUsd: Number(options.maxSpend) }
        : {}),
    };

    const exitCode = await runOneShot(agentConfig, options.prompt);
    flushStats();
    process.exitCode = exitCode;
    return;
  }

  // Warn when a paid model is active so users know they'll be charged.
  // Derive "free" from MODEL_PRICING so adding a new free entry there is enough —
  // no second hardcoded list to keep in sync.
  const pricing = MODEL_PRICING[model];
  const isFree = pricing != null && pricing.input === 0 && pricing.output === 0 && (pricing.perCall ?? 0) === 0;
  if (!isFree) {
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
  } else {
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
    } catch { /* migration is optional */ }
  }

  printBanner(version);
  // Auto-start panel in background unless explicitly disabled.
  // Binds loopback-only (wallet secrets on /api/wallet/secret — never expose on LAN).
  let panelUrl: string | undefined;
  if (process.env.FRANKLIN_PANEL_AUTOSTART !== '0') {
    panelUrl = await startPanelBackground(3100);
  }

  // Session info — aligned, minimal. Model + balance live in the input bar below.
  // Full wallet address is shown so the user can copy-paste it to fund the wallet.
  console.log(chalk.dim('  Wallet:    ') + (walletAddress || chalk.yellow('not set')));
  console.log(chalk.dim('  Dir:       ') + workDir);
  console.log(chalk.dim('  Dashboard: ') + (panelUrl ? chalk.cyan(panelUrl) : chalk.cyan('franklin panel') + chalk.dim(' → http://localhost:3100')));
  console.log(chalk.dim('  Help:      ') + chalk.cyan('/help'));
  console.log('');

  // Balance fetcher — used at startup and after each turn.
  //
  // Some wallet client paths return 0 transiently (chain provider not yet
  // initialized, RPC dust race). Without a defensive retry the UI's status
  // bar locks at $0.00 USDC for the rest of the session even after the wallet
  // is provably non-empty. retryFetchBalance does one extra round-trip on a
  // zero result; genuinely empty wallets still resolve to $0.00 quickly.
  const fetchBalance = async (): Promise<string> => {
    try {
      const bal = await retryFetchBalance(async () => {
        if (chain === 'solana') {
          const { setupAgentSolanaWallet } = await import('@blockrun/llm');
          const client = await setupAgentSolanaWallet({ silent: true });
          return client.getBalance();
        }
        const { setupAgentWallet } = await import('@blockrun/llm');
        const client = setupAgentWallet({ silent: true });
        return client.getBalance();
      });
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
  const systemInstructions = assembleInstructions(workDir, model);

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
  let resumeSessionId: string | undefined;
  if (options.resume || options.continue) {
    const { pickSession } = await import('../ui/session-picker.js');
    const { loadSessionMeta, loadSessionHistory } = await import('../session/storage.js');

    if (typeof options.resume === 'string' && options.resume !== 'picker') {
      // Explicit ID — already validated above
      resumeSessionId = options.resume;
    } else if (options.continue) {
      if (!continueResolvedId) {
        console.error(chalk.yellow(`  No prior session found in ${workDir} — starting a new one.`));
      } else {
        resumeSessionId = continueResolvedId;
      }
    } else {
      // --resume with no value → interactive picker
      const picked = await pickSession({ workDir });
      if (!picked) {
        console.error(chalk.dim('  No session picked — starting a new one.'));
      } else {
        resumeSessionId = picked;
      }
    }

    if (resumeSessionId) {
      const meta = loadSessionMeta(resumeSessionId);
      const history = loadSessionHistory(resumeSessionId);
      const when = meta ? new Date(meta.updatedAt).toLocaleString() : 'unknown';
      console.log(chalk.green(`  Resuming session ${resumeSessionId.slice(0, 24)}…`));
      console.log(chalk.dim(`  ${history.length} messages · last active ${when}`));
      const preview = formatResumePreview(history);
      if (preview) console.log(preview);
      console.log('');
    }
  }

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
    // --prompt is also scripted; batch callers never see a TTY.
    permissionMode: (options.trust || options.prompt || !process.stdin.isTTY) ? 'trust' : 'default',
    debug: options.debug,
    showPrefetchStatus: process.stdin.isTTY,
    resumeSessionId,
    ...(options.maxSpend != null
      ? { maxSpendUsd: Number(options.maxSpend) }
      : {}),
  };

  // Bootstrap learnings from existing CLAUDE.md on first run (async, non-blocking)
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
    }, fetchBalance, importedKickoffPrompt);
  } else {
    await runWithBasicUI(agentConfig, model, workDir, importedKickoffPrompt);
  }
}

// ─── One-shot mode (franklin --prompt "...") ──────────────────────────────
// Used by batch/scripted callers. Non-interactive, prints text deltas to
// stdout as they stream, honors --max-spend, exits non-zero for any
// non-completed terminal state.
export function oneShotExitCodeForTurnReason(reason: StreamTurnDone['reason']): number {
  return reason === 'completed' ? 0 : 1;
}

async function runOneShot(agentConfig: AgentConfig, prompt: string): Promise<number> {
  let delivered = false;
  let exitCode = 0;
  const getInput = async () => {
    if (delivered) return null;
    delivered = true;
    return prompt;
  };
  await interactiveSession(agentConfig, getInput, (event) => {
    if (event.kind === 'text_delta') {
      process.stdout.write(event.text);
    } else if (event.kind === 'turn_done') {
      exitCode = oneShotExitCodeForTurnReason(event.reason);
      process.stdout.write('\n');
    }
  });
  return exitCode;
}

function formatResumePreview(history: Dialogue[]): string {
  const entries = history
    .map((msg) => {
      const text = extractVisibleText(msg).replace(/\s+/g, ' ').trim();
      if (!text) return null;
      return { role: msg.role, text: text.length > 180 ? `${text.slice(0, 177)}...` : text };
    })
    .filter((entry): entry is { role: 'user' | 'assistant'; text: string } => entry !== null);

  if (entries.length === 0) return '';

  const render = (entry: { role: 'user' | 'assistant'; text: string }) => {
    const label = entry.role === 'user' ? 'you' : 'assistant';
    return chalk.dim(`  ${label}: ${entry.text}`);
  };

  const started = entries.slice(0, 4).map(render);
  const recentStart = entries.length > 10 ? -6 : 4;
  const recent = entries.slice(recentStart).map(render);

  const lines = [chalk.dim('  Context preview:'), ...started];
  if (recent.length > 0) {
    if (entries.length > 10) lines.push(chalk.dim('  ...'));
    lines.push(...recent);
  }

  return lines.join('\n');
}

function extractVisibleText(msg: Dialogue): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';

  return msg.content
    .map((part) => {
      if ('type' in part && part.type === 'text') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
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
  initialInput?: string,
) {
  const startSnapshot = snapshotStats();
  const ui = launchInkUI({
    model,
    workDir,
    version,
    walletAddress: walletInfo?.address,
    walletBalance: walletInfo?.balance,
    chain: walletInfo?.chain,
    onModelChange: (newModel: string, reason?: 'user' | 'system') => {
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
  let deliveredInitialInput = false;
  try {
    sessionHistory = await interactiveSession(
      agentConfig,
      async () => {
        if (initialInput && !deliveredInitialInput) {
          deliveredInitialInput = true;
          return initialInput;
        }
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

  // Opt-in telemetry — no-op unless user has run `franklin telemetry enable`.
  // Appends a sanitized session summary to ~/.blockrun/telemetry.jsonl.
  try {
    const { recordLatestSessionIfEnabled } = await import('../telemetry/store.js');
    recordLatestSessionIfEnabled(process.cwd(), agentConfig.chain);
  } catch { /* telemetry is best-effort */ }

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
    } catch { /* extraction is best-effort */ }
  }

  await disconnectMcpServers();

  // Session summary — delta vs. snapshot at session start
  try {
    const delta = statsDelta(startSnapshot);
    if (delta.requests > 0) {
      const cost = delta.cost.toFixed(4);
      const savedStr = delta.saved > 0.001 ? ` · saved $${delta.saved.toFixed(2)} vs Opus` : '';
      const tokens = `${(delta.inputTokens / 1000).toFixed(0)}k in / ${(delta.outputTokens / 1000).toFixed(0)}k out`;
      console.log(chalk.dim(`\n  Session: ${delta.requests} requests · $${cost} USDC${savedStr} · ${tokens}`));
    } else {
      console.log(chalk.dim('\n  Session: 0 requests · no spend'));
    }
  } catch { /* stats unavailable */ }

  console.log(chalk.dim('\nGoodbye.\n'));
}

// ─── Basic readline UI (piped input) ───────────────────────────────────────

async function runWithBasicUI(
  agentConfig: AgentConfig,
  model: string,
  workDir: string,
  initialInput?: string,
) {
  const { TerminalUI } = await import('../ui/terminal.js');
  const ui = new TerminalUI();
  ui.printWelcome(model, workDir);
  const startSnapshot = snapshotStats();

  let lastTerminalPrompt = '';
  let deliveredInitialInput = false;
  try {
    await interactiveSession(
      agentConfig,
      async () => {
        if (initialInput && !deliveredInitialInput) {
          deliveredInitialInput = true;
          lastTerminalPrompt = initialInput;
          return initialInput;
        }
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

  // Session summary for piped mode
  try {
    const delta = statsDelta(startSnapshot);
    if (delta.requests > 0) {
      const cost = delta.cost.toFixed(4);
      const savedStr = delta.saved > 0.001 ? ` · saved $${delta.saved.toFixed(2)} vs Opus` : '';
      const tokens = `${(delta.inputTokens / 1000).toFixed(0)}k in / ${(delta.outputTokens / 1000).toFixed(0)}k out`;
      console.error(`Session: ${delta.requests} requests · $${cost} USDC${savedStr} · ${tokens}`);
    }
  } catch { /* stats unavailable */ }

  ui.printGoodbye();
  flushStats();
}

// ─── Panel auto-start ──────────────────────────────────────────────────────

async function startPanelBackground(startPort: number): Promise<string | undefined> {
  const MAX_ATTEMPTS = 20;
  try {
    const { createPanelServer } = await import('../panel/server.js');
    return await new Promise<string | undefined>((resolve) => {
      const tryListen = (port: number, attempt: number) => {
        const server = createPanelServer(port);
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attempt < MAX_ATTEMPTS) {
            tryListen(port + 1, attempt + 1);
            return;
          }
          resolve(undefined);
        });
        server.listen(port, '127.0.0.1', () => {
          server.unref?.();
          resolve(`http://localhost:${port}`);
        });
      };
      tryListen(startPort, 0);
    });
  } catch {
    return undefined;
  }
}

// ─── Per-session stats delta ───────────────────────────────────────────────
// The stats tracker persists lifetime totals. For the exit summary we want
// just what this session spent, so we snapshot at start and diff at exit.

interface StatsSnapshot {
  requests: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

function snapshotStats(): StatsSnapshot {
  try {
    const s = loadStats();
    return {
      requests: s.totalRequests,
      cost: s.totalCostUsd,
      inputTokens: s.totalInputTokens,
      outputTokens: s.totalOutputTokens,
    };
  } catch {
    return { requests: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
  }
}

function statsDelta(before: StatsSnapshot): StatsSnapshot & { saved: number } {
  const now = loadStats();
  const requests = Math.max(0, now.totalRequests - before.requests);
  const cost = Math.max(0, now.totalCostUsd - before.cost);
  const inputTokens = Math.max(0, now.totalInputTokens - before.inputTokens);
  const outputTokens = Math.max(0, now.totalOutputTokens - before.outputTokens);
  const opusCost =
    (inputTokens / 1_000_000) * OPUS_PRICING.input +
    (outputTokens / 1_000_000) * OPUS_PRICING.output;
  return { requests, cost, inputTokens, outputTokens, saved: Math.max(0, opusCost - cost) };
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
