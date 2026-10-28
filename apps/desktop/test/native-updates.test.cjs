const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createNativeInstaller, validateNativeInfo } = require("../electron/native-updates.cjs");
const { createDesktopUpdater } = require("../electron/updates.cjs");
const body = Buffer.from("Native update QA payload; never executed");
const sha512 = crypto.createHash("sha512").update(body).digest("base64");
const digest = `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
const version = "0.2.0-beta.7", filename = `Franklin-${version}-arm64.zip`;
const release = { version, nativeFilename: filename, feedUrl: `https://github.com/BlockRunAI/Franklin/releases/download/desktop-v${version}/`, assets: [{ name: filename, size: body.length, digest }] };
const info = () => ({ version, files: [{ url: filename, sha512, size: body.length }] });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "franklin-native-updater-unit-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, filename); const updater = new EventEmitter(); let calls = [], cancel = false;
  updater.setFeedURL = (value) => calls.push(["feed", value]);
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: info(), cancellationToken: { cancel() { cancel = true; } } });
  updater.downloadUpdate = async () => { calls.push(["download"]); updater.emit("download-progress", { percent: 47.9 }); await fs.writeFile(file, body); return [file]; };
  updater.quitAndInstall = (...args) => calls.push(["install", ...args]);
  const errors = []; const installer = createNativeInstaller({ updater, onError: (error) => errors.push(error) });
  return { updater, installer, calls, errors, file, directory, cancelled: () => cancel };
}
test("native metadata cannot change the selected release, asset host, file size or installer type", () => {
  validateNativeInfo(info(), release);
  for (const change of [{ version: "0.1.0" }, { packages: {} }, { files: [{ url: "https://evil.example/a.zip", sha512, size: body.length }] }, { files: [{ url: filename, sha512, size: 1 }] }, { files: [{ url: filename, sha512: "invalid", size: body.length }] }]) assert.throws(() => validateNativeInfo({ ...info(), ...change }, release));
});
test("download stays in-app with progress and never registers automatic installation on quit", async (t) => {
  const { updater, installer, calls } = await fixture(t), progress = [];
  const downloaded = await installer.download(release, (value) => progress.push(value), new AbortController().signal);
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.allowDowngrade, false); assert.equal(updater.disableWebInstaller, true);
  assert.equal(downloaded.digest, digest); assert.deepEqual(progress, [47]); assert.ok(!calls.some(([kind]) => kind === "install"));
  assert.equal(updater.listenerCount("download-progress"), 0);
});
test("explicit installation rechecks the file and requests silent install with relaunch", async (t) => {
  const { installer, calls } = await fixture(t);
  const downloaded = await installer.download(release, () => {}, new AbortController().signal); await installer.install(downloaded);
  assert.deepEqual(calls.at(-1), ["install", true, true]);
});
test("changing an already downloaded file prevents installer execution", async (t) => {
  const { installer, file, calls } = await fixture(t);
  const downloaded = await installer.download(release, () => {}, new AbortController().signal);
  await fs.writeFile(file, Buffer.alloc(body.length)); await assert.rejects(installer.install(downloaded), /verification/);
  assert.ok(!calls.some(([kind]) => kind === "install"));
});
test("task activity is rechecked immediately before installation", async (t) => {
  const { installer, calls } = await fixture(t);
  const downloaded = await installer.download(release, () => {}, new AbortController().signal);
  await assert.rejects(installer.install(downloaded, () => false), /busy/); assert.ok(!calls.some(([kind]) => kind === "install"));
});
test("cancel before transfer prevents the native download", async (t) => {
  const { installer, calls } = await fixture(t); const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(installer.download(release, () => {}, controller.signal), /cancelled/); assert.ok(!calls.some(([kind]) => kind === "download"));
});
test("asynchronous native signature failures remain visible after the restart request", async (t) => {
  const { installer, updater, errors } = await fixture(t);
  const downloaded = await installer.download(release, () => {}, new AbortController().signal); await installer.install(downloaded);
  updater.emit("error", new Error("Code signature rejected")); assert.equal(errors.length, 1);
});
test("the Desktop manager only chooses automatic updates when both native support and metadata exist", async (t) => {
  const { installer, calls, directory } = await fixture(t);
  const names = [`Franklin-${version}-arm64.dmg`, filename, "latest-mac.yml", "SHA256SUMS.txt"];
  const releases = [{ tag_name: `desktop-v${version}`, prerelease: true, published_at: "2026-10-27", assets: names.map((name) => ({ name, size: body.length, state: "uploaded", digest, browser_download_url: release.feedUrl + name })) }];
  let active = true;
  const manager = createDesktopUpdater({ currentVersion: "0.2.0-beta.6", platform: "darwin", arch: "arm64", directory,
    nativeInstaller: installer, canInstall: () => !active, fetchImpl: async () => new Response(JSON.stringify(releases)), openInstaller: async () => { throw new Error("Manual installer must not open"); } });
  assert.equal((await manager.check()).installMode, "automatic"); assert.equal((await manager.download()).status, "downloaded");
  assert.equal((await manager.install()).error, "busy"); assert.ok(!calls.some(([kind]) => kind === "install"));
  active = false; assert.equal((await manager.install()).status, "installing"); await manager.install();
  assert.equal(calls.filter(([kind]) => kind === "install").length, 1);
});
