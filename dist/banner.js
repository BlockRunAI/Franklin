import chalk from 'chalk';
const LOGO_ART = [
    '  ██████╗ ██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗',
    ' ██╔═████╗╚██╗██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝',
    ' ██║██╔██║ ╚███╔╝ ██║     ██║   ██║██║  ██║█████╗  ',
    ' ████╔╝██║ ██╔██╗ ██║     ██║   ██║██║  ██║██╔══╝  ',
    ' ╚██████╔╝██╔╝ ██╗╚██████╗╚██████╔╝██████╔╝███████╗',
    '  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
].join('\n');
export function printBanner(version) {
    console.log(chalk.hex('#00FF88')(LOGO_ART));
    console.log(chalk.bold.white('  0xcode') +
        chalk.dim('  ·  AI Coding Agent  ·  blockrun.ai  ·  v' + version));
    console.log(chalk.dim('  41+ models · Pay per use with USDC\n'));
}
