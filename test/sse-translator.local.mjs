import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SSETranslator } from '../dist/proxy/sse-translator.js';

function sse(obj) {
  return `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
}

function stopReasons(output) {
  return output
    .split('\n\n')
    .filter((e) => e.startsWith('event: message_delta'))
    .map((e) => JSON.parse(e.split('data: ')[1]).delta.stop_reason);
}

function run(finishReason) {
  const t = new SSETranslator('test-model');
  const out = [];
  const feed = (c) => out.push(t.processChunk(c) ?? '');
  feed(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] }));
  if (finishReason === 'tool_calls') {
    feed(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } },
              ],
            },
          },
        ],
      })
    );
  }
  feed(sse({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
  feed(sse('[DONE]'));
  return out.join('');
}

describe('SSETranslator stop_reason', () => {
  it('keeps tool_use when [DONE] follows a tool_calls finish', () => {
    const output = run('tool_calls');
    assert.deepEqual(stopReasons(output), ['tool_use']);
    assert.ok(output.includes('event: message_stop'));
  });

  it('emits a single end_turn for a normal stop', () => {
    const output = run('stop');
    assert.deepEqual(stopReasons(output), ['end_turn']);
    assert.ok(output.includes('event: message_stop'));
  });

  it('falls back to end_turn when [DONE] arrives without a finish_reason', () => {
    const t = new SSETranslator('test-model');
    t.processChunk(sse({ choices: [{ index: 0, delta: { content: 'hi' } }] }));
    const output = t.processChunk(sse('[DONE]')) ?? '';
    assert.deepEqual(stopReasons(output), ['end_turn']);
    assert.ok(output.includes('event: message_stop'));
  });
});
