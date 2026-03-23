import chalk from 'chalk';
import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import { loadChain } from '../config.js';

export async function balanceCommand() {
  const chain = loadChain();

  try {
    if (chain === 'solana') {
      const client = await setupAgentSolanaWallet({ silent: true });
      const address = await client.getWalletAddress();
      const balance = await client.getBalance();

      console.log(`Chain:  ${chalk.magenta('solana')}`);
      console.log(`Wallet: ${chalk.cyan(address)}`);
      console.log(
        `USDC Balance: ${chalk.green(`$${balance.toFixed(2)}`)}`
      );

      if (balance === 0) {
        console.log(
          chalk.dim(`\nSend USDC on Solana to ${address} to get started.`)
        );
      }
    } else {
      const client = setupAgentWallet({ silent: true });
      const address = client.getWalletAddress();
      const balance = await client.getBalance();

      console.log(`Chain:  ${chalk.magenta('base')}`);
      console.log(`Wallet: ${chalk.cyan(address)}`);
      console.log(
        `USDC Balance: ${chalk.green(`$${balance.toFixed(2)}`)}`
      );

      if (balance === 0) {
        console.log(
          chalk.dim(`\nSend USDC on Base to ${address} to get started.`)
        );
      }
    }
  } catch {
    console.log(chalk.red('No wallet found. Run `brcc setup` first.'));
    process.exit(1);
  }
}
