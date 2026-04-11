import chalk from 'chalk';

// ─── Ben Franklin portrait ─────────────────────────────────────────────────
//
// Generated once, at build time, from the Joseph Duplessis 1785 oil painting
// of Benjamin Franklin (same source used for the engraving on the US $100
// bill). Public domain image from Wikimedia Commons:
//   https://commons.wikimedia.org/wiki/File:BenFranklinDuplessis.jpg
//
// Pipeline:
//   1. Crop the 2403×2971 original to a 1400×1400 square centred on the face
//      (sips --cropToHeightWidth 1400 1400 --cropOffset 400 500)
//   2. Convert with ascii-image-converter in braille mode:
//      ascii-image-converter ben-face.jpg --dimensions 34,16 --braille \
//        --threshold 110
//
// Braille characters (U+2800..U+28FF) encode 2×4 dot matrices per cell, so
// a 34×16 braille output gives 68×64 = 4,352 effective "pixels" — 2.7× the
// resolution of chafa half-block mode at the same visible size. For a face,
// which is all about silhouette + key features, this is a massive win.
//
// The output is pure Unicode — no ANSI escape codes, no color tinting baked
// in — which means it's trivial to wrap in chalk.hex() at render time for
// brand tinting, and it ships as a clean readable TS array.
const BEN_PORTRAIT_ROWS: readonly string[] = [
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣤⣴⣶⣶⣦⣤⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⠁⣀⠀⠉⣿⣿⣿⠋⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⢀⠀⢠⣿⣿⣿⣾⣤⣴⣴⣿⣿⣷⠀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⢠⡄⠀⠀⠁⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄⢾⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠸⡔⠂⠀⠀⠘⣿⣿⣿⣿⣿⣿⣿⣿⣛⣛⠛⠁⠈⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⣿⣿⣿⣿⣿⣿⢿⣿⠿⢷⠄⠀⠙⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⣿⣿⡿⣿⡿⣿⣏⠛⠛⠙⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⡴⠺⠖⢒⣂⢄⡀⣹⣿⣿⣿⣶⣙⠂⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⣶⣤⣄⡀⠈⠻⠿⡙⠗⠸⡻⣿⡻⣿⣿⣷⣦⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⣿⡟⠻⣿⣦⡀⠀⢁⡆⠀⠹⢿⣿⣮⣟⠿⣿⠏⠀⠀⣀⣴⣶⣦⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⣿⣷⣄⠈⠿⣷⡀⣾⣿⡀⢦⢸⣿⡹⣿⣿⡆⣤⡐⠻⡻⣿⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀',
];

// ─── FRANKLIN text banner (gold → emerald gradient) ────────────────────────
//
// Kept from v3.1.0. 6 block-letter rows, each tinted with an interpolated
// colour between GOLD_START and EMERALD_END for a smooth vertical gradient.
const FRANKLIN_ART: readonly string[] = [
  ' ███████╗██████╗  █████╗ ███╗   ██╗██╗  ██╗██╗     ██╗███╗   ██╗',
  ' ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║ ██╔╝██║     ██║████╗  ██║',
  ' █████╗  ██████╔╝███████║██╔██╗ ██║█████╔╝ ██║     ██║██╔██╗ ██║',
  ' ██╔══╝  ██╔══██╗██╔══██║██║╚██╗██║██╔═██╗ ██║     ██║██║╚██╗██║',
  ' ██║     ██║  ██║██║  ██║██║ ╚████║██║  ██╗███████╗██║██║ ╚████║',
  ' ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝',
];

const GOLD_START = '#FFD700';
const EMERALD_END = '#10B981';

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  return [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function interpolateHex(start: string, end: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(start);
  const [r2, g2, b2] = hexToRgb(end);
  return rgbToHex(
    r1 + (r2 - r1) * t,
    g1 + (g2 - g1) * t,
    b1 + (b2 - b1) * t
  );
}

// ─── Banner layout ─────────────────────────────────────────────────────────

// Minimum terminal width to show the side-by-side portrait + text layout.
// Portrait: 34 cols braille, FRANKLIN text: ~65 cols, gap: 3 cols,
// total: ~102 cols. Add a 3-col margin of safety → 105.
const MIN_WIDTH_FOR_PORTRAIT = 105;

/**
 * Pad a line to an exact visual width. Braille characters have no ANSI
 * escape codes and are all 1 cell wide, so this is a straightforward
 * codepoint count.
 */
function padBraillePortrait(s: string, targetWidth: number): string {
  const current = [...s].length;
  if (current >= targetWidth) return s;
  return s + ' '.repeat(targetWidth - current);
}

export function printBanner(version: string): void {
  const termWidth = process.stdout.columns ?? 80;
  const useSideBySide = termWidth >= MIN_WIDTH_FOR_PORTRAIT;

  if (useSideBySide) {
    printSideBySide(version);
  } else {
    printTextOnly(version);
  }
}

/**
 * Full layout: Ben Franklin braille portrait on the left, FRANKLIN gradient
 * text on the right. Portrait is 16 rows × 34 cols, text is 6 rows + 1-row
 * tagline. Text starts at portrait row 5 so the FRANKLIN block aligns with
 * Ben's face region (head at rows 1-4, face at rows 5-10, shoulders 11-16),
 * giving the classic "portrait and nameplate" composition.
 *
 *   row  1   ⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣤⣴⣶⣶⣦⣤⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 *   row  2   ⠀⠀⠀⠀⠀⠀⠀⠀⣰⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄⠀⠀⠀⠀⠀⠀⠀⠀
 *   row  3   ⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠀⠀⠀⠀⠀⠀⠀
 *   row  4   ⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀⠀⠀
 *   row  5   ⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⠁...         ███████╗██████╗  █████╗ ...
 *   row  6   ⠀⠀⠀⠀⠀⠀⠀⢠⣿⣿⣿⣾...         ██╔════╝██╔══██╗██╔══██╗...
 *   row  7   ⠀⠀⠀⢠⡄⠀⠀⠀⢀⣾⣿...            █████╗  ██████╔╝███████║...
 *   row  8   ⠀⠀⠀⠸⡔⠂⠀⠀⠘⣿⣿...            ██╔══╝  ██╔══██╗██╔══██║...
 *   row  9   ⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⣿...            ██║     ██║  ██║██║  ██║...
 *   row 10   ⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿...            ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝...
 *   row 11   ⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿...            blockrun.ai · The AI agent with a wallet · vX
 *   row 12   ⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⣿...
 *   row 13-16: neck, collar, body
 */
function printSideBySide(version: string): void {
  const TEXT_TOP_OFFSET = 4;  // text block starts at portrait row 5 (0-indexed row 4)
  const PORTRAIT_WIDTH = 35;  // 34 cols braille + 1 trailing space
  const GAP = '  ';

  const portraitRows = BEN_PORTRAIT_ROWS;
  const textRows = FRANKLIN_ART.length;
  const totalRows = Math.max(portraitRows.length, TEXT_TOP_OFFSET + textRows + 2);

  // Tint the braille portrait in dim white for a "pencil portrait" feel.
  // Braille chars carry no colour on their own — chalk wraps them in an
  // ANSI colour sequence at render time.
  const portraitTint = chalk.hex('#E8E8E8');

  for (let i = 0; i < totalRows; i++) {
    const rawPortraitLine = i < portraitRows.length
      ? padBraillePortrait(portraitRows[i], PORTRAIT_WIDTH)
      : ' '.repeat(PORTRAIT_WIDTH);
    const portraitLine = portraitTint(rawPortraitLine);

    // Text column content
    let textCol = '';
    const textIdx = i - TEXT_TOP_OFFSET;
    if (textIdx >= 0 && textIdx < textRows) {
      // FRANKLIN block letters with gradient colour
      const t = textRows === 1 ? 0 : textIdx / (textRows - 1);
      const color = interpolateHex(GOLD_START, EMERALD_END, t);
      textCol = chalk.hex(color)(FRANKLIN_ART[textIdx]);
    } else if (textIdx === textRows) {
      // Tagline row sits right under the FRANKLIN block.
      // The big block-letter FRANKLIN above already says the product name
      // — the tagline uses that line for the parent brand URL
      // (blockrun.ai — a real live domain; see v3.1.0 notes for why
      // franklin.run is explicitly NOT used here).
      textCol =
        chalk.bold.hex(GOLD_START)('  blockrun.ai') +
        chalk.dim('  ·  The AI agent with a wallet  ·  v' + version);
    }

    process.stdout.write(portraitLine + GAP + textCol + '\n');
  }
  process.stdout.write('\n');
}

/**
 * Compact layout for narrow terminals: just the FRANKLIN text block with
 * its gradient, no portrait.
 */
function printTextOnly(version: string): void {
  const textRows = FRANKLIN_ART.length;
  for (let i = 0; i < textRows; i++) {
    const t = textRows === 1 ? 0 : i / (textRows - 1);
    const color = interpolateHex(GOLD_START, EMERALD_END, t);
    console.log(chalk.hex(color)(FRANKLIN_ART[i]));
  }
  console.log(
    chalk.bold.hex(GOLD_START)('  blockrun.ai') +
      chalk.dim('  ·  The AI agent with a wallet  ·  v' + version) +
      '\n'
  );
}
