import chalk from 'chalk';

// "FRANKLIN" — the AI agent with a wallet
const FRANKLIN_ART = [
  ' ███████╗██████╗  █████╗ ███╗   ██╗██╗  ██╗██╗     ██╗███╗   ██╗',
  ' ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║ ██╔╝██║     ██║████╗  ██║',
  ' █████╗  ██████╔╝███████║██╔██╗ ██║█████╔╝ ██║     ██║██╔██╗ ██║',
  ' ██╔══╝  ██╔══██╗██╔══██║██║╚██╗██║██╔═██╗ ██║     ██║██║╚██╗██║',
  ' ██║     ██║  ██║██║  ██║██║ ╚████║██║  ██╗███████╗██║██║ ╚████║',
  ' ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝',
];

// Gradient anchors: gold → emerald green (money colors)
const GOLD = '#FFD700';
const EMERALD = '#10B981';

/** Linearly interpolate between two hex colors. t ∈ [0, 1]. */
function interpolateHex(start: string, end: string, t: number): string {
  const s = parseInt(start.slice(1), 16);
  const e = parseInt(end.slice(1), 16);
  const sr = (s >> 16) & 0xff;
  const sg = (s >> 8) & 0xff;
  const sb = s & 0xff;
  const er = (e >> 16) & 0xff;
  const eg = (e >> 8) & 0xff;
  const eb = e & 0xff;
  const r = Math.round(sr + (er - sr) * t);
  const g = Math.round(sg + (eg - sg) * t);
  const b = Math.round(sb + (eb - sb) * t);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function printBanner(version: string) {
  // Smooth gradient across all rows: row 0 = pure gold, last row = emerald
  const n = FRANKLIN_ART.length;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const hex = interpolateHex(GOLD, EMERALD, t);
    console.log(chalk.hex(hex)(FRANKLIN_ART[i]));
  }
  console.log(
    chalk.bold.hex(GOLD)('  Franklin') +
      chalk.dim('  ·  The AI agent with a wallet  ·  v' + version)
  );
  console.log(
    chalk.dim('  Marketing: ') +
      chalk.hex(GOLD)('franklin.run') +
      chalk.dim('   ·   Trading: ') +
      chalk.hex(EMERALD)('franklin.bet') +
      chalk.dim('\n')
  );
}
