import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';
const CONFIG_FILE = path.join(BLOCKRUN_DIR, 'runcode-config.json');
const VALID_KEYS = [
    'default-model',
    'sonnet-model',
    'opus-model',
    'haiku-model',
    'smart-routing',
];
export function loadConfig() {
    try {
        const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return {};
    }
}
function saveConfig(config) {
    try {
        fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
            mode: 0o600,
        });
    }
    catch (err) {
        console.error(chalk.red(`Failed to save config: ${err.message}`));
        process.exit(1);
    }
}
function isValidKey(key) {
    return VALID_KEYS.includes(key);
}
export function configCommand(action, keyOrUndefined, value) {
    if (action === 'list') {
        const config = loadConfig();
        const entries = Object.entries(config);
        if (entries.length === 0) {
            console.log(chalk.dim('No config set. Defaults will be used.'));
            console.log(chalk.dim(`\nConfig file: ${CONFIG_FILE}`));
            return;
        }
        console.log(chalk.bold('runcode config\n'));
        for (const [k, v] of entries) {
            console.log(`  ${chalk.cyan(k)} = ${chalk.green(v)}`);
        }
        console.log(chalk.dim(`\nConfig file: ${CONFIG_FILE}`));
        return;
    }
    if (action === 'get') {
        if (!keyOrUndefined) {
            console.log(chalk.red('Usage: runcode config get <key>'));
            process.exit(1);
        }
        const config = loadConfig();
        const val = config[keyOrUndefined];
        if (val !== undefined) {
            console.log(val);
        }
        else {
            console.log(chalk.dim('(not set)'));
        }
        return;
    }
    if (action === 'set') {
        if (!keyOrUndefined || value === undefined) {
            console.log(chalk.red('Usage: runcode config set <key> <value>'));
            process.exit(1);
        }
        if (!isValidKey(keyOrUndefined)) {
            console.log(chalk.red(`Unknown config key: ${keyOrUndefined}`));
            console.log(`Valid keys: ${VALID_KEYS.map((k) => chalk.cyan(k)).join(', ')}`);
            process.exit(1);
        }
        const config = loadConfig();
        config[keyOrUndefined] = value;
        saveConfig(config);
        console.log(`${chalk.cyan(keyOrUndefined)} = ${chalk.green(value)}`);
        return;
    }
    if (action === 'unset') {
        if (!keyOrUndefined) {
            console.log(chalk.red('Usage: runcode config unset <key>'));
            process.exit(1);
        }
        if (!isValidKey(keyOrUndefined)) {
            console.log(chalk.red(`Unknown config key: ${keyOrUndefined}`));
            console.log(`Valid keys: ${VALID_KEYS.map((k) => chalk.cyan(k)).join(', ')}`);
            process.exit(1);
        }
        const config = loadConfig();
        delete config[keyOrUndefined];
        saveConfig(config);
        console.log(chalk.dim(`Unset ${keyOrUndefined}`));
        return;
    }
    console.log(chalk.red(`Unknown action: ${action}`));
    console.log('Usage: runcode config <set|get|unset|list> [key] [value]');
    process.exit(1);
}
