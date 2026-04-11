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

export function printBanner(version: string) {
  // Gold → green gradient: money colors for "the agent with a wallet"
  const gold = chalk.hex('#FFD700');
  const green = chalk.hex('#10B981');

  for (let i = 0; i < FRANKLIN_ART.length; i++) {
    // Alternate lines between gold and green for subtle depth
    const color = i < 3 ? gold : green;
    console.log(color(FRANKLIN_ART[i]));
  }
  console.log(
    chalk.bold.hex('#FFD700')('  Franklin') +
      chalk.dim('  ·  The AI agent with a wallet  ·  v' + version)
  );
  console.log(
    chalk.dim('  Marketing: ') +
      chalk.cyan('franklin.run') +
      chalk.dim('   ·   Trading: ') +
      chalk.hex('#10B981')('franklin.bet') +
      chalk.dim('\n')
  );
}
