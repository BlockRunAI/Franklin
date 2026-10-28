// Real NSIS upgrade in an ephemeral Windows Actions runner. Never run against a
// developer/customer installation. Native macOS replacement needs a signed pair.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") throw new Error("In-place installer QA is confined to an ephemeral Windows Actions runner");
const pkg = JSON.parse(await fs.readFile(path.join(desktop, "package.json"), "utf8"));
const [major, minor, patch] = pkg.version.split("-")[0].split(".").map(Number);
const targetVersion = `${major}.${minor}.${patch + 1}-update-smoke.1`;
const qa = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "franklin-upgrade-"));
const target = path.join(qa, "target"), installed = path.join(qa, "installed");
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
});
const workerEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE", "GITHUB_ACTIONS"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(workerEnv, { HOME: qa, USERPROFILE: qa, APPDATA: path.join(qa, "roaming"), LOCALAPPDATA: path.join(qa, "local"), TMP: qa, TEMP: qa });
await Promise.all([fs.mkdir(workerEnv.APPDATA), fs.mkdir(workerEnv.LOCALAPPDATA)]);
const initialInstaller = path.join(desktop, "release", `Franklin.Setup.${pkg.version}.exe`);
await fs.access(initialInstaller);
await run(process.execPath, [require.resolve("electron-builder/cli.js"), "--config", "builder.config.cjs", "--win", "--x64", "--publish", "never", `--config.extraMetadata.version=${targetVersion}`, `--config.directories.output=${target}`], {
  cwd: desktop, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});
await run(initialInstaller, ["/S", `/D=${installed}`], { env: workerEnv });
const { extractFile } = require("@electron/asar");
const readVersion = () => JSON.parse(extractFile(path.join(installed, "resources/app.asar"), "package.json").toString()).version;
const until = async (predicate, label) => {
  const end = Date.now() + 90_000;
  while (Date.now() < end) { try { if (await predicate()) return; } catch { /* installer is replacing files */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(label);
};
await until(() => readVersion() === pkg.version, "Initial NSIS install did not finish");
const preserved = path.join(workerEnv.APPDATA, "Franklin", "update-qa-preserved.txt");
await fs.mkdir(path.dirname(preserved), { recursive: true }); await fs.writeFile(preserved, "Keep customer settings across updates");
const metadata = parse(await fs.readFile(path.join(target, "latest.yml"), "utf8"));
assert.equal(metadata.version, targetVersion);
const assets = await Promise.all(metadata.files.map(async (file) => {
  const hash = crypto.createHash("sha256"); for await (const chunk of createReadStream(path.join(target, file.url))) hash.update(chunk);
  return { name: file.url, size: file.size, digest: `sha256:${hash.digest("hex")}` };
}));
const server = http.createServer((req, res) => {
  const name = new URL(req.url, "http://127.0.0.1").pathname.slice(1);
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(404).end(); return; }
  fs.stat(path.join(target, name)).then((stat) => { res.writeHead(200, { "Content-Length": stat.size }); createReadStream(path.join(target, name)).pipe(res); }).catch(() => res.writeHead(404).end());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const feedUrl = `http://127.0.0.1:${server.address().port}/`;
const worker = path.join(qa, "upgrade.cjs");
await fs.writeFile(worker, `
const assert = require('node:assert/strict');
const {NsisUpdater} = require(${JSON.stringify(require.resolve("electron-updater"))});
const {NodeHttpExecutor} = require(${JSON.stringify(require.resolve("builder-util/out/nodeHttpExecutor"))});
const {createNativeInstaller} = require(${JSON.stringify(path.join(desktop, "electron/native-updates.cjs"))});
const app = {version: ${JSON.stringify(pkg.version)}, name: 'Franklin', isPackaged: true,
  appUpdateConfigPath: ${JSON.stringify(path.join(installed, "resources/app-update.yml"))},
  userDataPath: ${JSON.stringify(path.join(qa, "profile"))}, baseCachePath: ${JSON.stringify(path.join(qa, "cache"))},
  whenReady: async()=>{}, onQuit:()=>{}, quit:()=>{}, relaunch:()=>{}};
const updater = new NsisUpdater(null, app); updater.httpExecutor = new NodeHttpExecutor();
// Node owns this harness; NSIS itself performs the real silent replacement and
// relaunch. Electron's window shutdown is covered separately by native UI tests.
updater.quitAndInstall = (silent,relaunch)=>{assert.equal(silent,true);assert.equal(relaunch,true);assert.equal(updater.install(silent,relaunch),true);};
const native = createNativeInstaller({updater});
native.download(${JSON.stringify({ version: targetVersion, nativeFilename: metadata.files.find((f) => f.url.endsWith(".exe")).url, feedUrl, assets })},()=>{},new AbortController().signal)
  .then(downloaded=>native.install(downloaded)).then(()=>console.log('PASS actual NSIS silent upgrade and relaunch requested')).catch(error=>{console.error(error);process.exitCode=1;});
`);
try {
  await run(process.execPath, [worker], { env: workerEnv });
  await until(() => readVersion() === targetVersion, "Downloaded update was not installed in place");
  assert.equal(await fs.readFile(preserved, "utf8"), "Keep customer settings across updates");
  console.log(`PASS installed app advanced ${pkg.version} → ${targetVersion}; customer settings retained`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  // The test relaunches only this disposable runner's Franklin application.
  await run("taskkill", ["/F", "/IM", "Franklin.exe", "/T"]).catch(() => {});
}
