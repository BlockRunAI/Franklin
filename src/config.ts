import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = path.join(os.homedir(), '.brcc');
export const WALLET_PATH = path.join(CONFIG_DIR, 'wallet.json');
export const DEFAULT_API_URL = 'https://sol.blockrun.ai/api';
export const DEFAULT_PROXY_PORT = 8402;
export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
