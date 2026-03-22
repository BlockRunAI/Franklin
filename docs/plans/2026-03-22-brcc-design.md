# brcc — BlockRun Claude Code

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A CLI tool that lets users run Claude Code with any LLM model via BlockRun's API, paying per-use with Solana USDC micropayments. One command to start.

**Architecture:** Node.js CLI with three commands: `setup` (generate wallet), `start` (launch local x402 signing proxy + Claude Code), `balance` (check USDC). The proxy intercepts Claude Code's Anthropic API requests, signs them with x402, and forwards to sol.blockrun.ai.

**Tech Stack:** TypeScript, Commander.js, Node.js HTTP proxy, @solana/web3.js, x402-solana

---

## Architecture

```
User runs: brcc start

brcc process:
  1. Reads wallet from ~/.brcc/wallet.json
  2. Starts HTTP proxy on localhost:8402
  3. Spawns Claude Code with ANTHROPIC_BASE_URL=http://localhost:8402/api
     and ANTHROPIC_API_KEY=brcc

Proxy flow:
  Claude Code → POST localhost:8402/api/v1/messages
    → Proxy adds x402 payment signature (signed with wallet)
    → Forward to https://sol.blockrun.ai/api/v1/messages
    → Return Anthropic-format response to Claude Code

  If 402 received:
    → Parse payment requirements
    → Sign x402 payment with wallet private key
    → Retry request with X-Payment header
    → Return response to Claude Code
```

## File Structure

```
brcc/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # CLI entry point (commander)
│   ├── commands/
│   │   ├── setup.ts       # Generate wallet, show address
│   │   ├── start.ts       # Start proxy + launch Claude Code
│   │   └── balance.ts     # Check USDC balance
│   ├── proxy/
│   │   └── server.ts      # HTTP proxy with x402 signing
│   ├── wallet/
│   │   └── manager.ts     # Wallet generation, loading, storage
│   └── config.ts          # Config paths, defaults
├── docs/
│   └── plans/
└── README.md
```

## Config

```
~/.brcc/
├── wallet.json            # { publicKey, secretKey (encrypted?) }
└── config.json            # { apiUrl, port }
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/index.ts`, `src/config.ts`

**Step 1: Initialize project**

```json
// package.json
{
  "name": "brcc",
  "version": "0.1.0",
  "description": "BlockRun Claude Code — run Claude Code with any model, pay with USDC",
  "type": "module",
  "bin": { "brcc": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@solana/web3.js": "^1.98.0",
    "@solana/spl-token": "^0.4.0",
    "commander": "^13.0.0",
    "chalk": "^5.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

```typescript
// src/config.ts
import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = path.join(os.homedir(), '.brcc');
export const WALLET_PATH = path.join(CONFIG_DIR, 'wallet.json');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const DEFAULT_API_URL = 'https://sol.blockrun.ai/api';
export const DEFAULT_PROXY_PORT = 8402;
export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
```

```typescript
// src/index.ts
#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { balanceCommand } from './commands/balance.js';

const program = new Command();

program
  .name('brcc')
  .description('BlockRun Claude Code — run Claude Code with any model, pay with USDC')
  .version('0.1.0');

program
  .command('setup')
  .description('Generate a new Solana wallet for payments')
  .action(setupCommand);

program
  .command('start')
  .description('Start proxy and launch Claude Code')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .option('--no-launch', 'Start proxy only, do not launch Claude Code')
  .action(startCommand);

program
  .command('balance')
  .description('Check wallet USDC balance')
  .action(balanceCommand);

program.parse();
```

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: scaffold brcc project"
```

---

## Task 2: Wallet Manager

**Files:**
- Create: `src/wallet/manager.ts`

**Step 1: Implement wallet generation and loading**

```typescript
// src/wallet/manager.ts
import { Keypair } from '@solana/web3.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, WALLET_PATH } from '../config.js';

export interface WalletData {
  publicKey: string;
  secretKey: number[];
}

export async function walletExists(): Promise<boolean> {
  try {
    await fs.access(WALLET_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function generateWallet(): Promise<{ publicKey: string; keypair: Keypair }> {
  const keypair = Keypair.generate();
  const walletData: WalletData = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
  };

  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(WALLET_PATH, JSON.stringify(walletData, null, 2));
  await fs.chmod(WALLET_PATH, 0o600);

  return { publicKey: keypair.publicKey.toBase58(), keypair };
}

export async function loadWallet(): Promise<Keypair> {
  const data = await fs.readFile(WALLET_PATH, 'utf-8');
  const walletData: WalletData = JSON.parse(data);
  return Keypair.fromSecretKey(Uint8Array.from(walletData.secretKey));
}

export async function getPublicKey(): Promise<string> {
  const data = await fs.readFile(WALLET_PATH, 'utf-8');
  const walletData: WalletData = JSON.parse(data);
  return walletData.publicKey;
}
```

**Step 2: Commit**

```bash
git add src/wallet/manager.ts
git commit -m "feat: add wallet generation and management"
```

---

## Task 3: Setup Command

**Files:**
- Create: `src/commands/setup.ts`

**Step 1: Implement setup**

```typescript
// src/commands/setup.ts
import chalk from 'chalk';
import { walletExists, generateWallet, getPublicKey } from '../wallet/manager.js';

export async function setupCommand() {
  if (await walletExists()) {
    const pubkey = await getPublicKey();
    console.log(chalk.yellow('Wallet already exists.'));
    console.log(`Address: ${chalk.cyan(pubkey)}`);
    console.log(`\nTo create a new wallet, delete ~/.brcc/wallet.json first.`);
    return;
  }

  console.log('Generating new Solana wallet...\n');
  const { publicKey } = await generateWallet();

  console.log(chalk.green('Wallet created!\n'));
  console.log(`Address: ${chalk.cyan(publicKey)}`);
  console.log(`\nSend USDC (Solana) to this address to fund your account.`);
  console.log(`Then run ${chalk.bold('brcc start')} to launch Claude Code.\n`);
  console.log(chalk.dim('Wallet saved to ~/.brcc/wallet.json'));
}
```

**Step 2: Commit**

```bash
git add src/commands/setup.ts
git commit -m "feat: add setup command for wallet generation"
```

---

## Task 4: Balance Command

**Files:**
- Create: `src/commands/balance.ts`

**Step 1: Implement balance check**

```typescript
// src/commands/balance.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import chalk from 'chalk';
import { walletExists, getPublicKey } from '../wallet/manager.js';
import { SOLANA_RPC_URL, USDC_MINT } from '../config.js';

export async function balanceCommand() {
  if (!(await walletExists())) {
    console.log(chalk.red('No wallet found. Run `brcc setup` first.'));
    process.exit(1);
  }

  const pubkeyStr = await getPublicKey();
  const pubkey = new PublicKey(pubkeyStr);
  const usdcMint = new PublicKey(USDC_MINT);

  console.log(`Wallet: ${chalk.cyan(pubkeyStr)}\n`);

  const connection = new Connection(SOLANA_RPC_URL);

  try {
    const ata = await getAssociatedTokenAddress(usdcMint, pubkey);
    const tokenAccount = await connection.getTokenAccountBalance(ata);
    const balance = tokenAccount.value.uiAmount ?? 0;
    console.log(`USDC Balance: ${chalk.green(`$${balance.toFixed(2)}`)}`);

    if (balance === 0) {
      console.log(chalk.dim(`\nSend USDC (Solana) to ${pubkeyStr} to get started.`));
    }
  } catch {
    console.log(`USDC Balance: ${chalk.yellow('$0.00')}`);
    console.log(chalk.dim(`\nSend USDC (Solana) to ${pubkeyStr} to get started.`));
  }

  try {
    const solBalance = await connection.getBalance(pubkey);
    const sol = solBalance / 1e9;
    console.log(`SOL Balance:  ${chalk.dim(`${sol.toFixed(4)} SOL`)}`);
    if (sol < 0.001) {
      console.log(chalk.dim('Note: You need a small amount of SOL for transaction fees (~0.001 SOL).'));
    }
  } catch {
    console.log(`SOL Balance:  ${chalk.dim('0.0000 SOL')}`);
  }
}
```

**Step 2: Commit**

```bash
git add src/commands/balance.ts
git commit -m "feat: add balance command for USDC check"
```

---

## Task 5: x402 Signing Proxy

**Files:**
- Create: `src/proxy/server.ts`

This is the core — an HTTP proxy that intercepts requests from Claude Code, handles x402 payment flow, and forwards to BlockRun.

**Step 1: Implement the proxy**

```typescript
// src/proxy/server.ts
import http from 'node:http';
import { Keypair } from '@solana/web3.js';
import { DEFAULT_API_URL } from '../config.js';

export interface ProxyOptions {
  port: number;
  keypair: Keypair;
  apiUrl: string;
}

export function createProxy(options: ProxyOptions): http.Server {
  const { port, keypair, apiUrl } = options;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const targetUrl = `${apiUrl}${req.url}`;
    let body = '';

    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const result = await forwardWithPayment(targetUrl, req, body, keypair);

        // Copy headers
        const responseHeaders: Record<string, string> = {};
        result.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Handle streaming
        if (responseHeaders['content-type']?.includes('text/event-stream')) {
          res.writeHead(result.status, responseHeaders);
          const reader = result.body?.getReader();
          if (reader) {
            const pump = async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); break; }
                res.write(value);
              }
            };
            pump().catch(() => res.end());
          }
        } else {
          const responseBody = await result.text();
          res.writeHead(result.status, responseHeaders);
          res.end(responseBody);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Proxy error';
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } }));
      }
    });
  });

  return server;
}

async function forwardWithPayment(
  url: string,
  originalReq: http.IncomingMessage,
  body: string,
  keypair: Keypair
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': 'brcc',
  };

  // Copy original headers (except host)
  for (const [key, value] of Object.entries(originalReq.headers)) {
    if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length' && value) {
      headers[key] = Array.isArray(value) ? value[0] : value;
    }
  }

  // First attempt
  let response = await fetch(url, {
    method: originalReq.method || 'POST',
    headers,
    body: body || undefined,
  });

  // If 402, sign payment and retry
  if (response.status === 402) {
    const paymentRequired = await response.json();
    const paymentHeader = await signX402Payment(paymentRequired, keypair);

    headers['X-Payment'] = paymentHeader;
    response = await fetch(url, {
      method: originalReq.method || 'POST',
      headers,
      body: body || undefined,
    });
  }

  return response;
}

async function signX402Payment(
  paymentRequired: { accepts?: Array<{ amount: string; payTo: string; asset: string; network: string; extra?: { feePayer?: string } }> },
  keypair: Keypair
): Promise<string> {
  // Import x402-solana for payment signing
  // This will be implemented using the x402 client library
  const { createPaymentHeader } = await import('x402-solana/client');
  const accept = paymentRequired.accepts?.[0];
  if (!accept) throw new Error('No payment accept found in 402 response');

  const header = await createPaymentHeader(
    keypair,
    accept
  );

  return header;
}
```

Note: The exact x402-solana client signing API will need to be verified against the library. The core flow is: receive 402 → extract payment requirements → sign with wallet → retry with payment header.

**Step 2: Commit**

```bash
git add src/proxy/server.ts
git commit -m "feat: add x402 signing proxy server"
```

---

## Task 6: Start Command

**Files:**
- Create: `src/commands/start.ts`

**Step 1: Implement start**

```typescript
// src/commands/start.ts
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { walletExists, loadWallet, getPublicKey } from '../wallet/manager.js';
import { createProxy } from '../proxy/server.js';
import { DEFAULT_API_URL, DEFAULT_PROXY_PORT } from '../config.js';

interface StartOptions {
  port?: string;
  launch?: boolean;
}

export async function startCommand(options: StartOptions) {
  if (!(await walletExists())) {
    console.log(chalk.red('No wallet found. Run `brcc setup` first.'));
    process.exit(1);
  }

  const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));
  const shouldLaunch = options.launch !== false;
  const keypair = await loadWallet();
  const pubkey = await getPublicKey();

  console.log(chalk.bold('brcc — BlockRun Claude Code\n'));
  console.log(`Wallet:  ${chalk.cyan(pubkey)}`);
  console.log(`Proxy:   ${chalk.cyan(`http://localhost:${port}`)}`);
  console.log(`Backend: ${chalk.dim(DEFAULT_API_URL)}\n`);

  const server = createProxy({ port, keypair, apiUrl: DEFAULT_API_URL });

  server.listen(port, () => {
    console.log(chalk.green(`Proxy running on port ${port}\n`));

    if (shouldLaunch) {
      console.log('Starting Claude Code...\n');

      const claude = spawn('claude', [], {
        stdio: 'inherit',
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://localhost:${port}/api`,
          ANTHROPIC_API_KEY: 'brcc',
        },
      });

      claude.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log(chalk.red('\nClaude Code not found. Install it first:'));
          console.log(chalk.dim('  npm install -g @anthropic-ai/claude-code'));
        } else {
          console.error('Failed to start Claude Code:', err.message);
        }
        server.close();
        process.exit(1);
      });

      claude.on('exit', (code) => {
        server.close();
        process.exit(code ?? 0);
      });
    } else {
      console.log('Proxy-only mode. Set this in your shell:\n');
      console.log(chalk.bold(`  export ANTHROPIC_BASE_URL=http://localhost:${port}/api`));
      console.log(chalk.bold(`  export ANTHROPIC_API_KEY=brcc`));
      console.log(`\nThen run ${chalk.bold('claude')} in another terminal.`);
    }
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close();
    process.exit(0);
  });
}
```

**Step 2: Commit**

```bash
git add src/commands/start.ts
git commit -m "feat: add start command — proxy + Claude Code launcher"
```

---

## Task 7: Build, Test, and Polish

**Step 1: Install dependencies**

```bash
cd /Users/vickyfu/Documents/blockrun-web/brcc
pnpm install
```

**Step 2: Build**

```bash
pnpm build
```

Fix any type errors.

**Step 3: Test setup command**

```bash
node dist/index.js setup
```

Expected: Wallet created, address displayed.

**Step 4: Test balance command**

```bash
node dist/index.js balance
```

Expected: Shows $0.00 USDC for new wallet.

**Step 5: Test start command (proxy only)**

```bash
node dist/index.js start --no-launch
```

Expected: Proxy starts on port 8402, shows env var instructions.

**Step 6: Test start command (with Claude Code)**

```bash
node dist/index.js start
```

Expected: Proxy starts, Claude Code launches with correct env vars.

**Step 7: Commit fixes**

```bash
git add -A
git commit -m "fix: address issues from testing"
```

---

## Summary

| Task | What | Key File |
|------|------|----------|
| 1 | Project scaffolding | `package.json`, `src/index.ts`, `src/config.ts` |
| 2 | Wallet manager | `src/wallet/manager.ts` |
| 3 | Setup command | `src/commands/setup.ts` |
| 4 | Balance command | `src/commands/balance.ts` |
| 5 | x402 signing proxy | `src/proxy/server.ts` |
| 6 | Start command | `src/commands/start.ts` |
| 7 | Build & test | — |
