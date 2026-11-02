import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopQuestions } from '../dist/serve/desktop-questions.js';

test('questions preserve text and options, bind responses to the originating socket, and resolve once', async () => {
  const broker = new DesktopQuestions();
  const owner = {}, stranger = {}, events = [];
  const pending = broker.request(owner, 'Which market and time range?', ['Market A', 'Market B'], (kind, payload) => events.push({ kind, payload }));
  const { askId, options } = events[0].payload;
  assert.deepEqual(options, ['Market A', 'Market B']);
  assert.equal(broker.respond(stranger, askId, 'wrong'), false);
  assert.equal(broker.respond(owner, askId, true), false);
  assert.equal(broker.respond(owner, askId, 'Market B, only the last 7 days.'), true);
  assert.equal(await pending, 'Market B, only the last 7 days.');
  assert.equal(broker.respond(owner, askId, 'duplicate'), false);
  assert.equal(events.at(-1).kind, 'agent.questionClosed');
});

test('cancel and timeout return no affirmative answer, including when the first option approves spending', async () => {
  const broker = new DesktopQuestions(10);
  const owner = {}, events = [];
  const first = broker.request(owner, 'Pay?', ['Approve', 'Cancel'], (kind, payload) => events.push({ kind, payload }));
  const second = broker.request(owner, 'Which market?', undefined, () => {});
  broker.cancel(owner);
  assert.equal(await first, '');
  assert.equal(await second, '');
  const timed = broker.request(owner, 'Pay?', ['Approve', 'Cancel'], () => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await timed, '');
  assert.equal(events.at(-1).kind, 'agent.questionClosed');
});
