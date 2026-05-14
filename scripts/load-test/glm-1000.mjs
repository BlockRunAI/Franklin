#!/usr/bin/env node
/**
 * BlockRun GLM 1000-call natural-pacing load test.
 *
 * Hits zai/glm-5-turbo with randomly varied prompts and human-like
 * delays (short bursts + medium pauses + occasional long breaks).
 * Logs each call to scripts/load-test/glm-1000.jsonl
 * and a rolling status summary to scripts/load-test/glm-1000.status.json
 */

import { LLMClient } from '@blockrun/llm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPrivateKey() {
  if (process.env.BASE_CHAIN_WALLET_KEY) return process.env.BASE_CHAIN_WALLET_KEY;
  const sessionFile = path.join(os.homedir(), '.blockrun', '.session');
  if (fs.existsSync(sessionFile)) {
    return fs.readFileSync(sessionFile, 'utf-8').trim();
  }
  throw new Error('No wallet key found. Set BASE_CHAIN_WALLET_KEY or create ~/.blockrun/.session');
}
const LOG_FILE = path.join(__dirname, 'glm-1000.jsonl');
const STATUS_FILE = path.join(__dirname, 'glm-1000.status.json');

const TOTAL_CALLS = parseInt(process.env.TOTAL_CALLS || '1000', 10);
const MODEL = process.env.GLM_MODEL || 'zai/glm-5-turbo';

// Natural pacing distribution.
//   - 70%: 1-5s   (typing fast / quick follow-up)
//   - 20%: 8-20s  (reading / thinking)
//   -  8%: 30-90s (longer thinking / context switch)
//   -  2%: 2-5min (coffee / quick errand)
function naturalDelayMs() {
  const r = Math.random();
  if (r < 0.70) return rand(1000, 5000);
  if (r < 0.90) return rand(8000, 20000);
  if (r < 0.98) return rand(30000, 90000);
  return rand(120000, 300000);
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

const promptTemplates = [
  () => `What is ${rand(2, 99)} times ${rand(2, 99)}? Just the number.`,
  () => `Give me one short word that rhymes with "${pick(['cat', 'dog', 'tree', 'sun', 'moon', 'rain', 'star', 'fire'])}".`,
  () => `Capital of ${pick(['France', 'Japan', 'Brazil', 'Egypt', 'Canada', 'Kenya', 'Peru', 'Norway', 'Vietnam', 'Mongolia'])}?`,
  () => `Write a one-line haiku about ${pick(['rain', 'code', 'coffee', 'midnight', 'a cat', 'autumn', 'silence', 'the sea'])}.`,
  () => `Translate to Spanish: "${pick(['hello world', 'good morning', 'see you tomorrow', 'thank you very much', 'where is the library'])}"`,
  () => `Is ${rand(2, 200)} prime? Yes or no.`,
  () => `One adjective to describe ${pick(['the ocean', 'a thunderstorm', 'an old library', 'a quiet morning', 'a busy market'])}.`,
  () => `What year did ${pick(['the Titanic sink', 'WWII end', 'humans land on the moon', 'the Berlin Wall fall', 'the iPhone launch'])}?`,
  () => `Short definition of "${pick(['entropy', 'photosynthesis', 'recursion', 'osmosis', 'inertia', 'metaphor', 'irony'])}" in one sentence.`,
  () => `Name a ${pick(['fruit', 'mammal', 'planet', 'programming language', 'jazz musician', 'country', 'element'])} that starts with "${pick(['B', 'M', 'P', 'S', 'A', 'C', 'T'])}".`,
  () => `Continue: "It was a dark and stormy night, and ${pick(['the cat', 'the detective', 'the old man', 'the spaceship', 'the lighthouse keeper'])}..."`,
  () => `Pick one: ${pick(['cats or dogs', 'tea or coffee', 'mountains or beach', 'morning or night', 'summer or winter'])}? And why in one sentence.`,
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function makePrompt() {
  return promptTemplates[Math.floor(Math.random() * promptTemplates.length)]();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h${m.toString().padStart(2,'0')}m${sec.toString().padStart(2,'0')}s`;
}

function writeStatus(status) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function appendLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

async function main() {
  console.log(`[glm-1000] Starting ${TOTAL_CALLS} calls to ${MODEL}`);
  console.log(`[glm-1000] Log file: ${LOG_FILE}`);
  console.log(`[glm-1000] Status:   ${STATUS_FILE}`);

  // Fresh log file on every start.
  fs.writeFileSync(LOG_FILE, '');

  const client = new LLMClient({ privateKey: loadPrivateKey() });
  const startedAt = Date.now();
  let ok = 0;
  let fail = 0;
  let totalSpent = 0;
  let totalTokens = 0;

  for (let i = 1; i <= TOTAL_CALLS; i++) {
    const prompt = makePrompt();
    const callStart = Date.now();
    let entry = {
      n: i,
      ts: new Date().toISOString(),
      model: MODEL,
      prompt,
    };

    try {
      const response = await client.chatCompletion(MODEL, [
        { role: 'user', content: prompt },
      ], {
        max_tokens: 60,
        temperature: 0.7,
      });

      const content = response?.choices?.[0]?.message?.content || '';
      const usage = response?.usage || {};
      const cost = response?.cost ?? response?.payment?.amount ?? 0.001;

      entry = {
        ...entry,
        status: 'ok',
        latency_ms: Date.now() - callStart,
        reply: content.slice(0, 200),
        usage,
        cost,
      };
      ok++;
      totalSpent += Number(cost) || 0;
      totalTokens += (usage.total_tokens || usage.prompt_tokens + usage.completion_tokens || 0);
    } catch (err) {
      entry = {
        ...entry,
        status: 'error',
        latency_ms: Date.now() - callStart,
        error: String(err?.message || err).slice(0, 500),
      };
      fail++;
    }

    appendLog(entry);

    const elapsed = Date.now() - startedAt;
    const status = {
      total: TOTAL_CALLS,
      completed: i,
      ok,
      fail,
      progress_pct: ((i / TOTAL_CALLS) * 100).toFixed(2),
      elapsed: fmtDuration(elapsed),
      est_total: i > 1 ? fmtDuration((elapsed / i) * TOTAL_CALLS) : 'n/a',
      avg_latency_ms: Math.round(elapsed / i),
      total_spent_usdc: totalSpent.toFixed(4),
      total_tokens: totalTokens,
      last_status: entry.status,
      last_reply_preview: entry.reply || entry.error || '',
      model: MODEL,
      started_at: new Date(startedAt).toISOString(),
      updated_at: new Date().toISOString(),
    };
    writeStatus(status);

    // Live console heartbeat every 10 calls (keeps logs quiet but visible).
    if (i % 10 === 0 || i === 1 || i === TOTAL_CALLS) {
      console.log(`[${i}/${TOTAL_CALLS}] ok=${ok} fail=${fail} spent=$${totalSpent.toFixed(3)} last="${(entry.reply || entry.error || '').slice(0, 50)}"`);
    }

    if (i < TOTAL_CALLS) {
      const delay = naturalDelayMs();
      await sleep(delay);
    }
  }

  console.log(`\n[glm-1000] DONE. ${ok} ok, ${fail} fail, spent $${totalSpent.toFixed(4)}`);
}

main().catch(err => {
  console.error('[glm-1000] Fatal:', err);
  process.exit(1);
});
