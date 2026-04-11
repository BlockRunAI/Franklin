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
// Franklin brand colors
// Gold is the brand anchor — $100 bill, "Benjamins", wealth, Benjamin Franklin himself
// Emerald is the secondary, reserved for franklin.bet (trading) product color
const GOLD = '#FFD700';
const EMERALD = '#10B981';
export function printBanner(version) {
    // Pure gold FRANKLIN — single brand color, maximum signature strength
    const goldFn = chalk.hex(GOLD);
    for (const line of FRANKLIN_ART) {
        console.log(goldFn(line));
    }
    console.log(chalk.bold.hex(GOLD)('  Franklin') +
        chalk.dim('  ·  The AI agent with a wallet  ·  v' + version));
    console.log(chalk.dim('  Marketing: ') +
        chalk.hex(GOLD)('franklin.run') +
        chalk.dim('   ·   Trading: ') +
        chalk.hex(EMERALD)('franklin.bet') +
        chalk.dim('\n'));
}
