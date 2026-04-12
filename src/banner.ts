import chalk from 'chalk';

// ─── Ben Franklin portrait ─────────────────────────────────────────────────
//
// Generated once, at build time, from the Joseph Duplessis 1785 oil painting
// of Benjamin Franklin (same source as the portrait on the US $100 bill).
// Public domain image from Wikimedia Commons:
//   https://commons.wikimedia.org/wiki/File:BenFranklinDuplessis.jpg
//
// Pipeline:
//   1. Crop the 800×989 thumb to a 500×500 square centred on the face
//      (sips --cropToHeightWidth 500 500 --cropOffset 140 150)
//   2. Convert via chafa:
//      chafa --size=16x8 --symbols=block --colors=full ben-face.jpg
//   3. Strip cursor visibility control codes (\x1b[?25l / \x1b[?25h)
//   4. Paste here as hex-escaped string array (readable + diff-friendly)
//
// Visible dimensions: ~16 characters wide × 8 rows tall.
//
// Rendered best in a 256-color or truecolor terminal. Degrades gracefully
// on ancient terminals — but those are long gone and we don't support them.
const BEN_PORTRAIT_ROWS: readonly string[] = [
  '\x1b[0m\x1b[38;2;7;0;0;48;2;8;0;0m▔ \x1b[38;2;9;1;0m▂\x1b[38;2;56;36;15;48;2;11;2;0m▗\x1b[38;2;100;73;36;48;2;31;16;6m▅\x1b[38;2;189;141;75;48;2;117;87;43m▅\x1b[38;2;217;162;85;48;2;152;111;51m▆\x1b[38;2;164;122;64;48;2;215;158;85m▔\x1b[38;2;124;90;46;48;2;217;160;93m▔\x1b[38;2;185;136;75;48;2;77;48;20m▅\x1b[38;2;100;61;24;48;2;39;18;4m▖\x1b[38;2;48;26;9;48;2;32;13;3m▃\x1b[38;2;39;18;4;48;2;30;11;2m▄\x1b[38;2;38;17;4;48;2;32;13;3m▄\x1b[38;2;40;20;5;48;2;35;15;2m▃\x1b[38;2;41;21;5;48;2;36;16;3m▂\x1b[0m',
  '\x1b[7m\x1b[38;2;8;0;0m \x1b[0m\x1b[38;2;0;0;0;48;2;8;0;0m \x1b[38;2;13;2;1;48;2;45;26;10m▊\x1b[38;2;61;40;17;48;2;87;63;31m▎\x1b[38;2;88;61;29;48;2;134;94;42m▋\x1b[38;2;182;132;66;48;2;223;172;93m▏\x1b[38;2;140;91;38;48;2;233;193;106m▂\x1b[38;2;135;82;35;48;2;229;178;106m▂\x1b[38;2;201;145;78;48;2;223;166;95m▂\x1b[38;2;133;88;46;48;2;198;148;86m▁\x1b[38;2;144;96;47;48;2;96;57;21m▍\x1b[38;2;66;42;15;48;2;58;33;11m▗\x1b[38;2;59;36;13;48;2;47;25;9m▆\x1b[38;2;57;35;11;48;2;46;24;7m▅\x1b[38;2;58;36;11;48;2;50;29;8m▖\x1b[38;2;53;32;8;48;2;48;26;7m▃\x1b[0m',
  '\x1b[38;2;12;3;3;48;2;9;0;0m▁\x1b[38;2;102;76;40;48;2;19;8;4m▗\x1b[38;2;110;83;45;48;2;56;35;15m▄\x1b[38;2;91;67;37;48;2;105;79;45m▌\x1b[38;2;96;64;31;48;2;186;135;70m▊\x1b[38;2;226;169;101;48;2;217;162;91m▗\x1b[38;2;216;159;89;48;2;144;93;44m▅\x1b[38;2;195;145;83;48;2;112;62;24m▅\x1b[38;2;233;178;110;48;2;206;151;81m▆\x1b[38;2;207;155;92;48;2;105;61;30m▎\x1b[38;2;145;94;46;48;2;94;50;19m▖\x1b[38;2;90;48;17;48;2;52;26;8m▎\x1b[38;2;59;33;9;48;2;64;40;14m▖\x1b[38;2;63;39;13;48;2;65;41;13m▊\x1b[38;2;58;36;11;48;2;64;40;14m▝\x1b[38;2;60;38;13;48;2;57;35;10m▍\x1b[0m',
  '\x1b[38;2;37;22;12;48;2;11;2;2m▕\x1b[38;2;52;32;16;48;2;94;67;32m▘\x1b[38;2;77;53;21;48;2;125;96;52m▗\x1b[38;2;44;15;6;48;2;83;48;21m▞\x1b[38;2;122;73;33;48;2;195;138;72m▍\x1b[38;2;209;149;77;48;2;223;160;89m▋\x1b[38;2;228;157;84;48;2;234;173;98m▆\x1b[38;2;207;140;80;48;2;225;167;96m▝\x1b[38;2;213;151;88;48;2;193;135;79m▏\x1b[38;2;164;111;60;48;2;104;54;21m▍\x1b[38;2;175;110;52;48;2;136;78;32m▘\x1b[38;2;93;47;15;48;2;26;5;2m▎\x1b[38;2;39;13;4;48;2;54;28;8m▍\x1b[38;2;63;40;13;48;2;67;44;16m▔\x1b[38;2;68;44;15;48;2;65;41;16m▊\x1b[38;2;60;36;11;48;2;63;39;14m▝\x1b[0m',
  '\x1b[38;2;12;1;0;48;2;55;33;13m▌\x1b[38;2;92;63;32;48;2;68;43;17m▝\x1b[38;2;75;51;24;48;2;93;65;34m▗\x1b[38;2;88;61;30;48;2;42;18;8m▘\x1b[38;2;62;35;18;48;2;191;150;83m▍\x1b[38;2;186;140;75;48;2;194;138;63m▁\x1b[38;2;189;130;61;48;2;219;157;79m▄\x1b[38;2;191;132;70;48;2;217;159;87m▂\x1b[38;2;179;105;60;48;2;207;146;83m▔\x1b[38;2;171;106;51;48;2;135;79;32m▋\x1b[38;2;64;30;8;48;2;120;69;27m▗\x1b[38;2;56;26;8;48;2;39;13;5m▂\x1b[38;2;44;18;7;48;2;72;44;16m▘\x1b[38;2;72;47;18;48;2;69;44;14m▖\x1b[38;2;70;46;14;48;2;68;44;14m▁\x1b[38;2;65;41;12;48;2;65;41;14m▘\x1b[0m',
  '\x1b[38;2;77;56;35;48;2;22;8;3m▂\x1b[38;2;126;100;69;48;2;59;36;15m▃\x1b[38;2;131;105;70;48;2;80;54;27m▄\x1b[38;2;128;103;68;48;2;57;33;14m▄\x1b[38;2;191;174;117;48;2;125;103;69m▝\x1b[38;2;191;164;108;48;2;236;227;160m▞\x1b[38;2;220;202;137;48;2;173;123;63m▃\x1b[38;2;130;85;43;48;2;164;111;58m▄\x1b[38;2;117;68;26;48;2;185;116;58m▆\x1b[38;2;135;80;33;48;2;94;52;15m▘\x1b[38;2;51;28;9;48;2;80;50;16m▂\x1b[38;2;62;33;9;48;2;76;46;14m▘\x1b[38;2;75;50;16;48;2;74;47;15m▗\x1b[38;2;71;46;14;48;2;72;47;15m▝\x1b[38;2;73;48;16;48;2;69;44;14m▏\x1b[38;2;65;41;11;48;2;66;41;15m▆\x1b[0m',
  '\x1b[38;2;125;101;70;48;2;159;129;87m▔\x1b[38;2;145;114;71;48;2;124;100;70m▆\x1b[38;2;152;123;81;48;2;121;100;69m▃\x1b[38;2;117;95;60;48;2;129;106;70m▖\x1b[38;2;115;91;61;48;2;131;105;69m▗\x1b[38;2;166;145;103;48;2;140;113;71m▔\x1b[38;2;162;135;87;48;2;231;217;147m▅\x1b[38;2;133;107;71;48;2;199;171;110m▂\x1b[38;2;131;100;59;48;2;107;75;37m▍\x1b[38;2;166;139;88;48;2;67;40;14m▃\x1b[38;2;204;179;121;48;2;39;19;8m▄\x1b[38;2;137;112;73;48;2;52;28;10m▖\x1b[38;2;54;32;10;48;2;76;49;16m▅\x1b[38;2;56;33;9;48;2;74;48;15m▃\x1b[38;2;60;37;10;48;2;70;47;14m▁\x1b[38;2;66;43;12;48;2;64;40;11m▅\x1b[0m',
  '\x1b[38;2;157;128;85;48;2;167;138;98m▝\x1b[38;2;141;111;71;48;2;166;136;98m▝\x1b[38;2;149;119;83;48;2;126;96;60m▞\x1b[38;2;157;129;93;48;2;139;113;81m▅\x1b[38;2;144;117;79;48;2;117;92;58m▋\x1b[38;2;130;102;62;48;2;169;138;87m▋\x1b[38;2;171;141;87;48;2;143;117;77m▖\x1b[38;2;144;117;79;48;2;122;96;63m▊\x1b[38;2;132;105;68;48;2;144;117;82m▖\x1b[38;2;153;127;92;48;2;140;115;83m▞\x1b[38;2;134;108;71;48;2;217;193;135m▅\x1b[38;2;176;150;98;48;2;129;105;66m▋\x1b[38;2;118;94;61;48;2;54;32;14m▂\x1b[38;2;44;23;8;48;2;59;37;13m▃\x1b[38;2;62;41;16;48;2;48;26;9m▖\x1b[38;2;46;24;6;48;2;66;42;15m▖\x1b[0m',
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
// The portrait is ~16 chars, the FRANKLIN text is ~65 chars, plus a 3-char
// gap = 84 chars. We round up to 85 cols as the threshold.
const MIN_WIDTH_FOR_PORTRAIT = 85;

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
 * right. Portrait is 8 rows × ~16 chars, text is 6 rows — text is vertically
 * centred inside the portrait with 1 row of padding above.
 *
 *   [portrait row 1]                (empty)
 *   [portrait row 2]   ███████╗██████╗  █████╗ ...
 *   [portrait row 3]   ██╔════╝██╔══██╗██╔══██╗...
 *   [portrait row 4]   █████╗  ██████╔╝███████║...
 *   [portrait row 5]   ██╔══╝  ██╔══██╗██╔══██║...
 *   [portrait row 6]   ██║     ██║  ██║██║  ██║...
 *   [portrait row 7]   ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝...
 *   [portrait row 8]   blockrun.ai · The AI agent with a wallet · vX
 */
function printSideBySide(version: string): void {
  const TEXT_TOP_OFFSET = 1;  // rows of portrait above the text
  const PORTRAIT_WIDTH = 17;  // columns (char width) of the portrait + 1 pad
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
