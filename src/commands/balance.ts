import chalk from 'chalk';
import { setupAgentWallet } from '@blockrun/llm';

export async function balanceCommand() {
  try {
    const client = setupAgentWallet({ silent: true });
    const address = client.getWalletAddress();
    const balance = await client.getBalance();

    console.log(`Wallet: ${chalk.cyan(address)}`);
    console.log(`USDC Balance: ${chalk.green(`$${balance.toFixed(2)}`)}`);

    if (balance === 0) {
      console.log(
        chalk.dim(`\nSend USDC on Base to ${address} to get started.`)
      );
    }
  } catch {
    console.log(chalk.red('No wallet found. Run `brcc setup` first.'));
    process.exit(1);
  }
}
