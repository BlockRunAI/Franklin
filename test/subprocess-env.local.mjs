import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-env-test-'));
process.env.HOME = home;
const { SENSITIVE_ENV_NAMES, sanitizeSubprocessEnv } = await import('../dist/tools/subprocess-env.js');
const { bashCapability } = await import('../dist/tools/bash.js');
const { detachCapability } = await import('../dist/tools/detach.js');
const { runDetachedTask } = await import('../dist/tasks/runner.js');
const { writeTaskMeta, readTaskMeta } = await import('../dist/tasks/store.js');
const { taskLogPath } = await import('../dist/tasks/paths.js');
const { HookEngine } = await import('../dist/hooks/runner.js');
const scope = { workingDir: home, abortSignal: new AbortController().signal };
const originals = { ...process.env };
after(() => {
  for (const name of [...SENSITIVE_ENV_NAMES, 'FRANKLIN_CLI_PATH', 'ENV_TEST_VISIBLE']) {
    if (originals[name] === undefined) delete process.env[name];
    else process.env[name] = originals[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function setKeys() {
  for (const name of SENSITIVE_ENV_NAMES) process.env[name] = `test-only-${name}`;
  process.env.ENV_TEST_VISIBLE = 'keep-this';
}
function assertSanitized(output) {
  for (const name of SENSITIVE_ENV_NAMES) assert.ok(!output.includes(`${name}=`), name);
  assert.match(output, /ENV_TEST_VISIBLE=keep-this/);
}

test('env list covers SDK account and EVM/Solana keys without mutating the source', () => {
  assert.deepEqual([...SENSITIVE_ENV_NAMES].sort(), [
    'BLOCKRUN_API_KEY', 'BLOCKRUN_WALLET_KEY', 'BASE_CHAIN_WALLET_KEY', 'SOLANA_WALLET_KEY',
  ].sort());
  setKeys();
  const clean = sanitizeSubprocessEnv();
  for (const name of SENSITIVE_ENV_NAMES) {
    assert.equal(clean[name], undefined);
    assert.equal(process.env[name], `test-only-${name}`);
  }
  assert.equal(clean.ENV_TEST_VISIBLE, 'keep-this');
});

test('Bash printenv child receives no signing or account keys', async () => {
  setKeys();
  const result = await bashCapability.execute({ command: 'printenv', timeout: 5000 }, scope);
  assert.ok(!result.isError, result.output);
  assertSanitized(result.output);
});

test('Detach sanitizes both its runner process and the command process', async () => {
  setKeys();
  const runner = path.join(home, 'env-runner.mjs');
  const runnerUrl = new URL('../dist/tasks/runner.js', import.meta.url).href;
  const observed = path.join(home, 'runner-env.json');
  fs.writeFileSync(runner, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env));\nconst { runDetachedTask } = await import(${JSON.stringify(runnerUrl)});\nprocess.exit(await runDetachedTask(process.argv[3]));\n`);
  process.env.FRANKLIN_CLI_PATH = runner;
  const result = await detachCapability.execute({ label: 'env check', command: 'printenv' }, scope);
  const runId = result.output.match(/runId: (\S+)/)[1];
  const deadline = Date.now() + 10000;
  while (!['succeeded', 'failed'].includes(readTaskMeta(runId)?.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(readTaskMeta(runId)?.status, 'succeeded');
  const runnerEnv = JSON.parse(fs.readFileSync(observed, 'utf8'));
  for (const name of SENSITIVE_ENV_NAMES) assert.equal(runnerEnv[name], undefined);
  assertSanitized(fs.readFileSync(taskLogPath(runId), 'utf8'));

  // Direct runner entry must sanitize too, even without startDetachedTask.
  const directId = 't_direct_env';
  writeTaskMeta({ runId: directId, runtime: 'detached-bash', label: 'direct', command: 'printenv', workingDir: home, status: 'queued', createdAt: Date.now() });
  assert.equal(await runDetachedTask(directId), 0);
  assertSanitized(fs.readFileSync(taskLogPath(directId), 'utf8'));
});

test('hooks keep user lifecycle env, sanitize inherited env for model tool envelopes, honor explicit hook env', async () => {
  setKeys();
  const output = path.join(home, 'hook-env');
  for (const toolContext of [false, true]) {
    const event = toolContext ? 'PreToolUse' : 'SessionStart';
    const hooks = [{ event, sourceFile: path.join(home, 'hooks.json'), scope: 'user', handler: {
      type: 'command', command: `printenv > '${output}'`, env: { BLOCKRUN_WALLET_KEY: 'hook-override' },
    } }];
    const engine = new HookEngine({ workDir: home, hooks });
    await engine.dispatch(event, { hookEventName: event, sessionId: 'env', cwd: home, timestamp: new Date().toISOString(),
      ...(toolContext ? { toolName: 'Bash', toolInput: { command: 'printenv' } } : {}),
    });
    const env = fs.readFileSync(output, 'utf8');
    // The hook's own configured env is an explicit user grant; only the
    // INHERITED keys are withheld when the hook sees model-controlled input.
    assert.match(env, /BLOCKRUN_WALLET_KEY=hook-override/);
    assert.match(env, /ENV_TEST_VISIBLE=keep-this/);
    for (const name of SENSITIVE_ENV_NAMES.filter(n => n !== 'BLOCKRUN_WALLET_KEY')) {
      assert.equal(env.includes(`${name}=test-only-${name}`), !toolContext, name);
    }
  }
});

test('MCP stdio child does not inherit signing keys; explicit server config still applies', async () => {
  setKeys();
  const { connectMcpServers, disconnectMcpServers } = await import('../dist/mcp/client.js');
  const server = path.join(home, 'env-mcp.mjs');
  const observed = path.join(home, 'mcp-env.json');
  fs.writeFileSync(server, `
import fs from 'node:fs';
import { createInterface } from 'node:readline';
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'env-test', version: '1' } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`);
  try {
    await connectMcpServers({ mcpServers: { 'env-test': {
      transport: 'stdio', command: process.execPath, args: [server],
      env: { BLOCKRUN_WALLET_KEY: 'server-override' },
    } } });
    const env = JSON.parse(fs.readFileSync(observed, 'utf8'));
    for (const name of SENSITIVE_ENV_NAMES) {
      if (name === 'BLOCKRUN_WALLET_KEY') assert.equal(env[name], 'server-override');
      else assert.equal(env[name], undefined, name);
    }
    assert.equal(env.ENV_TEST_VISIBLE, 'keep-this');
  } finally {
    await disconnectMcpServers();
  }
});
