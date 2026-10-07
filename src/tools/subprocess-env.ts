// SDK credential env names must not reach model-driven commands or their output.
export const SENSITIVE_ENV_NAMES = [
  'BLOCKRUN_API_KEY',
  'BLOCKRUN_WALLET_KEY',
  'BASE_CHAIN_WALLET_KEY',
  'SOLANA_WALLET_KEY',
] as const;

export function sanitizeSubprocessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const name of SENSITIVE_ENV_NAMES) delete sanitized[name];
  // The same OS user can still read key files under ~/.blockrun. This closes
  // the environment path, not file access; in-process gateway calls keep theirs.
  return sanitized;
}
