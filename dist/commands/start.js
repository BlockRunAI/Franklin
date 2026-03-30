import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { createProxy } from '../proxy/server.js';
import { loadChain, API_URLS, DEFAULT_PROXY_PORT } from '../config.js';
import { loadConfig } from './config.js';
import { printBanner } from '../banner.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _version = '0.9.0';
try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));
    _version = pkg.version || _version;
}
catch { /* use default */ }
/** Find the claude binary, checking common install locations */
function findClaude() {
    try {
        const which = execSync('which claude 2>/dev/null || where claude 2>/dev/null', {
            encoding: 'utf-8',
        }).trim();
        if (which)
            return which.split('\n')[0];
    }
    catch { /* not in PATH */ }
    // Check common install locations
    const os = process.platform;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const candidates = [
        `${home}/.local/bin/claude`,
        `${home}/.npm-global/bin/claude`,
        '/usr/local/bin/claude',
        ...(os === 'win32' ? [`${process.env.APPDATA}\\npm\\claude.cmd`] : []),
    ];
    for (const p of candidates) {
        try {
            execSync(`"${p}" --version`, { encoding: 'utf-8', stdio: 'pipe' });
            return p;
        }
        catch { /* not here */ }
    }
    return null;
}
export async function startCommand(options) {
    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    const fallbackEnabled = options.fallback !== false; // Default true
    const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));
    if (isNaN(port) || port < 1 || port > 65535) {
        console.log(chalk.red(`Invalid port: ${options.port}. Must be 1-65535.`));
        process.exit(1);
    }
    if (chain === 'solana') {
        const wallet = await getOrCreateSolanaWallet();
        if (wallet.isNew) {
            console.log(chalk.yellow('No Solana wallet found — created a new one.'));
            console.log(`Address: ${chalk.cyan(wallet.address)}`);
            console.log(`\nSend USDC on Solana to this address, then run ${chalk.bold('brcc start')} again.\n`);
            return;
        }
        const shouldLaunch = options.launch !== false;
        const model = options.model;
        printBanner(_version);
        console.log(`Chain:    ${chalk.magenta('solana')}`);
        console.log(`Wallet:   ${chalk.cyan(wallet.address)}`);
        if (model)
            console.log(`Model:    ${chalk.green(model)}`);
        console.log(`Fallback: ${fallbackEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
        console.log(`Proxy:    ${chalk.cyan(`http://localhost:${port}`)}`);
        console.log(`Backend:  ${chalk.dim(apiUrl)}\n`);
        const server = createProxy({
            port,
            apiUrl,
            chain: 'solana',
            modelOverride: model,
            debug: options.debug,
            fallbackEnabled,
        });
        launchServer(server, port, shouldLaunch, model, options.debug);
    }
    else {
        const wallet = getOrCreateWallet();
        if (wallet.isNew) {
            console.log(chalk.yellow('No wallet found — created a new one.'));
            console.log(`Address: ${chalk.cyan(wallet.address)}`);
            console.log(`\nSend USDC on Base to this address, then run ${chalk.bold('brcc start')} again.\n`);
            return;
        }
        const shouldLaunch = options.launch !== false;
        const model = options.model;
        printBanner(_version);
        console.log(`Chain:    ${chalk.magenta('base')}`);
        console.log(`Wallet:   ${chalk.cyan(wallet.address)}`);
        if (model)
            console.log(`Model:    ${chalk.green(model)}`);
        console.log(`Fallback: ${fallbackEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
        console.log(`Proxy:    ${chalk.cyan(`http://localhost:${port}`)}`);
        console.log(`Backend:  ${chalk.dim(apiUrl)}\n`);
        const server = createProxy({
            port,
            apiUrl,
            chain: 'base',
            modelOverride: model,
            debug: options.debug,
            fallbackEnabled,
        });
        launchServer(server, port, shouldLaunch, model, options.debug);
    }
}
function launchServer(server, port, shouldLaunch, model, debug) {
    server.listen(port, () => {
        console.log(chalk.green(`✓ Proxy running on port ${port}`));
        console.log(chalk.dim(`  Usage tracking: ~/.blockrun/brcc-stats.json`));
        if (debug)
            console.log(chalk.dim(`  Debug log:      ~/.blockrun/brcc-debug.log`));
        console.log(chalk.dim(`  Run 'brcc stats' to view statistics\n`));
        if (shouldLaunch) {
            const claudeBin = findClaude();
            if (!claudeBin) {
                console.log(chalk.red('\nClaude Code not found in PATH.'));
                console.log(chalk.dim('  Install: npm install -g @anthropic-ai/claude-code'));
                console.log(chalk.dim('  Or:      curl -fsSL https://claude.ai/install.sh | bash\n'));
                console.log('You can still use the proxy manually:\n');
                console.log(chalk.bold(`  export ANTHROPIC_BASE_URL=http://localhost:${port}/api`));
                console.log(chalk.bold(`  export ANTHROPIC_AUTH_TOKEN=x402-proxy-handles-auth`));
                console.log(`\nThen run ${chalk.bold('claude')} in another terminal.`);
                return;
            }
            console.log(`Starting Claude Code (${chalk.dim(claudeBin)})...\n`);
            const cleanEnv = { ...process.env };
            delete cleanEnv.CLAUDE_ACCESS_TOKEN;
            delete cleanEnv.CLAUDE_OAUTH_TOKEN;
            const config = loadConfig();
            const sonnetModel = config['sonnet-model'] || 'anthropic/claude-sonnet-4.6';
            const opusModel = config['opus-model'] || 'anthropic/claude-opus-4.6';
            const haikuModel = config['haiku-model'] || 'anthropic/claude-haiku-4.5';
            const claudeArgs = [];
            if (model)
                claudeArgs.push('--model', model);
            const claude = spawn(claudeBin, claudeArgs, {
                stdio: 'inherit',
                env: {
                    ...cleanEnv,
                    ANTHROPIC_BASE_URL: `http://localhost:${port}/api`,
                    ANTHROPIC_AUTH_TOKEN: 'x402-proxy-handles-auth',
                    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
                    ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
                    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
                    ...(model ? { ANTHROPIC_MODEL: model } : {}),
                },
            });
            claude.on('error', (err) => {
                console.error('Failed to start Claude Code:', err.message);
                console.log('\nYou can still use the proxy manually:\n');
                console.log(chalk.bold(`  export ANTHROPIC_BASE_URL=http://localhost:${port}/api`));
                console.log(chalk.bold(`  export ANTHROPIC_AUTH_TOKEN=x402-proxy-handles-auth`));
                console.log(`\nThen run ${chalk.bold('claude')} in another terminal.`);
                server.close();
                process.exit(1);
            });
            claude.on('exit', (code) => {
                server.close();
                process.exit(code ?? 0);
            });
        }
        else {
            console.log('Proxy-only mode. Set this in your shell:\n');
            console.log(chalk.bold(`  export ANTHROPIC_BASE_URL=http://localhost:${port}/api`));
            console.log(chalk.bold(`  export ANTHROPIC_AUTH_TOKEN=x402-proxy-handles-auth`));
            console.log(`\nThen run ${chalk.bold('claude')} in another terminal.`);
        }
    });
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        server.close();
        process.exit(0);
    });
}
