// Local-desktop auth shim.
//
// franklin-run's useAuth wraps a *browser* wallet (wagmi/viem) + SIWE sign-in,
// because that's a hosted web app where the user brings their own wallet and
// signs every x402 payment. franklin-webui is the opposite: the local Franklin
// CLI already owns the wallet in ~/.blockrun/ and signs locally with no popup.
//
// So there is nothing to "connect". We expose the same shape run's components
// expect, but:
//   - `address` stays null → useChatHistory runs in local-storage mode (no
//     /api/try backend, which doesn't exist locally).
//   - `connect`/`signIn` are no-ops (the wallet is always present).
// Whether a wallet actually exists is surfaced separately via useWallet().

export interface LocalAuth {
  /** SIWE-signed-in address. Always null locally — the CLI owns the key, we
   *  never sign a session in the browser. Keeping it null keeps history local. */
  address: string | null;
  connect: () => Promise<void>;
  signIn: () => Promise<void>;
  signingIn: boolean;
  error: string | null;
}

export function useAuth(): LocalAuth {
  return {
    address: null,
    connect: async () => {},
    signIn: async () => {},
    signingIn: false,
    error: null,
  };
}
