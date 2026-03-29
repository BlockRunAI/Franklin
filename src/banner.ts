import chalk from 'chalk';

const BRCC_ART = `
 ██████╗ ██████╗  ██████╗  ██████╗
 ██╔══██╗██╔══██╗██╔════╝ ██╔════╝
 ██████╔╝██████╔╝██║      ██║
 ██╔══██╗██╔══██╗██║      ██║
 ██████╔╝██║  ██║╚██████╗ ╚██████╗
 ╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚═════╝`;

export function printBanner(version: string) {
  console.log(chalk.hex('#FFD700')(BRCC_ART));
  console.log(
    chalk.bold.white('  BlockRun Claude Code') +
      chalk.dim('  ·  blockrun.ai  ·  v' + version)
  );
  console.log(
    chalk.dim('  Any model · No limits · Pay per use with USDC\n')
  );
}
