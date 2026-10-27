// Desktop updates come only from this repository's public, published releases.
// No wallet, model, agent tool, npm version or renderer-provided URL is involved.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");

const REPOSITORY = "BlockRunAI/Franklin";
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

class UpdateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split(".") ?? [];
  if (core.some((n) => !Number.isSafeInteger(n)) || pre.some((p) => /^\d+$/.test(p) && (p.length > 1 && p[0] === "0"))) return null;
  return { core, pre };
}

function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new UpdateError("feed");
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function assetUrl(asset, tag) {
  if (!asset || typeof asset.name !== "string" || !/^[\w.-]+$/.test(asset.name)) throw new UpdateError("feed");
  const expected = `https://github.com/${REPOSITORY}/releases/download/${tag}/${asset.name}`;
  if (asset.browser_download_url !== expected || asset.state !== "uploaded") throw new UpdateError("feed");
  return expected;
}

function selectRelease(releases, currentVersion, platform, arch) {
  const current = parseVersion(currentVersion);
  if (!Array.isArray(releases) || !current) throw new UpdateError("feed");
  const candidates = releases.filter((release) => {
    if (!release || release.draft || !release.published_at || typeof release.tag_name !== "string") return false;
    const version = release.tag_name.replace(/^desktop-v/, "");
    const parsed = parseVersion(version);
    return release.tag_name.startsWith("desktop-v") && parsed && (current.pre.length || (!release.prerelease && !parsed.pre.length)) && compareVersions(version, currentVersion) > 0;
  }).sort((a, b) => compareVersions(b.tag_name.slice(9), a.tag_name.slice(9)));
  if (!candidates.length) return null;
  // Fail visibly if the newest release is incomplete, rather than silently
  // installing an older release while a broken publication goes unnoticed.
  const release = candidates[0], version = release.tag_name.slice(9), tag = release.tag_name;
  const filename = platform === "darwin" && arch === "arm64" ? `Franklin-${version}-arm64.dmg`
    : platform === "win32" && arch === "x64" ? `Franklin.Setup.${version}.exe` : null;
  if (!filename) throw new UpdateError("unsupported");
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matching = assets.filter((asset) => asset.name === filename);
  const manifests = assets.filter((asset) => asset.name === "SHA256SUMS.txt");
  if (matching.length !== 1 || manifests.length !== 1) throw new UpdateError("feed");
  const asset = matching[0];
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) throw new UpdateError("feed");
  return {
    version, releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    filename, size: asset.size, url: assetUrl(asset, tag), manifestUrl: assetUrl(manifests[0], tag),
    digest: asset.digest,
  };
}

function manifestHash(text, filename) {
  const matches = text.split(/\r?\n/).map((line) => /^([\da-f]{64})\s+\*?(.+)$/i.exec(line)).filter((match) => match?.[2] === filename);
  if (matches.length !== 1) throw new UpdateError("verification");
  return matches[0][1].toLowerCase();
}

async function limitedBody(response, limit) {
  if (!response.body) throw new UpdateError("network");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new UpdateError("feed");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createDesktopUpdater({ currentVersion, platform, arch, directory, enabled = true, fetchImpl = fetch, openInstaller, onChange = () => {} }) {
  const supported = (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64");
  let state = { status: !enabled ? "disabled" : !supported ? "unsupported" : "idle", currentVersion, platform };
  let candidate = null, downloaded = null, pending = null, controller = null;
  const getState = () => ({ ...state });
  const publish = (patch) => { state = { ...state, ...patch }; onChange(getState()); return getState(); };
  const fail = (error) => error instanceof UpdateError && error.code === "cancelled"
    ? publish({ status: "available", progress: undefined, error: undefined })
    : publish({ status: "error", error: error instanceof UpdateError ? error.code : "network" });

  async function request(url, signal, api = false) {
    for (let hops = 0; hops < 5; hops++) {
      const target = new URL(url);
      const valid = api ? target.origin === "https://api.github.com" && target.pathname === `/repos/${REPOSITORY}/releases`
        : target.protocol === "https:" && DOWNLOAD_HOSTS.has(target.hostname);
      if (!valid || target.username || target.password) throw new UpdateError("feed");
      const response = await fetchImpl(url, { redirect: "manual", signal, headers: {
        "User-Agent": "Franklin-Desktop-Updates", Accept: api ? "application/vnd.github+json" : "application/octet-stream",
      } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new UpdateError("network");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new UpdateError(response.status === 429 || response.status === 403 ? "rateLimit" : "network"); }
      return response;
    }
    throw new UpdateError("network");
  }

  // All callers share the same in-flight operation. Repeated settings clicks
  // cannot spawn downloads, checks, or installers in parallel.
  function operation(run) {
    if (pending) return pending;
    pending = Promise.resolve().then(run).catch(fail).finally(() => { pending = null; controller = null; });
    return pending;
  }

  function check() {
    if (!enabled || !supported) return Promise.resolve(getState());
    return operation(async () => {
      publish({ status: "checking", error: undefined });
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 20_000);
      try {
        const releases = [];
        // CLI and Desktop share a repository. Include prereleases and walk all
        // pages; /releases/latest would omit Desktop betas altogether.
        for (let page = 1; page <= 10; page++) {
          const response = await request(`${RELEASES_API}&page=${page}`, controller.signal, true);
          let batch;
          try { batch = JSON.parse(await limitedBody(response, 4 * 1024 * 1024)); }
          catch (error) { if (error instanceof SyntaxError) throw new UpdateError("feed"); throw error; }
          if (!Array.isArray(batch)) throw new UpdateError("feed");
          releases.push(...batch);
          if (batch.length < 100) break;
          if (page === 10) throw new UpdateError("feed");
        }
        const latest = selectRelease(releases, currentVersion, platform, arch);
        if (!latest || latest.version !== candidate?.version) downloaded = null;
        candidate = latest;
        return publish({ status: !latest ? "current" : downloaded ? "downloaded" : "available", version: latest?.version,
          releaseUrl: latest?.releaseUrl, progress: downloaded ? 100 : undefined, openedAt: downloaded ? state.openedAt : undefined, checkedAt: Date.now() });
      } finally { clearTimeout(timer); }
    });
  }

  function download() {
    if (!enabled || !supported || !candidate) return Promise.resolve(getState());
    if (downloaded) return Promise.resolve(getState());
    return operation(async () => {
      const release = candidate;
      publish({ status: "downloading", progress: 0, error: undefined });
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 15 * 60_000);
      let folder, handle;
      try {
        const manifest = await request(release.manifestUrl, controller.signal);
        const expected = manifestHash(await limitedBody(manifest, 64 * 1024), release.filename);
        if (release.digest && release.digest !== `sha256:${expected}`) throw new UpdateError("verification");
        const response = await request(release.url, controller.signal);
        if (!response.body) throw new UpdateError("network");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        // Old completed/abandoned downloads are disposable. A locked Windows
        // installer can remain until the next download without blocking it.
        for (const entry of await fs.readdir(directory)) {
          if (/^download-[\w-]+$/.test(entry)) await fs.rm(path.join(directory, entry), { recursive: true, force: true }).catch(() => {});
        }
        folder = await fs.mkdtemp(path.join(directory, "download-"));
        handle = await fs.open(path.join(folder, "installer.partial"), "wx", 0o600);
        const hash = crypto.createHash("sha256"); let received = 0, progress = 0;
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > release.size) throw new UpdateError("verification");
          hash.update(chunk); await handle.writeFile(chunk);
          const next = Math.min(99, Math.floor(received / release.size * 100));
          if (next !== progress) { progress = next; publish({ progress }); }
        }
        await handle.close(); handle = null;
        if (received !== release.size || hash.digest("hex") !== expected) throw new UpdateError("verification");
        const file = path.join(folder, release.filename);
        await fs.rename(path.join(folder, "installer.partial"), file);
        downloaded = { file, hash: expected, size: received };
        return publish({ status: "downloaded", progress: 100 });
      } catch (error) {
        await handle?.close().catch(() => {});
        if (folder) await fs.rm(folder, { recursive: true, force: true });
        throw error;
      } finally { clearTimeout(timer); }
    });
  }

  function install() {
    if (!downloaded || !enabled) return Promise.resolve(getState());
    return operation(async () => {
      publish({ status: "opening", error: undefined });
      // Check again immediately before opening; a changed file is never run.
      try {
        const hash = crypto.createHash("sha256"); let size = 0;
        for await (const chunk of createReadStream(downloaded.file)) {
          size += chunk.length;
          if (size > downloaded.size) throw new UpdateError("verification");
          hash.update(chunk);
        }
        if (size !== downloaded.size || hash.digest("hex") !== downloaded.hash) throw new UpdateError("verification");
      } catch {
        await fs.rm(path.dirname(downloaded.file), { recursive: true, force: true }); downloaded = null;
        throw new UpdateError("verification");
      }
      const error = await openInstaller(downloaded.file);
      if (error) throw new UpdateError("open");
      return publish({ status: "downloaded", openedAt: Date.now() });
    });
  }

  function cancel() {
    if (state.status === "downloading") controller?.abort(new UpdateError("cancelled"));
  }
  return { getState, check, download, install, cancel };
}

module.exports = { createDesktopUpdater, compareVersions, selectRelease, manifestHash };
