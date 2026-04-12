import chalk from 'chalk';

// ─── Ben Franklin portrait ─────────────────────────────────────────────────
//
// Generated once, at build time, from the Joseph Duplessis 1785 oil painting
// of Benjamin Franklin (same source as the portrait on the US $100 bill).
// Public domain image from Wikimedia Commons:
//   https://commons.wikimedia.org/wiki/File:BenFranklinDuplessis.jpg
//
// Pipeline:
//   1. Crop the 2403×2971 original to a 1400×1400 square centred on the face
//      (sips --cropToHeightWidth 1400 1400 --cropOffset 400 500)
//   2. Convert via chafa:
//      chafa --size=30x14 --symbols=block --colors=256 ben-face.jpg
//   3. Strip cursor visibility control codes (\x1b[?25l / \x1b[?25h)
//   4. Paste here as hex-escaped string array (readable + diff-friendly)
//
// Visible dimensions: ~28 characters wide × 14 rows tall.
//
// Rendered best in a 256-color or truecolor terminal. Degrades gracefully
// on ancient terminals — but those are long gone and we don't support them.
const BEN_PORTRAIT_ROWS: readonly string[] = [
  '\x1b[0m\x1b[38;5;16;48;5;16m      \x1b[38;5;232m▁\x1b[38;5;235;48;5;232m▂\x1b[38;5;58;48;5;233m▄\x1b[38;5;95;48;5;234m▆\x1b[38;5;137;48;5;58m▄\x1b[38;5;173m▅\x1b[48;5;94m▅\x1b[48;5;58m▆▅\x1b[48;5;237m▄\x1b[38;5;137;48;5;234m▃\x1b[38;5;235;48;5;233m▂   \x1b[38;5;233;48;5;232m▂▅\x1b[48;5;233m     \x1b[0m',
  '\x1b[38;5;16;48;5;16m     \x1b[38;5;235;48;5;232m▗\x1b[38;5;233;48;5;236m▘\x1b[38;5;8;48;5;239m▌\x1b[38;5;95;48;5;137m▋\x1b[38;5;137;48;5;179m▘  \x1b[38;5;179;48;5;173m▃\x1b[48;5;179m   \x1b[48;5;173m▊\x1b[38;5;58;48;5;137m▝\x1b[38;5;94;48;5;235m▖\x1b[38;5;234;48;5;233m▅▄▂  ▂▗▄▃\x1b[0m',
  '\x1b[38;5;16;48;5;16m    \x1b[38;5;235;48;5;232m▗\x1b[38;5;236;48;5;237m▍ \x1b[38;5;58;48;5;94m▋\x1b[38;5;95;48;5;173m▌\x1b[48;5;179m \x1b[38;5;179;48;5;215m▍\x1b[48;5;221m▔\x1b[38;5;222;48;5;180m▍\x1b[48;5;179m  \x1b[38;5;173m▕\x1b[38;5;179;48;5;173m▅\x1b[38;5;137m▕\x1b[38;5;95;48;5;58m▍\x1b[38;5;58;48;5;235m▖\x1b[38;5;235;48;5;234m▖▃▄     \x1b[0m',
  '\x1b[38;5;16;48;5;16m   \x1b[38;5;233m▗\x1b[48;5;235m▏\x1b[38;5;237;48;5;238m▊\x1b[38;5;238;48;5;236m▌\x1b[38;5;236;48;5;58m▖\x1b[38;5;95;48;5;179m▌ \x1b[38;5;137m▗\x1b[38;5;94m▄\x1b[38;5;58m▄\x1b[38;5;94m▄\x1b[38;5;137m▖\x1b[38;5;173m▗\x1b[38;5;131m▗\x1b[38;5;58;48;5;137m▃\x1b[38;5;131;48;5;58m▘\x1b[38;5;234m▕\x1b[48;5;236m▖\x1b[38;5;236;48;5;235m▃    \x1b[38;5;234m▝\x1b[38;5;235;48;5;234m▃\x1b[0m',
  '\x1b[38;5;16;48;5;16m  \x1b[38;5;235;48;5;232m▂\x1b[38;5;236;48;5;234m▄\x1b[38;5;237;48;5;236m▗\x1b[38;5;8;48;5;239m▖\x1b[38;5;240;48;5;8m▎\x1b[38;5;94;48;5;236m▕\x1b[38;5;137;48;5;179m▍ \x1b[38;5;94;48;5;137m▝\x1b[38;5;173;48;5;94m▂\x1b[38;5;137;48;5;58m▂\x1b[48;5;94m▃\x1b[48;5;179m▘\x1b[38;5;173m▝\x1b[38;5;137;48;5;235m▍\x1b[38;5;94;48;5;236m▝\x1b[38;5;235;48;5;94m▖\x1b[38;5;52;48;5;58m▖\x1b[38;5;235;48;5;233m▝\x1b[48;5;236m▁\x1b[48;5;235m      \x1b[0m',
  '\x1b[38;5;232;48;5;16m▗\x1b[38;5;233;48;5;236m▌\x1b[38;5;95;48;5;239m▅\x1b[48;5;240m▃\x1b[38;5;94;48;5;238m▖\x1b[38;5;240;48;5;8m▝\x1b[38;5;95;48;5;236m▘\x1b[38;5;236;48;5;95m▘\x1b[38;5;173;48;5;179m▏ \x1b[38;5;215m▄ \x1b[38;5;179;48;5;137m▅\x1b[38;5;137;48;5;179m▘\x1b[38;5;216m▘\x1b[38;5;179;48;5;216m▃\x1b[48;5;94m▌\x1b[38;5;94;48;5;131m▘\x1b[38;5;95;48;5;94m▋\x1b[38;5;94;48;5;52m▃\x1b[38;5;52;48;5;233m▎\x1b[38;5;233;48;5;235m▅\x1b[38;5;234m▂     \x1b[0m',
  '\x1b[38;5;233;48;5;232m▕\x1b[38;5;234;48;5;236m▘\x1b[38;5;8;48;5;95m▌ \x1b[38;5;236m▃\x1b[38;5;58;48;5;234m▘\x1b[38;5;94m▝\x1b[48;5;137m▎\x1b[38;5;179;48;5;173m▍\x1b[38;5;173;48;5;179m▌▆▖▃▞\x1b[38;5;94;48;5;173m▗\x1b[48;5;179m▄\x1b[38;5;179;48;5;58m▘\x1b[38;5;94;48;5;52m▝\x1b[38;5;130;48;5;131m▃\x1b[38;5;94;48;5;58m▍\x1b[38;5;52;48;5;232m▎\x1b[38;5;232;48;5;233m▌\x1b[38;5;233;48;5;234m▏\x1b[38;5;234;48;5;235m▎\x1b[38;5;236m▌▅▄ \x1b[0m',
  '\x1b[38;5;232;48;5;235m▋\x1b[38;5;58;48;5;236m▝\x1b[48;5;58m \x1b[38;5;239;48;5;94m▅\x1b[38;5;237;48;5;235m▂\x1b[38;5;235;48;5;233m▂\x1b[38;5;234;48;5;94m▄\x1b[38;5;94;48;5;137m▖\x1b[48;5;173m \x1b[38;5;173;48;5;179m▃  \x1b[38;5;137m▂▃▂\x1b[38;5;131;48;5;137m▃\x1b[38;5;58;48;5;131m▝\x1b[38;5;94;48;5;52m▅\x1b[48;5;94m \x1b[48;5;58m▍\x1b[38;5;235;48;5;232m▎\x1b[38;5;232;48;5;233m▋\x1b[38;5;233;48;5;234m▍\x1b[38;5;235;48;5;236m▏  \x1b[38;5;236;48;5;235m▎ \x1b[0m',
  '\x1b[38;5;234;48;5;235m▏\x1b[38;5;236;48;5;237m▋\x1b[38;5;237;48;5;8m▃\x1b[38;5;235;48;5;238m▗\x1b[38;5;237m▖\x1b[38;5;58;48;5;234m▌\x1b[38;5;234;48;5;233m▎\x1b[38;5;236;48;5;137m▎\x1b[38;5;137;48;5;173m▄ \x1b[38;5;173;48;5;179m▄▃ \x1b[38;5;179;48;5;215m▅\x1b[38;5;173;48;5;179m▄\x1b[38;5;179;48;5;137m▘\x1b[38;5;137;48;5;131m▌\x1b[48;5;94m \x1b[38;5;58m▗\x1b[38;5;233;48;5;58m▗\x1b[48;5;233m  \x1b[38;5;234;48;5;236m▘ \x1b[38;5;236;48;5;235m▃▞\x1b[38;5;235;48;5;236m▄\x1b[48;5;235m \x1b[0m',
  '\x1b[38;5;234;48;5;235m▏▆\x1b[38;5;235;48;5;237m▌\x1b[38;5;236m▝\x1b[38;5;237;48;5;234m▍\x1b[38;5;234;48;5;233m▖\x1b[38;5;240;48;5;234m▗\x1b[38;5;101;48;5;186m▌\x1b[38;5;137m▝\x1b[48;5;137m   \x1b[48;5;173m▆▄▃\x1b[38;5;131m▂\x1b[38;5;130;48;5;137m▂\x1b[38;5;58;48;5;94m▃\x1b[48;5;58m \x1b[38;5;234;48;5;233m▏\x1b[38;5;235;48;5;234m▅\x1b[48;5;236m▌   ▝ \x1b[48;5;235m \x1b[0m',
  '\x1b[38;5;234;48;5;233m▕\x1b[38;5;239;48;5;235m▂\x1b[38;5;95m▃\x1b[48;5;237m▄\x1b[48;5;236m▄\x1b[48;5;235m▄\x1b[38;5;236;48;5;240m▘\x1b[38;5;101;48;5;95m▕\x1b[48;5;186m▖\x1b[38;5;179;48;5;229m▝\x1b[38;5;223;48;5;137m▃\x1b[38;5;137;48;5;131m▁\x1b[38;5;95m▅\x1b[38;5;94m▂\x1b[48;5;94m \x1b[38;5;58m▗\x1b[38;5;94;48;5;58m▔\x1b[38;5;236m▁ \x1b[48;5;235m▆\x1b[38;5;235;48;5;236m▍\x1b[38;5;236;48;5;235m▆\x1b[48;5;236m    \x1b[38;5;235m▅\x1b[48;5;235m \x1b[0m',
  '\x1b[38;5;237;48;5;95m▔       \x1b[38;5;137;48;5;101m▝\x1b[48;5;187m▅\x1b[38;5;180;48;5;229m▂\x1b[38;5;143;48;5;222m▔\x1b[38;5;186;48;5;58m▅\x1b[38;5;179m▂\x1b[38;5;95m▁\x1b[38;5;235m▂\x1b[38;5;236m▄\x1b[48;5;233m▌\x1b[38;5;235m▔\x1b[38;5;233;48;5;236m▅\x1b[38;5;234m▃\x1b[38;5;235m▁    ▔\x1b[48;5;235m \x1b[0m',
  '\x1b[38;5;101;48;5;137m▔\x1b[38;5;95;48;5;101m▄▔\x1b[38;5;101;48;5;95m▄  ▗ \x1b[38;5;240m▖\x1b[38;5;95;48;5;101m▘\x1b[38;5;137m▔\x1b[48;5;222m▅\x1b[48;5;186m▃\x1b[48;5;179m▂\x1b[38;5;101;48;5;95m▌\x1b[48;5;58m \x1b[38;5;238;48;5;236m▁\x1b[38;5;180;48;5;234m▃\x1b[48;5;235m▄\x1b[38;5;179;48;5;234m▃\x1b[38;5;95m▁\x1b[38;5;234;48;5;235m▊\x1b[48;5;236m▆\x1b[38;5;235m▃\x1b[38;5;234m▂\x1b[38;5;235m▁ \x1b[38;5;236;48;5;235m▎\x1b[0m',
  '\x1b[38;5;137;48;5;137m \x1b[48;5;95m▄ \x1b[38;5;95;48;5;101m▖\x1b[48;5;137m▝\x1b[48;5;95m \x1b[38;5;101m▅\x1b[48;5;239m▋\x1b[48;5;95m \x1b[38;5;95;48;5;137m▋\x1b[38;5;101;48;5;95m▍\x1b[38;5;95;48;5;101m▖\x1b[38;5;101;48;5;95m▆\x1b[38;5;239m▗\x1b[38;5;101m▄ \x1b[38;5;95;48;5;137m▅\x1b[38;5;137;48;5;180m▅\x1b[38;5;180;48;5;186m▃\x1b[48;5;143m▆\x1b[38;5;95m▔\x1b[38;5;143;48;5;235m▖\x1b[48;5;234m \x1b[38;5;235m▆\x1b[38;5;234;48;5;235m▝\x1b[38;5;235;48;5;234m▞\x1b[38;5;234;48;5;235m▄ \x1b[0m',
];

// ─── FRANKLIN text banner (gold → emerald gradient) ────────────────────────
//
// Kept from v3.1.0. The text is laid out as 6 block-letter rows. Each row
// is tinted with a color interpolated between GOLD_START and EMERALD_END,
// giving the smooth vertical gradient that's been Franklin's banner since
// v3.1.0.
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
// The portrait is ~28 chars, the FRANKLIN text is ~65 chars, plus a 3-char
// gap = 96 chars. We add a small margin so 100 cols is the threshold.
const MIN_WIDTH_FOR_PORTRAIT = 100;

/**
 * Pad a line to an exact visual width, ignoring ANSI escape codes when
 * measuring. Used to align the portrait's right edge before the text block.
 */
function padVisible(s: string, targetWidth: number): string {
  // Strip ANSI color codes to measure visible length
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  // Unicode block characters are width 1 (they're half-blocks, not double-width)
  const current = [...visible].length;
  if (current >= targetWidth) return s;
  // Append a reset + padding so background colors don't bleed into the gap
  return s + '\x1b[0m' + ' '.repeat(targetWidth - current);
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
 * Full layout: Ben Franklin portrait on the left, FRANKLIN text block on the
 * right. Portrait is 14 rows × ~28 chars, text is 6 rows — text is vertically
 * centred inside the portrait with 4 rows of padding above and 4 below,
 * tagline sitting right under the FRANKLIN block.
 *
 *   [portrait row  1]                (empty)
 *   [portrait row  2]                (empty)
 *   [portrait row  3]                (empty)
 *   [portrait row  4]                (empty)
 *   [portrait row  5]   ███████╗██████╗  █████╗ ...
 *   [portrait row  6]   ██╔════╝██╔══██╗██╔══██╗...
 *   [portrait row  7]   █████╗  ██████╔╝███████║...
 *   [portrait row  8]   ██╔══╝  ██╔══██╗██╔══██║...
 *   [portrait row  9]   ██║     ██║  ██║██║  ██║...
 *   [portrait row 10]   ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝...
 *   [portrait row 11]   blockrun.ai · The AI agent with a wallet · vX
 *   [portrait row 12]                (empty)
 *   [portrait row 13]                (empty)
 *   [portrait row 14]                (empty)
 */
function printSideBySide(version: string): void {
  const TEXT_TOP_OFFSET = 4;  // rows of portrait above the text
  const PORTRAIT_WIDTH = 29;  // columns (char width) of the portrait + 1 pad
  const GAP = '  ';           // gap between portrait and text

  const portraitRows = BEN_PORTRAIT_ROWS;
  const textRows = FRANKLIN_ART.length;
  const totalRows = Math.max(portraitRows.length, TEXT_TOP_OFFSET + textRows + 2);

  for (let i = 0; i < totalRows; i++) {
    const portraitLine = i < portraitRows.length
      ? padVisible(portraitRows[i], PORTRAIT_WIDTH)
      : ' '.repeat(PORTRAIT_WIDTH);

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
      // The big block-letter "FRANKLIN" above already says the product
      // name — the tagline uses that real estate for the parent brand URL
      // (blockrun.ai, which is a real live domain — unlike franklin.run
      // which we own but haven't deployed yet, see v3.1.0 changelog).
      textCol =
        chalk.bold.hex(GOLD_START)('  blockrun.ai') +
        chalk.dim('  ·  The AI agent with a wallet  ·  v' + version);
    }

    // Write with a reset at the very start to prevent stray bg from the
    // previous line bleeding into the current row's portrait column.
    process.stdout.write('\x1b[0m' + portraitLine + GAP + textCol + '\x1b[0m\n');
  }
  // Trailing blank line for breathing room
  process.stdout.write('\n');
}

/**
 * Compact layout for narrow terminals: just the FRANKLIN text block with
 * its gradient, no portrait. Matches the v3.1.0 banner exactly.
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
