const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const base = require("./package.json").build;
const signed = process.env.FRANKLIN_SIGNED_RELEASE === "1";
if (signed && process.platform === "darwin") {
  for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    if (!process.env[name]) throw new Error(`Signed Desktop release requires ${name}; configure signing before publishing.`);
  }
}
module.exports = {
  ...base,
  forceCodeSigning: signed,
  mac: { ...base.mac, notarize: signed },
  async afterPack(context) {
    if (!signed || context.electronPlatformName !== "darwin") return;
    const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
    await fs.writeFile(path.join(resources, "franklin-signed-update.json"), JSON.stringify({ version: context.packager.appInfo.version }));
  },
  async afterSign(context) {
    if (!signed || context.electronPlatformName !== "darwin") return;
    const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    const details = await execFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
    if (!details.stderr.includes("Authority=Developer ID Application:") || !details.stderr.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`)) {
      throw new Error("Desktop release must be signed with this team's Developer ID Application certificate.");
    }
  },
};
