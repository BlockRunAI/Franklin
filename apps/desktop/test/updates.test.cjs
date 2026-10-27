const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDesktopUpdater, compareVersions, selectRelease, manifestHash } = require("../electron/updates.cjs");

const binary = Buffer.from("Disposable installer fixture. Never execute.");
const digest = crypto.createHash("sha256").update(binary).digest("hex");
function release(version = "0.2.0-beta.7", extra = {}) {
  const tag = `desktop-v${version}`;
  const base = `https://github.com/BlockRunAI/Franklin/releases/download/${tag}/`;
  return { tag_name: tag, draft: false, prerelease: version.includes("-"), published_at: "2026-10-27T00:00:00Z", assets: [
    { name: `Franklin-${version}-arm64.dmg`, browser_download_url: `${base}Franklin-${version}-arm64.dmg`, size: binary.length, state: "uploaded", digest: `sha256:${digest}` },
    { name: `Franklin.Setup.${version}.exe`, browser_download_url: `${base}Franklin.Setup.${version}.exe`, size: binary.length, state: "uploaded", digest: `sha256:${digest}` },
    { name: "SHA256SUMS.txt", browser_download_url: `${base}SHA256SUMS.txt`, size: 300, state: "uploaded" },
  ], ...extra };
}
function response(url, releases = [release()]) {
  if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(releases));
  if (url.endsWith("SHA256SUMS.txt")) return new Response(`${digest}  Franklin-0.2.0-beta.7-arm64.dmg\n${digest}  Franklin.Setup.0.2.0-beta.7.exe\n`);
  return new Response(binary);
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "franklin-update-unit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const opened = [], requests = [], states = [];
  const updater = createDesktopUpdater({ currentVersion: "0.2.0-beta.6", platform: "darwin", arch: "arm64", directory,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return response(url); },
    openInstaller: async (file) => { opened.push(file); return ""; }, onChange: (state) => states.push(state), ...options });
  return { updater, opened, requests, states, directory };
}

test("semver compares numeric beta identifiers and stable versions without downgrades", () => {
  assert.equal(compareVersions("0.2.0-beta.10", "0.2.0-beta.9"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0-rc.99"), 1);
  assert.equal(compareVersions("0.2.0-beta.6", "0.2.0-beta.6"), 0);
  assert.equal(compareVersions("0.2.0-beta.1", "0.2.0-beta"), 1);
  assert.equal(compareVersions("0.2.0-1", "0.2.0-beta"), -1);
  for (const invalid of ["v0.2.0", "0.2.0-beta.01", "01.2.0", "no-version"]) assert.throws(() => compareVersions(invalid, "0.2.0"));
});

test("Desktop beta checks exclude CLI tags and drafts and select the highest version", () => {
  const list = [release("0.2.0-beta.7"), release("0.2.0-beta.10"), release("9.0.0", { tag_name: "v9.0.0" }), release("2.0.0", { draft: true }), release("3.0.0", { published_at: null })];
  assert.equal(selectRelease(list, "0.2.0-beta.6", "darwin", "arm64").version, "0.2.0-beta.10");
  assert.equal(selectRelease(list, "0.2.0-beta.10", "darwin", "arm64"), null);
  assert.equal(selectRelease([release("0.2.0-beta.7")], "0.2.0", "win32", "x64"), null);
  assert.equal(selectRelease([release("0.3.0")], "0.2.0", "win32", "x64").filename, "Franklin.Setup.0.3.0.exe");
});

test("incomplete newest releases and foreign installer URLs fail closed", () => {
  const broken = release("0.2.0-beta.8", { assets: [] });
  assert.throws(() => selectRelease([release(), broken], "0.2.0-beta.6", "darwin", "arm64"), /feed/);
  for (const url of ["https://evil.example/installer.dmg", "https://github.com/Other/Repo/releases/download/x/a.dmg", "file:///tmp/a.dmg"]) {
    const foreign = release(); foreign.assets[0].browser_download_url = url;
    assert.throws(() => selectRelease([foreign], "0.2.0-beta.6", "darwin", "arm64"), /feed/);
  }
  assert.throws(() => manifestHash(`${digest}  a.dmg\n${digest}  a.dmg`, "a.dmg"), /verification/);
});

test("checking only reads public metadata; downloads and installer launches require separate actions", async (t) => {
  const { updater, requests, opened, states, directory } = await fixture(t);
  assert.equal((await updater.check()).status, "available");
  assert.equal(requests.length, 1); assert.deepEqual(await fs.readdir(directory), []); assert.deepEqual(opened, []);
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal((await updater.download()).status, "downloaded");
  assert.equal(updater.getState().progress, 100); assert.deepEqual(opened, []);
  assert.equal((await updater.install()).status, "downloaded");
  assert.equal(opened.length, 1); assert.deepEqual(await fs.readFile(opened[0]), binary);
  assert.ok(states.some((state) => state.status === "downloading"));
  assert.ok(updater.getState().openedAt);
});

test("Windows selects its own verified NSIS installer", async (t) => {
  const { updater, opened } = await fixture(t, { platform: "win32", arch: "x64" });
  await updater.check(); await updater.download(); await updater.install();
  assert.ok(opened[0].endsWith("Franklin.Setup.0.2.0-beta.7.exe"));
});

test("a current version, development build and unsupported CPU never download anything", async (t) => {
  for (const options of [{ currentVersion: "0.2.0-beta.7" }, { enabled: false }, { arch: "x64" }]) {
    const { updater, requests } = await fixture(t, options);
    await updater.check(); await updater.download(); await updater.install();
    assert.equal(requests.length, options.currentVersion ? 1 : 0);
  }
});

test("release pagination finds Desktop releases after many CLI releases", async (t) => {
  const { updater, requests } = await fixture(t, { fetchImpl: async (url) => {
    requests.push({ url });
    return response(url, url.endsWith("page=1") ? Array.from({ length: 100 }, () => release("9.0.0", { tag_name: "v9.0.0" })) : [release()]);
  } });
  assert.equal((await updater.check()).version, "0.2.0-beta.7"); assert.equal(requests.length, 2);
});

test("offline and GitHub rate limits produce retryable states", async (t) => {
  let offline = true;
  const { updater } = await fixture(t, { fetchImpl: async (url) => { if (offline) throw new Error("offline"); return response(url); } });
  assert.equal((await updater.check()).status, "error");
  offline = false; assert.equal((await updater.check()).status, "available");
  const limited = await fixture(t, { fetchImpl: async () => new Response("limited", { status: 403 }) });
  assert.equal((await limited.updater.check()).error, "rateLimit");
});

test("mismatched hashes, oversized/truncated downloads and conflicting manifests never open", async (t) => {
  for (const mode of ["hash", "short", "long", "manifest", "digest"]) {
    const { updater, opened, directory } = await fixture(t, { fetchImpl: async (url) => {
      if (url.startsWith("https://api.github.com/")) {
        const item = release(); if (mode === "digest") item.assets[0].digest = `sha256:${"0".repeat(64)}`;
        return response(url, [item]);
      }
      if (url.endsWith("SHA256SUMS.txt")) return mode === "manifest" ? new Response("untrusted manifest") : response(url);
      return new Response(mode === "hash" ? Buffer.alloc(binary.length) : mode === "short" ? binary.subarray(1) : mode === "long" ? Buffer.concat([binary, binary]) : binary);
    } });
    await updater.check(); const result = await updater.download();
    assert.equal(result.error, "verification", mode); await updater.install();
    assert.deepEqual(opened, [], mode); assert.deepEqual(await fs.readdir(directory), [], mode);
  }
});

test("redirects cannot escape GitHub's asset hosts", async (t) => {
  const seen = [];
  const { updater } = await fixture(t, { fetchImpl: async (url) => {
    seen.push(url);
    return url.startsWith("https://api.github.com/") ? response(url) : new Response(null, { status: 302, headers: { location: "https://evil.example/a.dmg" } });
  } });
  await updater.check(); assert.equal((await updater.download()).error, "feed");
  assert.ok(!seen.some((url) => url.includes("evil.example")));
});

test("duplicate checks and downloads share one operation", async (t) => {
  let count = 0;
  const { updater } = await fixture(t, { fetchImpl: async (url) => { count++; return response(url); } });
  await Promise.all([updater.check(), updater.check(), updater.check()]); assert.equal(count, 1);
  await Promise.all([updater.download(), updater.download(), updater.download()]); assert.equal(count, 3);
});

test("cancelling removes partial downloads and permits retry", async (t) => {
  let slow = true, downloading;
  const started = new Promise((resolve) => { downloading = resolve; });
  const { updater, directory } = await fixture(t, { fetchImpl: async (url, { signal }) => {
    if (url.startsWith("https://api.github.com/") || url.endsWith("SHA256SUMS.txt") || !slow) return response(url);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(binary.subarray(0, 5));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }); downloading();
    } }));
  } });
  await updater.check(); const pending = updater.download(); await started; updater.cancel();
  assert.equal((await pending).status, "available"); assert.deepEqual(await fs.readdir(directory), []);
  slow = false; assert.equal((await updater.download()).status, "downloaded");
});

test("a modified or removed downloaded installer is never opened and can be downloaded again", async (t) => {
  for (const remove of [false, true]) {
    const { updater, directory, opened } = await fixture(t);
    await updater.check(); await updater.download();
    const [folder] = await fs.readdir(directory); const file = path.join(directory, folder, "Franklin-0.2.0-beta.7-arm64.dmg");
    if (remove) await fs.rm(file); else await fs.writeFile(file, Buffer.alloc(binary.length));
    assert.equal((await updater.install()).error, "verification"); assert.deepEqual(opened, []);
    assert.equal((await updater.download()).status, "downloaded");
  }
});

test("OS installer errors remain visible and can be retried without redownloading", async (t) => {
  let fail = true;
  const { updater } = await fixture(t, { openInstaller: async () => fail ? "OS refused" : "" });
  await updater.check(); await updater.download(); assert.equal((await updater.install()).error, "open");
  fail = false; assert.equal((await updater.install()).status, "downloaded");
});
