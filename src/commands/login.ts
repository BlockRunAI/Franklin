/**
 * `franklin login` — hand Franklin a prepaid BlockRun API key.
 *
 * The wallet remains Franklin's identity; a key is the second on-ramp for
 * people who would rather top up a balance at user.blockrun.ai than fund a
 * USDC wallet. Both can be configured at once — the key wins, and `--wallet`
 * on any run forces the wallet back for that invocation.
 *
 * The key is verified against the gateway before it is written, so a
 * truncated paste or a revoked key fails here rather than as a confusing 401
 * partway through a session.
 */

import chalk from 'chalk';
import { KEY_API_URL, API_KEY_FILE, DASHBOARD_URL, USER_AGENT, loadChain } from '../config.js';
import {
  clearApiKey,
  isApiKeyShaped,
  loadApiKey,
  maskApiKey,
  saveApiKey,
} from '../payments/auth-mode.js';

/**
 * GET /v1/models is free and auth-gated on the key host — 401 without a valid
 * key, 200 with one. That makes it the right probe: it proves the key works
 * without spending any of the balance it is checking.
 */
async function verifyKey(key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${KEY_API_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) return { ok: false, detail: 'gateway rejected the key (401)' };
    if (!res.ok) return { ok: false, detail: `gateway returned HTTP ${res.status}` };
    const body = (await res.json()) as { data?: unknown[] };
    const count = Array.isArray(body.data) ? body.data.length : 0;
    return { ok: true, detail: `${count} models available` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, detail: `could not reach ${KEY_API_URL} — ${msg}` };
  }
}

function printStatus(): void {
  const key = loadApiKey();
  const fromEnv = Boolean(process.env.BLOCKRUN_API_KEY?.trim());

  if (!key) {
    console.log(`Pay mode: ${chalk.magenta('wallet')} (${chalk.magenta(loadChain())})`);
    console.log(chalk.dim('\nNo API key configured. Franklin pays with the USDC wallet.'));
    console.log(chalk.dim(`Want a prepaid key instead? Sign up at ${DASHBOARD_URL}, then:`));
    console.log(chalk.dim('  franklin login brk_live_...'));
    return;
  }

  console.log(`Pay mode: ${chalk.green('api-key')}`);
  console.log(`Key:      ${chalk.cyan(maskApiKey(key))}`);
  console.log(`Source:   ${chalk.dim(fromEnv ? 'BLOCKRUN_API_KEY (env)' : API_KEY_FILE)}`);
  console.log(`Gateway:  ${chalk.dim(KEY_API_URL)}`);
  console.log(chalk.dim(`\nBalance and activity: ${DASHBOARD_URL}/dashboard`));
  console.log(chalk.dim('Force the wallet for one run with `franklin --wallet`.'));
}

export async function loginCommand(key?: string): Promise<void> {
  if (!key) {
    printStatus();
    return;
  }

  const trimmed = key.trim();
  if (!isApiKeyShaped(trimmed)) {
    console.log(chalk.red('That does not look like a BlockRun API key.'));
    console.log(chalk.dim('Expected `brk_live_...` or `brk_test_...`.'));
    console.log(chalk.dim(`Create one at ${DASHBOARD_URL}/dashboard.`));
    process.exit(1);
  }

  process.stdout.write(chalk.dim('Verifying key… '));
  const { ok, detail } = await verifyKey(trimmed);
  if (!ok) {
    console.log(chalk.red('failed'));
    console.log(chalk.red(`  ${detail}`));
    console.log(chalk.dim(`\nNothing was saved. Check the key at ${DASHBOARD_URL}/dashboard.`));
    process.exit(1);
  }
  console.log(chalk.green('ok') + chalk.dim(` — ${detail}`));

  saveApiKey(trimmed);
  console.log(`\nSaved ${chalk.cyan(maskApiKey(trimmed))} to ${chalk.dim(API_KEY_FILE)}`);
  console.log(chalk.dim('Franklin now pays from your prepaid balance instead of the wallet.'));
  console.log(chalk.dim(`Top up and watch spend at ${DASHBOARD_URL}/dashboard.`));
  console.log(chalk.dim('Your wallet is untouched — `franklin --wallet` still spends from it.'));
}

export async function logoutCommand(): Promise<void> {
  const removed = clearApiKey();
  if (!removed) {
    console.log(chalk.dim('No stored API key to remove.'));
  } else {
    console.log(`Removed ${chalk.dim(API_KEY_FILE)}.`);
  }

  if (process.env.BLOCKRUN_API_KEY?.trim()) {
    console.log(
      chalk.yellow('BLOCKRUN_API_KEY is still set in your environment — unset it to fall back to the wallet.')
    );
    return;
  }
  console.log(`Pay mode is now ${chalk.magenta('wallet')} (${chalk.magenta(loadChain())}).`);
}
