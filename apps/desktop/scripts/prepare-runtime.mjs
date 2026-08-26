import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

console.log(`[franklin-desktop] prepared runtime at ${runtimeDist}`);
