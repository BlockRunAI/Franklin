// Built renderer, synthetic socket. The real agent loop has a separate test.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
const server = spawn(process.execPath, ['../../node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5178', '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch('http://127.0.0.1:5178')).ok) break; } catch {}
    if (i > 100) throw new Error('Preview server did not start');
    await delay(100);
  }
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  const replies = [];
  let connection;
  await context.routeWebSocket(/\/agent/, socket => {
    connection = socket;
    let turn;
    const send = (id, kind, payload) => socket.send(JSON.stringify({ id, kind, payload }));
    socket.onMessage(raw => {
      const msg = JSON.parse(String(raw));
      if (msg.kind === 'agent.send') {
        turn = msg.id;
        send(turn, 'agent.questionAsk', { askId: 'q1', question: 'Which market and time range should I analyze?', options: ['Balance of Power', 'Another market'] });
      } else if (msg.kind === 'agent.questionResponse') {
        replies.push(msg.payload);
        send(turn, 'agent.questionClosed', { askId: msg.payload.askId });
        send(turn, 'agent.permissionAsk', { askId: 'p1', toolName: 'Bash', description: 'Example tool permission' });
      } else if (msg.kind === 'agent.permissionResponse') {
        replies.push(msg.payload);
        send(turn, 'agent.text', { text: 'Continued with your answer.' });
        send(turn, 'agent.done', {});
      } else {
        const payload = msg.kind === 'models.list' ? { models: [{ id: 'qa/model', label: 'QA model', group: 'Test' }] }
          : msg.kind === 'wallet.info' ? { address: '', chain: 'base', balanceUsd: 0 }
          : msg.kind === 'history.load' ? { conversations: [], projects: [] }
          : msg.kind === 'session.list' ? { sessions: [] } : {};
        send(msg.id, 'response', payload);
      }
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5178');
  await page.locator('textarea.try-input').fill('Analyze a prediction market');
  await page.locator('textarea.try-input').press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Franklin has a question' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Balance of Power', exact: true }).click();
  await dialog.getByLabel('Your answer').fill('Balance of Power, only the last 7 days. Explain missing data.');
  if (process.env.QUESTION_QA_SCREENSHOT) await page.screenshot({ path: process.env.QUESTION_QA_SCREENSHOT });
  await dialog.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByRole('dialog', { name: 'Franklin needs your approval' })).toBeVisible();
  expect(replies[0]).toEqual({ askId: 'q1', answer: 'Balance of Power, only the last 7 days. Explain missing data.' });
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  expect(replies[1]).toEqual({ askId: 'p1', decision: 'n' });
  await expect(page.getByText('Continued with your answer.', { exact: true })).toBeVisible();
  await page.locator('textarea.try-input').fill('Ask another question');
  await page.locator('textarea.try-input').press('Enter');
  await expect(dialog).toBeVisible();
  connection.close();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('WebSocket closed', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS: Desktop renderer accepts custom answers, keeps permissions separate, and resumes the conversation');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, 'exit'); server.kill(); await exited;
  }
}
