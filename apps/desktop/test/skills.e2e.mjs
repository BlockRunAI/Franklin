// Real Electron + real bundled/local Franklin skill backend. Wallet/catalog are
// stubbed, and agent.send is rejected: this checks readiness without inference.
import { _electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = await fs.mkdtemp(path.join(os.tmpdir(), 'franklin-skills-native-'));
const weather = await fs.readFile(path.join(desktop, '../../test/fixtures/openclaw-weather/SKILL.md'), 'utf8');
const executable = process.env.FRANKLIN_TEST_EXECUTABLE || require('electron');
const packaged = !!process.env.FRANKLIN_TEST_EXECUTABLE;
const app = await _electron.launch({
  executablePath: executable,
  args: [...(packaged ? [] : [path.join(desktop, 'electron/main.cjs')]), `--user-data-dir=${path.join(qa, 'profile')}`],
  env: { ...process.env, HOME: qa, USERPROFILE: qa, ELECTRON_RUN_AS_NODE: '', FRANKLIN_DESKTOP_DEV_URL: '',
    FRANKLIN_USE_MOCK: '0', FRANKLIN_AGENT_PORT: '0', FRANKLIN_CLOUD_PORT: '0',
    FRANKLIN_WORK_DIR: path.join(qa, 'workspace'), FRANKLIN_CLOUD_DATA_DIR: path.join(qa, 'cloud'),
    FRANKLIN_CLOUD_ENABLE_REAL_AGENT: '0', FRANKLIN_CLOUD_FAKE_AGENT: '1', FRANKLIN_TEAM_FAKE_AGENT: '1',
    FRANKLIN_TEAM_CLOUD_URL: 'http://127.0.0.1:1' },
});
let startupLog = '';
app.process().stdout?.on('data', (data) => { startupLog += data; });
app.process().stderr?.on('data', (data) => { startupLog += data; });
const passed = [], rpcKinds = []; let sends = 0;
const check = async (name, run) => { await run(); passed.push(name); console.log('PASS ' + name); };
try {
  await app.context().routeWebSocket(/ws:\/\/127\.0\.0\.1:\d+\/agent/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.kind === 'agent.send') { sends++; throw new Error('Inference is forbidden in this test'); }
      const payload = msg.kind === 'wallet.info' ? { address: '', chain: 'base', balanceUsd: 0 }
        : msg.kind === 'models.list' ? { models: [{ id: 'qa/model', label: 'Readiness test', group: 'Test' }] }
        : msg.kind.startsWith('wallet.') ? {} : null;
      if (payload) socket.send(JSON.stringify({ id: msg.id, kind: 'response', payload }));
      else { rpcKinds.push(msg.kind); server.send(raw); }
    });
    server.onMessage((raw) => socket.send(raw));
  });
  await expect.poll(() => app.windows().find((p) => p.url().endsWith('/dist/index.html')), { timeout: 30000 }).toBeTruthy();
  const page = app.windows().find((p) => p.url().endsWith('/dist/index.html'));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.webContents.getURL().endsWith('/dist/index.html'))), { timeout: 30000 }).toBe(true);
  await page.reload();
  const errors = []; page.on('pageerror', (err) => errors.push(err.message));
  const skillsPage = async () => {
    const side = page.locator('.try-sidebar');
    if (!await side.evaluate((el) => el.classList.contains('is-open'))) await page.locator('.try-chat-bar').getByRole('button', { name: 'Toggle history', exact: true }).click();
    await side.getByRole('button', { name: 'More', exact: true }).click();
    await page.locator('.try-more-flyout').getByRole('button', { name: 'Skills', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Installed skills' })).toBeVisible();
  };
  const importText = async (text) => {
    await page.getByRole('button', { name: 'Add skill', exact: true }).click();
    await page.getByRole('textbox', { name: 'Paste the complete SKILL.md or choose a file' }).fill(text);
    await page.getByRole('button', { name: 'Import skill', exact: true }).click();
  };
  await skillsPage();
  await check('installed bundled registry loads from real runtime', async () => {
    await expect(page.locator('[data-skill="budget-grill"]')).toBeVisible();
  });
  await check('unmodified public API weather Skill imports through native UI', async () => {
    await importText(weather); await expect(page.locator('[data-skill="weather"]')).toBeVisible();
    expect(await fs.readFile(path.join(qa, '.blockrun/skills/weather/SKILL.md'), 'utf8')).toBe(weather);
  });
  await check('duplicate import reports backend error and preserves installed content', async () => {
    await importText(weather); await expect(page.getByRole('alert')).toContainText('already exists');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  await check('invalid import reports parse error', async () => {
    await importText('not a skill'); await expect(page.getByRole('alert')).toContainText('frontmatter');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  const card = page.locator('[data-skill="weather"]');
  await check('toggle persists and refresh retains disabled state', async () => {
    await card.getByRole('switch').click(); await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Refresh skills' }).click(); await expect(card.getByRole('button', { name: 'Use in chat' })).toBeDisabled();
    await card.getByRole('switch').click(); await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
  await check('Use in chat prepares explicit slash draft without model execution', async () => {
    await card.getByRole('button', { name: 'Use in chat' }).click();
    await expect(page.locator('textarea')).toHaveValue('/weather ');
  });
  await check('real runtime resolves imported instructions and retains user arguments', async () => {
    const result = await page.evaluate(async () => {
      const socket = new WebSocket(window.__FRANKLIN__.agentUrl);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('Readiness timeout')); }, 5000);
        socket.onopen = () => socket.send(JSON.stringify({ id: 'readiness', kind: 'skills.resolve', payload: { input: '/weather Reykjavik tomorrow' } }));
        socket.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id !== 'readiness') return; clearTimeout(timer); socket.close(); if (msg.kind === 'error') reject(new Error(msg.payload.message)); else resolve(msg.payload); };
      });
    });
    expect(result.name).toBe('weather'); expect(result.prompt).toContain('User request:\nReykjavik tomorrow');
  });
  await skillsPage();
  await check('native file picker imports local requirements with supporting-file notice', async () => {
    await page.getByRole('button', { name: 'Add skill', exact: true }).click();
    await page.getByLabel('SKILL.md file').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: local-check\ndescription: Requires a script\n---\nRun `python scripts/check.py` on a local CSV.') });
    await expect(page.locator('#skill-content')).toHaveValue(/local-check/);
    await page.getByRole('button', { name: 'Import skill', exact: true }).click();
    await expect(page.locator('[data-skill="local-check"]')).toContainText('supporting files');
  });
  await check('remove and refresh delete only the disposable imported skills', async () => {
    for (const name of ['weather', 'local-check']) {
      const row = page.locator(`[data-skill="${name}"]`);
      await row.getByRole('button', { name: 'Remove', exact: true }).click();
      await row.getByRole('button', { name: 'Confirm remove' }).click(); await expect(row).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Refresh skills' }).click(); await expect(card).toHaveCount(0);
    await expect(page.locator('[data-skill="budget-grill"]')).toBeVisible();
  });
  expect(errors).toEqual([]); expect(sends).toBe(0);
  for (const kind of ['skills.list', 'skills.upload', 'skills.toggle', 'skills.resolve', 'skills.remove']) expect(rpcKinds).toContain(kind);
  await page.screenshot({ path: path.join(qa, 'skills-native.png') });
  await fs.writeFile(path.join(qa, 'results.json'), JSON.stringify({ packaged, passed, sends, skillRpcKinds: [...new Set(rpcKinds.filter((k) => k.startsWith('skills.')))], errors }, null, 2));
  console.log(`Skills native QA: ${passed.length} passed; zero inference sends; evidence ${qa}`);
} catch (err) {
  const page = app.windows().find((p) => p.url().endsWith('/dist/index.html'));
  await page?.screenshot({ path: path.join(qa, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${qa}`);
  for (const window of app.windows()) console.error(await window.locator('body').innerText().catch(() => 'closed window'));
  console.error(startupLog.slice(-4000)); throw err;
} finally { await app.close(); }
