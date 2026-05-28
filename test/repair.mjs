/**
 * Unit tests for the tool-call repair pipeline ported from reasonix.
 *
 * Targets src/agent/repair/ — pure functions, no LLM calls, no fs.
 * Built into dist/agent/repair/ by `tsc`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  analyzeSchema,
  flattenSchema,
  nestArguments,
  repairTruncatedJson,
  repairAndParseArgs,
  scavengeToolCalls,
  ToolCallRepair,
} = await import('../dist/agent/repair/index.js');

// ─── flatten ─────────────────────────────────────────────────────────────

test('analyzeSchema: shallow schema does not trigger flatten', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
  };
  const decision = analyzeSchema(schema);
  assert.equal(decision.shouldFlatten, false);
  assert.equal(decision.leafCount, 2);
  assert.equal(decision.maxDepth, 1);
});

test('analyzeSchema: deep schema triggers flatten on depth', () => {
  const schema = {
    type: 'object',
    properties: {
      a: {
        type: 'object',
        properties: {
          b: {
            type: 'object',
            properties: { c: { type: 'string' } },
          },
        },
      },
    },
  };
  const decision = analyzeSchema(schema);
  assert.equal(decision.shouldFlatten, true);
  assert.equal(decision.maxDepth, 3);
});

test('analyzeSchema: wide schema triggers flatten on leaf count', () => {
  const props = {};
  for (let i = 0; i < 11; i++) props[`f${i}`] = { type: 'string' };
  const decision = analyzeSchema({ type: 'object', properties: props });
  assert.equal(decision.shouldFlatten, true);
  assert.equal(decision.leafCount, 11);
});

test('flattenSchema + nestArguments round-trip preserves structure', () => {
  const schema = {
    type: 'object',
    required: ['user'],
    properties: {
      user: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      },
      flag: { type: 'boolean' },
    },
  };
  const flat = flattenSchema(schema);
  assert.deepEqual(Object.keys(flat.properties).sort(), ['flag', 'user.age', 'user.name']);
  assert.deepEqual(flat.required.sort(), ['user.name']);
  const nested = nestArguments({ 'user.name': 'alice', 'user.age': 7, flag: true });
  assert.deepEqual(nested, { user: { name: 'alice', age: 7 }, flag: true });
});

// ─── truncation ──────────────────────────────────────────────────────────

test('repairTruncatedJson: valid JSON is unchanged', () => {
  const r = repairTruncatedJson('{"a":1}');
  assert.equal(r.changed, false);
  assert.equal(r.fallback, false);
  assert.equal(r.repaired, '{"a":1}');
});

test('repairTruncatedJson: empty input → {}', () => {
  const r = repairTruncatedJson('');
  assert.equal(r.fallback, false);
  assert.equal(r.repaired, '{}');
});

test('repairTruncatedJson: trailing comma trimmed', () => {
  const r = repairTruncatedJson('{"a":1,');
  assert.equal(r.fallback, false);
  assert.deepEqual(JSON.parse(r.repaired), { a: 1 });
});

test('repairTruncatedJson: dangling key gets null', () => {
  const r = repairTruncatedJson('{"a":');
  assert.equal(r.fallback, false);
  assert.deepEqual(JSON.parse(r.repaired), { a: null });
});

test('repairTruncatedJson: unterminated string is closed', () => {
  const r = repairTruncatedJson('{"a":"hello');
  assert.equal(r.fallback, false);
  assert.deepEqual(JSON.parse(r.repaired), { a: 'hello' });
});

test('repairTruncatedJson: nested truncation closes all braces', () => {
  const r = repairTruncatedJson('{"a":{"b":[1,2');
  assert.equal(r.fallback, false);
  assert.deepEqual(JSON.parse(r.repaired), { a: { b: [1, 2] } });
});

test('repairTruncatedJson: unrecoverable garbage falls back to {}', () => {
  const r = repairTruncatedJson('not json at all }}}');
  assert.equal(r.fallback, true);
  assert.equal(r.repaired, '{}');
});

test('repairAndParseArgs: returns parsed object on truncated input', () => {
  const r = repairAndParseArgs('{"path":"/tmp/foo","limit":');
  assert.notEqual(r, null);
  assert.equal(r.repaired, true);
  assert.deepEqual(r.input, { path: '/tmp/foo', limit: null });
});

test('repairAndParseArgs: returns null when unrecoverable', () => {
  const r = repairAndParseArgs('garbage');
  assert.equal(r, null);
});

// ─── scavenge ────────────────────────────────────────────────────────────

const ALLOWED = new Set(['Read', 'Bash', 'Edit', 'WebSearch']);

test('scavengeToolCalls: null/empty input returns no calls', () => {
  assert.deepEqual(scavengeToolCalls(null, { allowedNames: ALLOWED }).calls, []);
  assert.deepEqual(scavengeToolCalls('', { allowedNames: ALLOWED }).calls, []);
  assert.deepEqual(scavengeToolCalls('plain text', { allowedNames: ALLOWED }).calls, []);
});

test('scavengeToolCalls: Pattern 1 — {name, arguments} flat shape', () => {
  const text = 'I need to read it: {"name":"Read","arguments":{"file_path":"/tmp/x"}}';
  const { calls } = scavengeToolCalls(text, { allowedNames: ALLOWED });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Read');
  assert.equal(calls[0].type, 'tool_use');
  assert.match(calls[0].id, /^toolu_repair_/);
  assert.deepEqual(calls[0].input, { file_path: '/tmp/x' });
});

test('scavengeToolCalls: Pattern 2 — OpenAI {type:function, function:{}}', () => {
  const text =
    'Calling: {"type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}';
  const { calls } = scavengeToolCalls(text, { allowedNames: ALLOWED });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Bash');
  assert.deepEqual(calls[0].input, { command: 'ls' });
});

test('scavengeToolCalls: Pattern 3 — {tool_name, tool_args} R1 form', () => {
  const text = '{"tool_name":"Edit","tool_args":{"file_path":"a","old_string":"x","new_string":"y"}}';
  const { calls } = scavengeToolCalls(text, { allowedNames: ALLOWED });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Edit');
  assert.deepEqual(calls[0].input.old_string, 'x');
});

test('scavengeToolCalls: unknown tool names are rejected', () => {
  const text = '{"name":"NotARealTool","arguments":{}}';
  const { calls } = scavengeToolCalls(text, { allowedNames: ALLOWED });
  assert.equal(calls.length, 0);
});

test('scavengeToolCalls: maxCalls cap respected', () => {
  const blocks = Array.from(
    { length: 6 },
    (_, i) => `{"name":"Read","arguments":{"file_path":"/tmp/f${i}"}}`,
  ).join(' then ');
  const { calls } = scavengeToolCalls(blocks, { allowedNames: ALLOWED, maxCalls: 2 });
  assert.equal(calls.length, 2);
});

test('scavengeToolCalls: oversize input is skipped with note', () => {
  const huge = 'x'.repeat(101 * 1024);
  const r = scavengeToolCalls(huge, { allowedNames: ALLOWED });
  assert.equal(r.calls.length, 0);
  assert.match(r.notes[0], /too large/);
});

test('scavengeToolCalls: DSML invoke block (DeepSeek chat template)', () => {
  // Use ASCII | fallback — easier to write in source than U+FF5C.
  const text =
    '<|DSML|invoke name="Read"><|DSML|parameter name="file_path">/tmp/y</|DSML|parameter></|DSML|invoke>';
  const { calls } = scavengeToolCalls(text, { allowedNames: ALLOWED });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Read');
  assert.deepEqual(calls[0].input, { file_path: '/tmp/y' });
});

// ─── ToolCallRepair orchestrator ─────────────────────────────────────────

test('ToolCallRepair: merges scavenged calls and dedupes against declared', () => {
  const repair = new ToolCallRepair({ allowedToolNames: ALLOWED });
  const declared = [
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } },
  ];
  const reasoning = '{"name":"Read","arguments":{"file_path":"/tmp/x"}}';
  const { calls, report } = repair.process(declared, reasoning);
  assert.equal(calls.length, 1);
  assert.equal(report.scavenged, 0);
  assert.equal(report.duplicatesDropped, 1);
});

test('ToolCallRepair: adds novel scavenged calls', () => {
  const repair = new ToolCallRepair({ allowedToolNames: ALLOWED });
  const declared = [
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } },
  ];
  const reasoning = '{"name":"Bash","arguments":{"command":"ls"}}';
  const { calls, report } = repair.process(declared, reasoning);
  assert.equal(calls.length, 2);
  assert.equal(report.scavenged, 1);
  assert.equal(calls[1].name, 'Bash');
});

test('ToolCallRepair: scans both reasoning and content channels', () => {
  const repair = new ToolCallRepair({ allowedToolNames: ALLOWED });
  const { calls, report } = repair.process(
    [],
    '{"name":"Read","arguments":{"file_path":"/a"}}',
    '{"name":"Bash","arguments":{"command":"echo"}}',
  );
  assert.equal(calls.length, 2);
  assert.equal(report.scavenged, 2);
});
