#!/usr/bin/env node
/**
 * Modal sandbox tools — offline self-tests.
 *
 * Runs without making any paid x402 calls. Covers:
 *   1. Tool registration: all 4 ModalXxx capabilities exist in `allCapabilities`.
 *   2. Hidden by default: none of them appear in CORE_TOOL_NAMES.
 *   3. Schema sanity: each spec has the expected required/optional fields.
 *   4. normalizeCommand behavior (string ↔ array, invalid).
 *   5. SessionSandboxTracker add / remove / drain semantics.
 *   6. Gateway contract: re-runs the probe curls (free 400/402 responses)
 *      to verify the endpoint surface still matches the implementation
 *      (catches gateway-side breaking changes early).
 *
 * Run:    node scripts/test-modal-tools.mjs
 * Exit 0 = pass, exit 1 = fail.
 */

import { allCapabilities } from '../dist/tools/index.js';
import { CORE_TOOL_NAMES } from '../dist/tools/tool-categories.js';
import { sessionSandboxTracker } from '../dist/tools/modal.js';

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

console.log('\n[1] Tool registration');
const expected = ['ModalCreate', 'ModalExec', 'ModalStatus', 'ModalTerminate'];
const registered = new Set(allCapabilities.map(c => c.spec.name));
for (const name of expected) {
  check(`${name} registered`, registered.has(name));
}

console.log('\n[2] Hidden by default (must require ActivateTool)');
for (const name of expected) {
  check(`${name} NOT in CORE_TOOL_NAMES`, !CORE_TOOL_NAMES.has(name));
}

console.log('\n[3] Schema sanity');
const create = allCapabilities.find(c => c.spec.name === 'ModalCreate');
const exec = allCapabilities.find(c => c.spec.name === 'ModalExec');
const status = allCapabilities.find(c => c.spec.name === 'ModalStatus');
const terminate = allCapabilities.find(c => c.spec.name === 'ModalTerminate');

check('ModalCreate has gpu/timeout/cpu/memory props',
  create && ['gpu', 'timeout', 'cpu', 'memory'].every(k => k in create.spec.input_schema.properties));
check('ModalCreate has NO required fields',
  create && (!create.spec.input_schema.required || create.spec.input_schema.required.length === 0));
check('ModalExec requires sandbox_id + command',
  exec && exec.spec.input_schema.required?.includes('sandbox_id') &&
  exec.spec.input_schema.required?.includes('command'));
check('ModalStatus requires sandbox_id only',
  status && JSON.stringify(status.spec.input_schema.required) === '["sandbox_id"]');
check('ModalTerminate requires sandbox_id only',
  terminate && JSON.stringify(terminate.spec.input_schema.required) === '["sandbox_id"]');
check('ModalCreate concurrent=false (high-cost, must be serial)', create && create.concurrent === false);
check('ModalExec concurrent=false (writes shared sandbox state)', exec && exec.concurrent === false);

console.log('\n[4] normalizeCommand — internal, exercised via ModalExec.execute');
// We can't easily import the un-exported helper, but ModalExec returns
// a clear error message on bad command, so probe via its public surface.
const stubScope = {
  workingDir: '/tmp',
  abortSignal: new AbortController().signal,
  onAskUser: undefined,
};
const badCases = [
  { input: { sandbox_id: 'x', command: '' }, label: 'empty string command rejected' },
  { input: { sandbox_id: 'x', command: [] }, label: 'empty array command rejected' },
  { input: { sandbox_id: 'x', command: [1, 2] }, label: 'non-string array command rejected' },
  { input: { sandbox_id: 'x', command: null }, label: 'null command rejected' },
  { input: { sandbox_id: 'x' }, label: 'missing command rejected' },
];
for (const c of badCases) {
  const r = await exec.execute(c.input, stubScope);
  check(c.label, r.isError === true && /invalid command|command is required|expected/i.test(r.output));
}

console.log('\n[5] SessionSandboxTracker semantics');
sessionSandboxTracker.drainIds(); // start clean
sessionSandboxTracker.add({ id: 'sbx_a', gpu: 'cpu', createdAt: Date.now() });
sessionSandboxTracker.add({ id: 'sbx_b', gpu: 'T4', createdAt: Date.now() });
const list1 = sessionSandboxTracker.list();
check('add registers 2 sandboxes', list1.length === 2);
sessionSandboxTracker.remove('sbx_a');
check('remove drops one', sessionSandboxTracker.list().length === 1);
const drained = sessionSandboxTracker.drainIds();
check('drainIds returns remaining ids', drained.length === 1 && drained[0] === 'sbx_b');
check('drainIds clears the tracker', sessionSandboxTracker.list().length === 0);

console.log('\n[6] Gateway contract probe (live, free — relies on 400/402 responses)');
const BASE = 'https://blockrun.ai/api';
async function probe(path, body, expectStatus, validator) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text().catch(() => '');
    let json = {};
    try { json = JSON.parse(text); } catch { /* ignore */ }
    const ok = r.status === expectStatus && (validator ? validator(json) : true);
    return { ok, status: r.status, json };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

const c1 = await probe('/v1/modal/sandbox/create', {}, 402, j => j.price?.amount === '0.0100');
check('create endpoint reachable, CPU price still $0.01', c1.ok, `got status ${c1.status}`);

const c2 = await probe('/v1/modal/sandbox/create', { gpu: 'H100' }, 402, j => j.price?.amount === '0.4000');
check('H100 price still $0.40', c2.ok, `got status ${c2.status}`);

const c3 = await probe('/v1/modal/sandbox/create', { gpu: 'invalid_xxx' }, 400);
check('invalid gpu rejected with 400', c3.ok, `got status ${c3.status}`);

const c4 = await probe('/v1/modal/sandbox/exec', {}, 400, j =>
  j.details?.some(d => d.path?.[0] === 'sandbox_id') &&
  j.details?.some(d => d.path?.[0] === 'command' && d.expected === 'array'));
check('exec still requires sandbox_id + command-as-array', c4.ok, `got status ${c4.status}`);

const c5 = await probe('/v1/modal/sandbox/status', {}, 400);
check('status requires sandbox_id', c5.ok, `got status ${c5.status}`);

const c6 = await probe('/v1/modal/sandbox/terminate', {}, 400);
check('terminate requires sandbox_id', c6.ok, `got status ${c6.status}`);

const c7 = await probe('/v1/modal/sandbox/create', { image: 'python:3.12' }, 400, j =>
  j.details?.some(d => /python:3\.11/i.test(String(d.message ?? ''))));
check('image still locked to python:3.11', c7.ok, `got status ${c7.status}`);

console.log(`\n${failures === 0 ? '\x1b[32mAll checks passed.\x1b[0m' : `\x1b[31m${failures} check(s) failed.\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
