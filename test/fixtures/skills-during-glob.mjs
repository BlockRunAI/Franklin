// Real serve + Glob in one child process, with deterministic slow local disk.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../../dist/serve/server.js';
import { globCapability } from '../../dist/tools/glob.js';
import { useWalletMode } from '../../dist/payments/auth-mode.js';

const scanRoot = process.env.FRANKLIN_TEST_SCAN_ROOT;
const directoryDelayMs = 12;
const pause = new Int32Array(new SharedArrayBuffer(4));
const isScanPath = (value) => String(value).startsWith(scanRoot);
const readSync = fs.readdirSync;
fs.readdirSync = function (dir, ...args) {
  if (isScanPath(dir)) Atomics.wait(pause, 0, 0, directoryDelayMs);
  return readSync.call(this, dir, ...args);
};
const readAsync = fs.promises.readdir;
fs.promises.readdir = async function (dir, ...args) {
  if (isScanPath(dir)) await delay(directoryDelayMs);
  return readAsync.call(this, dir, ...args);
};
let fileSearchStarted = false;
function announceFileSearch(file) {
  if (!isScanPath(file) || !String(file).endsWith('.txt')) return false;
  if (!fileSearchStarted) {
    fileSearchStarted = true;
    process.send({ type: 'file-search-started' });
  }
  return true;
}
const realpathSync = fs.realpathSync;
fs.realpathSync = function (file, ...args) {
  if (announceFileSearch(file)) Atomics.wait(pause, 0, 0, directoryDelayMs);
  return realpathSync.call(this, file, ...args);
};
const realpathAsync = fs.promises.realpath;
fs.promises.realpath = async function (file, ...args) {
  if (announceFileSearch(file)) await delay(directoryDelayMs);
  return realpathAsync.call(this, file, ...args);
};

let controller;
process.on('message', async (message) => {
  if (message.type === 'cancel-search') { controller?.abort(); return; }
  if (message.type !== 'start-search') return;
  controller = new AbortController();
  fileSearchStarted = false;
  process.send({ type: 'search-started' });
  const result = await globCapability.execute(
    { pattern: message.pattern || '**/scripts/factcheck.py', path: scanRoot },
    { workingDir: scanRoot, abortSignal: controller.signal },
  );
  process.send({ type: 'search-finished', result });
});

// Ignore the deliberately invalid credential fixture; management RPC does not
// initialize or use a wallet, and must not send a placeholder to any gateway.
useWalletMode();
await startServer({ port: 0, workDir: process.env.FRANKLIN_TEST_WORK_DIR });
