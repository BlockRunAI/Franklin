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
// Franklin brand gradient: gold → emerald
// Gold (#FFD700) is the $100 bill / Benjamins color — marketing product energy
// Emerald (#10B981) is the trading / money-moving color
// The gradient between them tells the Franklin story in one glance
const GOLD_START = '#FFD700';
const EMERALD_END = '#10B981';
function hexToRgb(hex) {
    const m = hex.replace('#', '');
    return [
        parseInt(m.slice(0, 2), 16),
        parseInt(m.slice(2, 4), 16),
        parseInt(m.slice(4, 6), 16),
    ];
}
function rgbToHex(r, g, b) {
    const toHex = (n) => Math.round(n).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function interpolateHex(start, end, t) {
    const [r1, g1, b1] = hexToRgb(start);
    const [r2, g2, b2] = hexToRgb(end);
    return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
export function printBanner(version) {
    // Smooth 6-row gradient: each line gets its own interpolated color
    const steps = FRANKLIN_ART.length;
    for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const color = interpolateHex(GOLD_START, EMERALD_END, t);
        console.log(chalk.hex(color)(FRANKLIN_ART[i]));
    }
    console.log(chalk.bold.hex(GOLD_START)('  Franklin') +
        chalk.dim('  ·  The AI agent with a wallet  ·  v' + version) +
        '\n');
}
