import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';

const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const LAUNCH_AGENT_PLISTS = [
  path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.blockrun.franklin.plist'),
  path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.blockrun.runcode.plist'), // legacy
];

export async function uninitCommand() {
  let changed = false;

  // ── 1. Remove env section from ~/.claude/settings.json ──────────────────
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8')) as Record<string, unknown>;
      const env = settings.env as Record<string, string> | undefined;

      if (env) {
        const proxyKeys = [
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_AUTH_TOKEN',
          'ANTHROPIC_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        ];
        let removed = false;
        for (const k of proxyKeys) {
          if (k in env) {
            delete env[k];
            removed = true;
          }
        }
        if (Object.keys(env).length === 0) delete settings.env;
        if (removed) {
          fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
          console.log(chalk.green(`✓ Removed franklin env from ${CLAUDE_SETTINGS_FILE}`));
          changed = true;
        }
      }
    }
  } catch (e) {
    console.log(chalk.yellow(`Could not update settings.json: ${(e as Error).message}`));
  }

  // ── 2. Unload and remove LaunchAgent(s) — new + legacy ─────────────────
  if (process.platform === 'darwin') {
    for (const plist of LAUNCH_AGENT_PLISTS) {
      if (fs.existsSync(plist)) {
        try {
          const { execSync } = await import('node:child_process');
          execSync(`launchctl unload -w "${plist}"`, { stdio: 'pipe' });
        } catch { /* already unloaded */ }
        fs.unlinkSync(plist);
        console.log(chalk.green(`✓ Removed LaunchAgent: ${path.basename(plist)}`));
        changed = true;
      }
    }
  }

  if (!changed) {
    console.log(chalk.dim('Nothing to uninit — franklin was not initialized.'));
  } else {
    console.log('');
    console.log(chalk.bold('franklin uninitialized.'));
    console.log(`CLI agents will use their default Anthropic API settings again.`);
    console.log(`Run ${chalk.bold('franklin daemon stop')} to stop any running proxy.`);
  }
}
