import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import chalk from 'chalk';
import { walletExists, getPublicKey } from '../wallet/manager.js';
import { SOLANA_RPC_URL, USDC_MINT } from '../config.js';

export async function balanceCommand() {
  if (!(await walletExists())) {
    console.log(chalk.red('No wallet found. Run `brcc setup` first.'));
    process.exit(1);
  }

  const pubkeyStr = await getPublicKey();
  const pubkey = new PublicKey(pubkeyStr);
  const usdcMint = new PublicKey(USDC_MINT);

  console.log(`Wallet: ${chalk.cyan(pubkeyStr)}\n`);

  const connection = new Connection(SOLANA_RPC_URL);

  try {
    const ata = await getAssociatedTokenAddress(usdcMint, pubkey);
    const tokenAccount = await connection.getTokenAccountBalance(ata);
    const balance = tokenAccount.value.uiAmount ?? 0;
    console.log(`USDC Balance: ${chalk.green(`$${balance.toFixed(2)}`)}`);

    if (balance === 0) {
      console.log(
        chalk.dim(`\nSend USDC (Solana) to ${pubkeyStr} to get started.`)
      );
    }
  } catch {
    console.log(`USDC Balance: ${chalk.yellow('$0.00')}`);
    console.log(
      chalk.dim(`\nSend USDC (Solana) to ${pubkeyStr} to get started.`)
    );
  }

  try {
    const solBalance = await connection.getBalance(pubkey);
    const sol = solBalance / 1e9;
    console.log(`SOL Balance:  ${chalk.dim(`${sol.toFixed(4)} SOL`)}`);
    if (sol < 0.001) {
      console.log(
        chalk.dim(
          'Note: You need a small amount of SOL for transaction fees (~0.001 SOL).'
        )
      );
    }
  } catch {
    console.log(`SOL Balance:  ${chalk.dim('0.0000 SOL')}`);
  }
}
