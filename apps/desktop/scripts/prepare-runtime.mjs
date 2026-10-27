import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDist = resolve(desktopDir, "..", "..", "dist");
const runtimeRoot = resolve(desktopDir, "franklin-agent");
const runtimeDist = resolve(runtimeRoot, "dist");

if (!existsSync(resolve(sourceDist, "index.js"))) {
  throw new Error("Franklin runtime is not built. Run the repository build first.");
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });
cpSync(sourceDist, runtimeDist, { recursive: true, dereference: true });
const sourcePackage = JSON.parse(readFileSync(resolve(desktopDir, "..", "..", "package.json"), "utf8"));
writeFileSync(resolve(runtimeRoot, "package.json"), JSON.stringify({
  name: sourcePackage.name, version: sourcePackage.version, type: "module",
}, null, 2) + "\n");

console.log(`[franklin-desktop] prepared runtime at ${runtimeDist}`);
