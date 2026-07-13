/**
 * Unit tests for the model resolver used by the `/model` handler and the
 * start command shortcut path. Pure functions, no LLM calls, no fs.
 *
 * Built into dist/ui/ by `tsc`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveModel, resolveModelStrict } = await import('../dist/ui/model-picker.js');

test('resolveModel: shortcut maps to canonical id', () => {
  assert.equal(resolveModel('sonnet'), 'anthropic/claude-sonnet-5');
  assert.equal(resolveModel('  SONNET  '), 'anthropic/claude-sonnet-5');
  assert.equal(resolveModel('free'), 'nvidia/qwen3-next-80b-a3b-instruct');
  assert.equal(resolveModel('llama'), 'nvidia/llama-4-maverick');
  assert.equal(resolveModel('llama-4-maverick'), 'nvidia/llama-4-maverick');
});

test('resolveModel: full provider/model id is passed through', () => {
  assert.equal(resolveModel('anthropic/claude-sonnet-4.6'), 'anthropic/claude-sonnet-4.6');
  assert.equal(resolveModel('openai/gpt-5.5'), 'openai/gpt-5.5');
  assert.equal(resolveModel('moonshot/kimi-k2.7'), 'moonshot/kimi-k2.7');
});

test('resolveModel: unknown bare alias is returned verbatim (caller decides)', () => {
  // The legacy soft resolver keeps the input so callers like the
  // gateway-error path can still print the bad id verbatim. The strict
  // resolver below is the one the `/model` handler uses to reject.
  assert.equal(resolveModel('foo'), 'foo');
  assert.equal(resolveModel('llama3'), 'llama3');
  assert.equal(resolveModel(''), '');
});

test('resolveModelStrict: shortcut maps to canonical id and flags viaShortcut', () => {
  const r = resolveModelStrict('llama');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.id, 'nvidia/llama-4-maverick');
    assert.equal(r.viaShortcut, true);
  }
});

test('resolveModelStrict: full id is accepted but not flagged as shortcut', () => {
  const r = resolveModelStrict('anthropic/claude-sonnet-4.6');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.id, 'anthropic/claude-sonnet-4.6');
    assert.equal(r.viaShortcut, false);
  }
});

test('resolveModelStrict: unknown bare alias is rejected with a helpful suggestion', () => {
  const r = resolveModelStrict('foo');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.suggestion, /Unknown model alias: "foo"/);
    assert.match(r.suggestion, /anthropic\/claude-sonnet-4\.6/);
  }

  const r2 = resolveModelStrict('llama3');
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.match(r2.suggestion, /Unknown model alias: "llama3"/);
  }
});

test('resolveModelStrict: empty input is rejected', () => {
  const r = resolveModelStrict('');
  assert.equal(r.ok, false);
});

test('resolveModelStrict: case-insensitive shortcut lookup', () => {
  const r = resolveModelStrict('  FrEe  ');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.id, 'nvidia/qwen3-next-80b-a3b-instruct');
  }
});