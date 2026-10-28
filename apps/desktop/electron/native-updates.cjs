const crypto = require("node:crypto");
const { createReadStream } = require("node:fs");

function updateError(code) { return Object.assign(new Error(code), { updateCode: code }); }

function validateNativeInfo(info, release) {
  if (!info || info.version !== release.version || info.packages || !Array.isArray(info.files) || !info.files.length) throw updateError("feed");
  for (const file of info.files) {
    const asset = release.assets.find((entry) => entry.name === file.url);
    // Resolve only exact, relative asset names from the selected Desktop tag.
    // No secondary download servers, paths or NSIS web-installer packages.
    if (!asset || !/^[\w.-]+$/.test(file.url) || typeof file.sha512 !== "string" || Buffer.from(file.sha512, "base64").length !== 64 || file.size !== asset.size) throw updateError("feed");
  }
  if (!info.files.some((file) => file.url === release.nativeFilename)) throw updateError("feed");
}

async function verifyFile(file, asset) {
  const hash = crypto.createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > asset.size) throw updateError("verification");
    hash.update(chunk);
  }
  const digest = hash.digest("hex");
  if (size !== asset.size || (asset.digest && asset.digest !== `sha256:${digest}`)) throw updateError("verification");
  return { file, size, digest: `sha256:${digest}` };
}

function createNativeInstaller({ updater, onError = () => {} }) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  // Do not write full signed download URLs to logs.
  updater.logger = null;
  let installing = false;
  updater.on("error", (error) => { if (installing) { installing = false; onError(error); } });
  return {
    async download(release, onProgress, signal) {
      updater.setFeedURL({ provider: "generic", url: release.feedUrl, channel: "latest", useMultipleRangeRequest: false });
      updater.allowPrerelease = release.version.includes("-");
      updater.allowDowngrade = false;
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) throw updateError("feed");
      validateNativeInfo(result.updateInfo, release);
      const progress = (event) => onProgress(Math.max(0, Math.min(99, Math.floor(event.percent))));
      const cancel = () => result.cancellationToken.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      updater.on("download-progress", progress);
      try {
        if (signal.aborted) throw signal.reason;
        const files = await updater.downloadUpdate(result.cancellationToken);
        if (signal.aborted) throw signal.reason;
        if (!Array.isArray(files) || files.length !== 1) throw updateError("verification");
        return await verifyFile(files[0], release.assets.find((asset) => asset.name === release.nativeFilename));
      } catch (error) { if (signal.aborted) throw signal.reason; throw error; }
      finally { signal.removeEventListener("abort", cancel); updater.removeListener("download-progress", progress); }
    },
    async install(downloaded, canInstall = () => true) {
      await verifyFile(downloaded.file, downloaded);
      if (!canInstall()) throw updateError("busy");
      installing = true;
      // NSIS installs silently, then relaunches. Squirrel.Mac validates the code
      // signature, replaces the app and relaunches it using the native helper.
      updater.quitAndInstall(true, true);
    },
  };
}

module.exports = { createNativeInstaller, validateNativeInfo, verifyFile };
