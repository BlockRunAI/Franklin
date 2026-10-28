// Real Electron UI + IPC + the real native adapter. The release feed, update
// bytes and native updater are fixtures; no real installer or paid model runs.
import { _electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentVersion = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8')).version;
const qa = await fs.mkdtemp(path.join(os.tmpdir(), 'franklin-updates-sidebar-'));
const entry = path.join(qa, 'main.cjs');
await fs.writeFile(entry, `
const crypto = require('node:crypto'), fs = require('node:fs/promises');
const {EventEmitter} = require('node:events');
const file = ${JSON.stringify(path.join(desktop, 'electron/updates.cjs'))};
const original = require(file);
const {createNativeInstaller} = require(${JSON.stringify(path.join(desktop, 'electron/native-updates.cjs'))});
const binary = Buffer.from('Disposable native update fixture. Never execute.');
const digest = 'sha256:' + crypto.createHash('sha256').update(binary).digest('hex');
const sha512 = crypto.createHash('sha512').update(binary).digest('base64');
const version = '0.2.0-beta.999', tag = 'desktop-v' + version;
const root = 'https://github.com/BlockRunAI/Franklin/releases/download/' + tag + '/';
const name = process.platform === 'darwin' ? 'Franklin-' + version + '-arm64.zip' : 'Franklin.Setup.' + version + '.exe';
global.updateQa = {calls: [], installs: [], offline: false, downloads: 0};
const updater = new EventEmitter();
updater.setFeedURL = () => {};
updater.checkForUpdates = async () => ({isUpdateAvailable: true, updateInfo: {version, files: [{url: name, sha512, size: binary.length}]}, cancellationToken: {cancel(){}}});
updater.downloadUpdate = async () => { global.updateQa.downloads++; updater.emit('download-progress', {percent: 42}); const target = ${JSON.stringify(path.join(qa, 'update.zip'))}; await fs.writeFile(target, binary); return [target]; };
updater.quitAndInstall = (...args) => global.updateQa.installs.push(args);
require.cache[file].exports = {...original, createDesktopUpdater(options) {
  const manager = original.createDesktopUpdater({...options, enabled: true,
    nativeInstaller: createNativeInstaller({updater, onError: error => manager.reportNativeError(error)}),
    fetchImpl: async url => {
      global.updateQa.calls.push(url); if(global.updateQa.offline) throw new Error('Simulated offline');
      const names = ['Franklin-' + version + '-arm64.dmg', 'Franklin.Setup.' + version + '.exe', name, process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml', 'SHA256SUMS.txt'];
      return new Response(JSON.stringify([{tag_name: tag, prerelease: true, draft: false, published_at: '2026-10-27', assets: [...new Set(names)].map(name => ({name, browser_download_url: root+name, state: 'uploaded', size: binary.length, digest}))}]));
    }, openInstaller: async () => {throw new Error('Manual installation is forbidden in this test');}
  }); global.updateQa.manager = manager; return manager;
}};
require(${JSON.stringify(path.join(desktop, 'electron/main.cjs'))});
`);
const app = await _electron.launch({executablePath: require('electron'), args: [entry, `--user-data-dir=${path.join(qa, 'profile')}`], env: {
  ...process.env, HOME: qa, USERPROFILE: qa, ELECTRON_RUN_AS_NODE: '', FRANKLIN_DESKTOP_DEV_URL: '', FRANKLIN_USE_MOCK: '1',
  FRANKLIN_AGENT_PORT: '0', FRANKLIN_CLOUD_PORT: '0', FRANKLIN_WORK_DIR: path.join(qa, 'workspace'), FRANKLIN_CLOUD_DATA_DIR: path.join(qa, 'cloud'),
  FRANKLIN_CLOUD_ENABLE_REAL_AGENT: '0', FRANKLIN_CLOUD_FAKE_AGENT: '1', FRANKLIN_TEAM_FAKE_AGENT: '1', FRANKLIN_TEAM_CLOUD_URL: 'http://127.0.0.1:1',
}});
const passed=[]; let page;
const check=async(name,run)=>{await run();passed.push(name);console.log('PASS '+name);};
try {
  await expect.poll(()=>app.windows().find(p=>p.url().endsWith('/dist/index.html')),{timeout:30000}).toBeTruthy();
  page=app.windows().find(p=>p.url().endsWith('/dist/index.html'));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const sidebar=page.locator('.try-sidebar');
  const settings=()=>page.getByRole('button',{name:'Settings',exact:true}).click();
  await check('startup adds a sidebar update action without interrupting the draft', async()=>{
    await settings();await expect(page.locator('.desktop-update-menu')).toContainText(currentVersion);await settings();
    await page.locator('textarea').fill('Keep this unsent draft during updates');
    await expect(sidebar.getByRole('button',{name:'Update Franklin',exact:true})).toBeVisible({timeout:40000});
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('textarea')).toHaveValue('Keep this unsent draft during updates');
    expect(await app.evaluate(()=>global.updateQa.calls.length)).toBe(1);expect(await app.evaluate(()=>global.updateQa.downloads)).toBe(0);
    await page.screenshot({path:path.join(qa,'sidebar-update-available.png')});
  });
  await check('one sidebar click downloads in-app and offers restart without opening an installer', async()=>{
    await sidebar.getByRole('button',{name:'Update Franklin',exact:true}).click();
    await expect(sidebar.getByRole('button',{name:'Restart to update',exact:true})).toBeEnabled();
    expect(await app.evaluate(()=>global.updateQa.downloads)).toBe(1);expect(await app.evaluate(()=>global.updateQa.installs.length)).toBe(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('textarea')).toHaveValue('Keep this unsent draft during updates');
  });
  await check('main-process activity guard rejects a restart during an active task', async()=>{
    const result=await page.evaluate(async()=>{await window.__FRANKLIN__.setUpdateTaskActive(true);return window.__FRANKLIN__.installDesktopUpdate();});
    expect(result.error).toBe('busy');expect(await app.evaluate(()=>global.updateQa.installs.length)).toBe(0);
    await page.evaluate(()=>window.__FRANKLIN__.setUpdateTaskActive(false));await app.evaluate(()=>global.updateQa.manager.check());
  });
  await check('offline update checks report a retryable error and recover', async()=>{
    await app.evaluate(async()=>{global.updateQa.offline=true;await global.updateQa.manager.check();});
    await settings();await page.locator('.desktop-update-menu').click();await expect(page.getByRole('alert')).toContainText('connection');
    await app.evaluate(()=>{global.updateQa.offline=false;});await page.getByRole('dialog').getByRole('button',{name:'Check for updates',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('button',{name:'Restart to update',exact:true})).toBeEnabled();await page.keyboard.press('Escape');
  });
  await check('Chinese dark sidebar remains compact after reload', async()=>{
    await page.evaluate(()=>{localStorage.setItem('franklin-try-ui-lang','zh');localStorage.setItem('franklin-webui-theme','dark');});
    await page.reload();await page.setViewportSize({width:1000,height:720});
    await expect(sidebar.getByRole('button',{name:'重启并更新',exact:true})).toBeVisible();
    const button=sidebar.getByRole('button',{name:'重启并更新',exact:true});expect(await button.evaluate(el=>getComputedStyle(el).fontSize)).toBe('12px');
    await page.screenshot({path:path.join(qa,'sidebar-update-chinese-dark.png')});
  });
  await check('restart action uses the standard silent installer and relaunch request once', async()=>{
    await sidebar.getByRole('button',{name:'重启并更新',exact:true}).click();
    await expect(sidebar.getByRole('button',{name:'正在重启更新…',exact:true})).toBeDisabled();
    expect(await app.evaluate(()=>global.updateQa.installs)).toEqual([[true,true]]);
  });
  expect(errors).toEqual([]);await fs.writeFile(path.join(qa,'results.json'),JSON.stringify({passed,errors,nativeUpdater:'fixture; silent restart request validated',realInstallerExecutions:0,paidModelCalls:0},null,2));
  console.log(`Sidebar update native QA: ${passed.length} passed; evidence ${qa}`);
} catch(error){await page?.screenshot({path:path.join(qa,'failure.png')}).catch(()=>{});console.error('Evidence: '+qa);throw error;}
finally{await app.close();}
