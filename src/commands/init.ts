import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { DEFAULT_PROXY_PORT } from '../config.js';

const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const LAUNCH_AGENT_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LAUNCH_AGENT_PLIST = path.join(LAUNCH_AGENT_DIR, 'ai.blockrun.franklin.plist');
const LEGACY_LAUNCH_AGENT_PLIST = path.join(LAUNCH_AGENT_DIR, 'ai.blockrun.runcode.plist');

export async function initCommand(options: { port?: string }) {
  const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(chalk.red(`Error: invalid port "${options.port}". Must be 1-65535. Default: ${DEFAULT_PROXY_PORT}`));
    process.exit(1);
  }

  // ── 1. Write ~/.claude/settings.json ────────────────────────────────────
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8'));
    }
  } catch {
    console.log(chalk.yellow(`  Warning: could not parse ${CLAUDE_SETTINGS_FILE}, starting fresh.`));
  }

  settings.env = {
    ...(settings.env as Record<string, string> | undefined ?? {}),
    ANTHROPIC_BASE_URL: `http://localhost:${port}/api`,
    ANTHROPIC_AUTH_TOKEN: 'x402-proxy-handles-auth',
    ANTHROPIC_MODEL: 'blockrun/auto',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-4.6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5-20251001',
  };

  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
  console.log(chalk.green(`✓ Configured ${CLAUDE_SETTINGS_FILE}`));

  // ── 2. Install macOS LaunchAgent (auto-start on login) ─────────────────
  if (process.platform === 'darwin') {
    // Clean up legacy runcode LaunchAgent if present
    if (fs.existsSync(LEGACY_LAUNCH_AGENT_PLIST)) {
      try {
        const { execSync } = await import('node:child_process');
        execSync(`launchctl unload -w "${LEGACY_LAUNCH_AGENT_PLIST}"`, { stdio: 'pipe' });
      } catch { /* may not be loaded */ }
      try { fs.unlinkSync(LEGACY_LAUNCH_AGENT_PLIST); } catch { /* best effort */ }
    }

    let franklinBin = '';
    try {
      const { execSync } = await import('node:child_process');
      franklinBin = execSync('which franklin', { encoding: 'utf-8' }).trim();
    } catch {
      // Fall back to legacy binary name
      try {
        const { execSync } = await import('node:child_process');
        franklinBin = execSync('which runcode', { encoding: 'utf-8' }).trim();
      } catch {
        console.log(chalk.yellow('  Warning: franklin not found in PATH — LaunchAgent not installed.'));
      }
    }

    if (franklinBin) {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.blockrun.franklin</string>
  <key>ProgramArguments</key>
  <array>
    <string>${franklinBin}</string>
    <string>proxy</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${os.homedir()}/.blockrun/franklin-debug.log</string>
  <key>StandardErrorPath</key>
  <string>${os.homedir()}/.blockrun/franklin-debug.log</string>
</dict>
</plist>`;

      fs.mkdirSync(LAUNCH_AGENT_DIR, { recursive: true });
      fs.writeFileSync(LAUNCH_AGENT_PLIST, plist);

      try {
        const { execSync } = await import('node:child_process');
        execSync(`launchctl load -w "${LAUNCH_AGENT_PLIST}"`, { stdio: 'pipe' });
        console.log(chalk.green(`✓ LaunchAgent installed — franklin proxy starts automatically on login`));
      } catch {
        console.log(chalk.dim(`  LaunchAgent written to ${LAUNCH_AGENT_PLIST}`));
        console.log(chalk.dim(`  Load manually: launchctl load -w "${LAUNCH_AGENT_PLIST}"`));
      }
    }
  }

  // ── 3. Start daemon now ──────────────────────────────────────────────────
  console.log('');
  console.log(chalk.bold('franklin initialized (proxy mode for Claude Code).'));
  console.log(`Run ${chalk.bold('franklin daemon start')} to start the background proxy now.`);
  console.log(`Then just run ${chalk.bold('claude')} — franklin proxy handles payments automatically.`);
  console.log('');
  console.log(chalk.dim('Or use franklin directly: franklin start'));
  console.log(chalk.dim('Note: Claude Code will ask you to trust the proxy URL once.'));
}
