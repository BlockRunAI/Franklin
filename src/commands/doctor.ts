/**
 * `franklin doctor` — one-command health check.
 *
 * The single highest-leverage onboarding improvement: most early failures
 * are environmental (Node too old, no wallet, wrong chain, unreachable
 * gateway, malformed MCP config). `franklin doctor` pokes each of those in
 * sequence, prints a verdict per check, and exits non-zero if anything is
 * broken so CI scripts can gate on it.
 *
 * Human-readable by default. Pass `--json` for machine-parseable output
 * (useful for the ink REPL `/doctor` or external monitoring).
 */

import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  setupAgentWallet,
  setupAgentSolanaWallet,
} from '@blockrun/llm';
import { loadChain, API_URLS, VERSION, BLOCKRUN_DIR } from '../config.js';
import { isTelemetryEnabled, readAllRecords, telemetryPaths } from '../telemetry/store.js';
import { getAvailableUpdate, kickoffVersionCheck } from '../version-check.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  remedy?: string;
}

export async function runChecks(): Promise<Check[]> {
  const out: Check[] = [];

  // ── 1. Runtime ────────────────────────────────────────────────────
  const nodeVer = process.versions.node;
  const nodeMajor = parseInt(nodeVer.split('.')[0], 10);
  out.push({
    name: 'Node.js',
    status: nodeMajor >= 20 ? 'ok' : 'fail',
    detail: `${nodeVer}${nodeMajor >= 20 ? '' : ' — require >= 20'}`,
    remedy: nodeMajor >= 20 ? undefined : 'Upgrade Node.js: https://nodejs.org',
  });

  // ── 2. Franklin version ───────────────────────────────────────────
  // Kick the daily cache refresh so subsequent doctor runs carry fresh
  // data. Current run uses whatever's already cached.
  kickoffVersionCheck();
  const update = getAvailableUpdate();
  out.push({
    name: 'Franklin',
    status: update ? 'warn' : 'ok',
    detail: update
      ? `v${VERSION} — update available: v${update.latest}`
      : `v${VERSION}`,
    remedy: update ? 'npm install -g @blockrun/franklin@latest' : undefined,
  });

  // ── 3. BLOCKRUN_DIR writable ──────────────────────────────────────
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    const probe = path.join(BLOCKRUN_DIR, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    out.push({
      name: 'Config directory',
      status: 'ok',
      detail: BLOCKRUN_DIR,
    });
  } catch (err) {
    out.push({
      name: 'Config directory',
      status: 'fail',
      detail: `${BLOCKRUN_DIR} — ${(err as Error).message}`,
      remedy: `Check permissions on ${BLOCKRUN_DIR} or unset HOME override`,
    });
  }

  // ── 4. Chain configuration ────────────────────────────────────────
  let chain: 'base' | 'solana' | null = null;
  try {
    chain = loadChain();
    out.push({
      name: 'Chain',
      status: 'ok',
      detail: chain,
    });
  } catch (err) {
    out.push({
      name: 'Chain',
      status: 'fail',
      detail: `failed to load — ${(err as Error).message}`,
      remedy: 'Run: franklin setup base  (or: franklin setup solana)',
    });
  }

  // ── 5. Wallet ─────────────────────────────────────────────────────
  let walletBalance: number | null = null;
  let walletAddress = '';
  if (chain) {
    try {
      if (chain === 'solana') {
        const client = await setupAgentSolanaWallet({ silent: true });
        walletAddress = await client.getWalletAddress();
        walletBalance = await client.getBalance();
      } else {
        const client = setupAgentWallet({ silent: true });
        walletAddress = client.getWalletAddress();
        walletBalance = await client.getBalance();
      }
      out.push({
        name: 'Wallet',
        status: 'ok',
        detail: `${walletAddress.slice(0, 10)}…${walletAddress.slice(-6)}`,
      });
      out.push({
        name: 'USDC balance',
        status: walletBalance > 0 ? 'ok' : 'warn',
        detail: `$${walletBalance.toFixed(2)}${walletBalance === 0 ? ' — free-tier models only' : ''}`,
        remedy: walletBalance === 0
          ? `Send USDC on ${chain} to ${walletAddress} to unlock paid models`
          : undefined,
      });
    } catch (err) {
      const msg = (err as Error).message || '';
      out.push({
        name: 'Wallet',
        status: 'fail',
        detail: `error — ${msg.slice(0, 120)}`,
        remedy:
          msg.includes('ENOENT') || msg.includes('wallet') || msg.includes('key')
            ? 'Run: franklin setup'
            : 'Check network / wallet file permissions',
      });
    }
  }

  // ── 6. Gateway reachability ───────────────────────────────────────
  if (chain) {
    const apiUrl = API_URLS[chain];
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(`${apiUrl}/health`, { signal: ctl.signal }).catch(() => null);
      clearTimeout(t);
      if (res && res.ok) {
        out.push({
          name: 'Gateway',
          status: 'ok',
          detail: apiUrl,
        });
      } else {
        // Fall back to a HEAD on the messages endpoint — some deployments
        // don't expose /health but the API is up.
        const ctl2 = new AbortController();
        const t2 = setTimeout(() => ctl2.abort(), 5000);
        const res2 = await fetch(`${apiUrl}/v1/messages`, {
          method: 'HEAD',
          signal: ctl2.signal,
        }).catch(() => null);
        clearTimeout(t2);
        out.push({
          name: 'Gateway',
          status: res2 ? 'ok' : 'fail',
          detail: res2 ? apiUrl : `unreachable: ${apiUrl}`,
          remedy: res2 ? undefined : 'Check network or try the other chain',
        });
      }
    } catch (err) {
      out.push({
        name: 'Gateway',
        status: 'fail',
        detail: `${apiUrl} — ${(err as Error).message}`,
      });
    }
  }

  // ── 7. MCP config ─────────────────────────────────────────────────
  const mcpPath = path.join(BLOCKRUN_DIR, 'mcp.json');
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, 'utf-8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const count = Object.keys(parsed.mcpServers || {}).length;
      out.push({
        name: 'MCP servers',
        status: 'ok',
        detail: `${count} configured in ${mcpPath}`,
      });
    } catch (err) {
      out.push({
        name: 'MCP servers',
        status: 'warn',
        detail: `${mcpPath} has invalid JSON — ${(err as Error).message}`,
        remedy: `Fix or delete ${mcpPath}`,
      });
    }
  } else {
    out.push({
      name: 'MCP servers',
      status: 'ok',
      detail: 'none configured',
    });
  }

  // ── 8. Telemetry ──────────────────────────────────────────────────
  const telEnabled = isTelemetryEnabled();
  if (telEnabled) {
    const records = readAllRecords();
    out.push({
      name: 'Telemetry',
      status: 'ok',
      detail: `enabled — ${records.length} session${records.length === 1 ? '' : 's'} recorded`,
    });
  } else {
    out.push({
      name: 'Telemetry',
      status: 'ok',
      detail: 'disabled (default)',
    });
  }

  // ── 9. Shell / PATH hint ──────────────────────────────────────────
  const which = process.env.PATH || '';
  const hasHomebrew = which.includes('/opt/homebrew/bin') || which.includes('/usr/local/bin');
  if (os.platform() === 'darwin' && !hasHomebrew) {
    out.push({
      name: 'PATH',
      status: 'warn',
      detail: 'Homebrew paths not in PATH',
      remedy: 'Add /opt/homebrew/bin to PATH in ~/.zshrc',
    });
  }

  return out;
}

function printHuman(checks: Check[]): void {
  console.log(chalk.bold('\n  franklin doctor\n'));
  for (const c of checks) {
    const icon =
      c.status === 'ok' ? chalk.green('✓') :
      c.status === 'warn' ? chalk.yellow('⚠') :
      chalk.red('✗');
    console.log(`  ${icon}  ${c.name.padEnd(18)} ${chalk.dim(c.detail)}`);
    if (c.remedy) {
      console.log(`     ${chalk.dim('↳')} ${chalk.yellow(c.remedy)}`);
    }
  }

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  console.log();
  if (fails > 0) {
    console.log(chalk.red(`  ${fails} check${fails === 1 ? '' : 's'} failed. See remedies above.`));
  } else if (warns > 0) {
    console.log(chalk.yellow(`  All criticals ok. ${warns} warning${warns === 1 ? '' : 's'} above — safe to ignore for now.`));
  } else {
    console.log(chalk.green('  All clear. Ready to run: franklin'));
  }
  console.log();
}

export async function doctorCommand(opts: { json?: boolean } = {}): Promise<void> {
  const checks = await runChecks();
  if (opts.json) {
    const fails = checks.filter(c => c.status === 'fail').length;
    process.stdout.write(JSON.stringify({ checks, healthy: fails === 0 }, null, 2) + '\n');
    process.exit(fails > 0 ? 1 : 0);
  }
  printHuman(checks);
  const fails = checks.filter(c => c.status === 'fail').length;
  process.exit(fails > 0 ? 1 : 0);
}
