// Preflight: verify the Node.js runtime BEFORE any heavy dependency loads.
//
// Must be the very first import in index.ts and must stay dependency-free.
// ESM evaluates imported modules depth-first in source order, so importing this
// first lets it exit cleanly before the Solana stack is evaluated. Several
// transitive deps (rpc-websockets require()-ing ESM-only uuid, @noble/*) need
// the require(esm) capability that only exists on Node >= 20.19.0; on older Node
// they throw ERR_REQUIRE_ESM at load time, which would otherwise surface as an
// opaque stack trace pointing at node_modules instead of a clear instruction.

const MIN: [number, number, number] = [20, 19, 0];

const current = process.versions.node.split('.').map((part) => parseInt(part, 10));
const [curMajor = 0, curMinor = 0, curPatch = 0] = current;
const [minMajor, minMinor, minPatch] = MIN;

const tooOld =
  curMajor < minMajor ||
  (curMajor === minMajor &&
    (curMinor < minMinor || (curMinor === minMinor && curPatch < minPatch)));

if (tooOld) {
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.error(
    red(`\nFranklin requires Node.js ${MIN.join('.')} or newer — you have ${process.versions.node}.`),
  );
  console.error('\nUpgrade Node, then re-run franklin:');
  console.error(dim('  nvm install 22 && nvm use 22        # https://github.com/nvm-sh/nvm'));
  console.error(dim('  # or: fnm install 22 && fnm use 22  # https://github.com/Schniz/fnm'));
  console.error('');
  process.exit(1);
}
