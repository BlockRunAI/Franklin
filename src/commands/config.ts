import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';

const CONFIG_FILE = path.join(BLOCKRUN_DIR, '0xcode-config.json');

const VALID_KEYS = [
  'default-model',
  'sonnet-model',
  'opus-model',
  'haiku-model',
  'smart-routing',
] as const;

type ConfigKey = (typeof VALID_KEYS)[number];

export interface AppConfig {
  'default-model'?: string;
  'sonnet-model'?: string;
  'opus-model'?: string;
  'haiku-model'?: string;
  'smart-routing'?: string;
}

export function loadConfig(): AppConfig {
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as AppConfig;
  } catch {
    return {};
  }
}

function saveConfig(config: AppConfig): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}

function isValidKey(key: string): key is ConfigKey {
  return VALID_KEYS.includes(key as ConfigKey);
}

export function configCommand(
  action: string,
  keyOrUndefined?: string,
  value?: string
) {
  if (action === 'list') {
    const config = loadConfig();
    const entries = Object.entries(config);
    if (entries.length === 0) {
      console.log(chalk.dim('No config set. Defaults will be used.'));
      console.log(
        chalk.dim(`\nConfig file: ${CONFIG_FILE}`)
      );
      return;
    }
    console.log(chalk.bold('0xcode config\n'));
    for (const [k, v] of entries) {
      console.log(`  ${chalk.cyan(k)} = ${chalk.green(v)}`);
    }
    console.log(chalk.dim(`\nConfig file: ${CONFIG_FILE}`));
    return;
  }

  if (action === 'get') {
    if (!keyOrUndefined) {
      console.log(chalk.red('Usage: 0xcode config get <key>'));
      process.exit(1);
    }
    const config = loadConfig();
    const val = config[keyOrUndefined as ConfigKey];
    if (val !== undefined) {
      console.log(val);
    } else {
      console.log(chalk.dim('(not set)'));
    }
    return;
  }

  if (action === 'set') {
    if (!keyOrUndefined || value === undefined) {
      console.log(chalk.red('Usage: 0xcode config set <key> <value>'));
      process.exit(1);
    }
    if (!isValidKey(keyOrUndefined)) {
      console.log(
        chalk.red(`Unknown config key: ${keyOrUndefined}`)
      );
      console.log(
        `Valid keys: ${VALID_KEYS.map((k) => chalk.cyan(k)).join(', ')}`
      );
      process.exit(1);
    }
    const config = loadConfig();
    config[keyOrUndefined] = value;
    saveConfig(config);
    console.log(
      `${chalk.cyan(keyOrUndefined)} = ${chalk.green(value)}`
    );
    return;
  }

  if (action === 'unset') {
    if (!keyOrUndefined) {
      console.log(chalk.red('Usage: 0xcode config unset <key>'));
      process.exit(1);
    }
    const config = loadConfig();
    delete config[keyOrUndefined as ConfigKey];
    saveConfig(config);
    console.log(chalk.dim(`Unset ${keyOrUndefined}`));
    return;
  }

  console.log(chalk.red(`Unknown action: ${action}`));
  console.log('Usage: 0xcode config <set|get|unset|list> [key] [value]');
  process.exit(1);
}
