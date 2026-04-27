/**
 * Public wallet surface for `@blockrun/franklin/wallet`.
 *
 * Thin pass-through over Franklin's wallet/manager helpers plus the
 * lower-level primitives from `@blockrun/llm` that downstream code
 * typically needs (setup, address, load/save, funding messages, types).
 *
 * Modelled after the flat wallet surface in `@blockrun/clawrouter` —
 * but exposed under a subpath because Franklin's `.` entry is a CLI
 * (side-effectful shebang) and can't double as a library.
 */

export {
  walletExists,
  setupWallet,
  setupSolanaWallet,
  getAddress,
} from './manager.js';

// ─── Re-exports from @blockrun/llm ────────────────────────────────────────
// So callers only need one import: `@blockrun/franklin/wallet`.

// Setup / create
export {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  setupAgentWallet,
  setupAgentSolanaWallet,
  createWallet,
  createSolanaWallet,
} from '@blockrun/llm';

// Query / load / save
export {
  getWalletAddress,
  scanWallets,
  scanSolanaWallets,
  loadWallet,
  loadSolanaWallet,
  saveWallet,
  saveSolanaWallet,
} from '@blockrun/llm';

// Funding / payment link helpers
export {
  formatWalletCreatedMessage,
  formatNeedsFundingMessage,
  formatFundingMessageCompact,
  getEip681Uri,
  getPaymentLinks,
} from '@blockrun/llm';

// File-system paths (useful for dotfiles / migration scripts)
export {
  WALLET_DIR_PATH,
  WALLET_FILE_PATH,
  SOLANA_WALLET_FILE_PATH,
} from '@blockrun/llm';

// Types
export type {
  WalletInfo,
  SolanaWalletInfo,
  PaymentLinks,
} from '@blockrun/llm';
