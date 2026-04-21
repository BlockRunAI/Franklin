#!/usr/bin/env node
/**
 * Franklin harness ablation bench.
 *
 * Runs a fixed set of prompts through Franklin in --prompt one-shot mode,
 * once per configuration. Each configuration toggles a single harness
 * env flag so we can isolate which components are still load-bearing
 * (per Anthropic's harness-design methodology: remove one at a time,
 * measure impact, decide).
 *
 * What this is NOT: an automated quality judge. Final answers land in a
 * JSON report; human eyeballs them. Machine-measurable dimensions
 * (latency, cost, tool count, final-answer length) are computed.
 *
 * Cost warning: each prompt may spend real USDC. Default config runs 5
 * prompts × 4 configs = 20 runs. Budget ~$0.05–$0.50 depending on models.
 *
 * Usage:
 *   node scripts/harness-bench.mjs                  # full matrix
 *   node scripts/harness-bench.mjs --configs baseline,no-plan
 *   node scripts/harness-bench.mjs --prompts crcl,x402
 *   node scripts/harness-bench.mjs --dry-run        # print plan, no spawns
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRANKLIN_CLI = join(__dirname, '..', 'dist', 'index.js');
const OUT_DIR = join(__dirname, '..', 'docs', 'harness-runs');

// ─── Prompt set ──────────────────────────────────────────────────────────
// Covers the failure modes Franklin's harness is designed to address:
//   trading: "does the agent reach for live market data?"
//   research: "does the agent ground answers with citations?"
//   code:    "does the agent implement + verify, or stub?"
//   trivia:  "does the agent waste a plan-then-execute cycle on a 1-word question?"

const PROMPTS = [
  {
    id: 'crcl',
    category: 'trading',
    prompt: 'What is Circle (CRCL) stock trading at right now on NYSE, and what are the two biggest reasons it has moved over the past week? Give me a buy/hold/sell take.',
  },
  {
    id: 'btc-analysis',
    category: 'trading',
    prompt: 'Is BTC above $70,000 right now? If yes, what is the current momentum (RSI / MACD) based on daily OHLCV, and is now a reasonable entry point?',
  },
  {
    id: 'x402-state',
    category: 'research',
    prompt: 'What is the current state of adoption of the x402 payment protocol in 2026? Which major services or wallets have shipped support?',
  },
  {
    id: 'pyth-vs-chainlink',
    category: 'research',
    prompt: 'Compare Pyth Network and Chainlink as price oracle providers as of today — coverage, latency, cost, and which projects use which.',
  },
  {
    id: 'trivia-short',
    category: 'edge',
    prompt: 'What is 2 + 2?',
  },
];

// ─── Configurations ──────────────────────────────────────────────────────
// Each flips ONE harness component off relative to baseline.

const CONFIGS = [
  { name: 'baseline', env: {}, summary: 'Full harness (v3.8.14)' },
  { name: 'no-plan', env: { FRANKLIN_NOPLAN: '1' }, summary: 'plan-then-execute OFF' },
  { name: 'no-dynamic-tools', env: { FRANKLIN_DYNAMIC_TOOLS: '0' }, summary: 'ActivateTool / CORE gating OFF' },
  { name: 'no-eval', env: { FRANKLIN_NO_EVAL: '1' }, summary: 'Groundedness evaluator OFF' },
];

// ─── Per-run settings ────────────────────────────────────────────────────

const TIMEOUT_MS = 180_000; // 3 minutes per prompt
const MODEL = process.env.BENCH_MODEL || 'zai/glm-5.1'; // cheap flat $0.001/call default
const TRUST = true; // skip permission prompts so bench isn't interactive

// ─── Arg parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { configs: null, prompts: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--configs') args.configs = argv[++i].split(',');
    else if (a === '--prompts') args.prompts = argv[++i].split(',');
  }
  return args;
}

// ─── Run one prompt in one config ────────────────────────────────────────

function runOne({ prompt, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn('node', [
      FRANKLIN_CLI,
      '--prompt', prompt,
      '--model', MODEL,
      ...(TRUST ? ['--trust'] : []),
    ], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        elapsedMs,
        toolCalls: countToolCalls(stdout, stderr),
        answerLength: stdout.trim().length,
        costUsd: extractCost(stderr),
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: -1, stdout, stderr: stderr + '\n' + err.message,
        elapsedMs: Date.now() - started, toolCalls: 0, answerLength: 0, costUsd: 0,
      });
    });
  });
}

/** Extract session cost from stderr — Franklin prints a line like
 *  "  Session: ... · cost $0.0012" at end of --prompt runs. Best-effort. */
function extractCost(stderr) {
  const m = stderr.match(/cost\s*\$([\d.]+)/i);
  return m ? Number(m[1]) : 0;
}

/** Count how many tool invocations showed up in output.
 *  Heuristic: look for [ToolName] or "⏺ ToolName(" style markers. */
function countToolCalls(stdout, stderr) {
  const combined = stdout + '\n' + stderr;
  const matches = combined.match(/(?:^|\s)(?:⏺\s+)?([A-Z][A-Za-z]+)\(/gm) || [];
  return matches.length;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configs = args.configs
    ? CONFIGS.filter(c => args.configs.includes(c.name))
    : CONFIGS;
  const prompts = args.prompts
    ? PROMPTS.filter(p => args.prompts.includes(p.id))
    : PROMPTS;

  console.error(`Franklin harness bench`);
  console.error(`  ${configs.length} config(s) × ${prompts.length} prompt(s) = ${configs.length * prompts.length} runs`);
  console.error(`  Model: ${MODEL}`);
  console.error(`  Timeout: ${TIMEOUT_MS / 1000}s per prompt`);
  console.error('');

  if (args.dryRun) {
    for (const c of configs) {
      console.error(`[dry] ${c.name} — ${c.summary}`);
      for (const p of prompts) {
        console.error(`  · ${p.id} [${p.category}]`);
      }
    }
    return;
  }

  if (!existsSync(FRANKLIN_CLI)) {
    console.error(`Franklin CLI not built: ${FRANKLIN_CLI}`);
    console.error(`Run: npm run build`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `bench-${stamp}.json`);

  const results = [];

  for (const config of configs) {
    console.error(`\n── ${config.name}: ${config.summary} ──`);
    for (const p of prompts) {
      process.stderr.write(`  ${p.id} [${p.category}] ... `);
      const r = await runOne({ prompt: p.prompt, env: config.env });
      results.push({
        config: config.name,
        prompt_id: p.id,
        category: p.category,
        prompt: p.prompt,
        ...r,
      });
      console.error(
        `exit=${r.code} ${(r.elapsedMs / 1000).toFixed(1)}s ` +
        `tools=${r.toolCalls} ans=${r.answerLength}ch cost=$${r.costUsd.toFixed(4)}`
      );
    }
  }

  // Summary table
  console.error('');
  console.error('─── Summary (by config) ───');
  console.error('config              | avg_s | avg_tools | avg_ans_ch | total_cost');
  console.error('--------------------|-------|-----------|------------|----------');
  for (const c of configs) {
    const rows = results.filter(r => r.config === c.name);
    if (!rows.length) continue;
    const avgS = (rows.reduce((s, r) => s + r.elapsedMs, 0) / rows.length / 1000).toFixed(1);
    const avgTools = (rows.reduce((s, r) => s + r.toolCalls, 0) / rows.length).toFixed(1);
    const avgAns = Math.round(rows.reduce((s, r) => s + r.answerLength, 0) / rows.length);
    const totalCost = rows.reduce((s, r) => s + r.costUsd, 0).toFixed(4);
    console.error(`${c.name.padEnd(20)}| ${avgS.padStart(5)} | ${avgTools.padStart(9)} | ${String(avgAns).padStart(10)} | $${totalCost}`);
  }

  writeFileSync(outFile, JSON.stringify({
    stamp,
    model: MODEL,
    configs: configs.map(c => ({ name: c.name, summary: c.summary, env: c.env })),
    prompts: prompts.map(p => ({ id: p.id, category: p.category, prompt: p.prompt })),
    results,
  }, null, 2));
  console.error('');
  console.error(`Results: ${outFile}`);
  console.error('');
  console.error('Next: eyeball the stdout fields in the JSON to grade answer quality per-config.');
  console.error('      Cost / latency / tool count are automated; groundedness needs human judgment.');
}

main().catch(err => {
  console.error(`bench error: ${err.stack || err.message}`);
  process.exit(1);
});
