// Wallet status pill at the bottom of the sidebar. Pure display — the CLI owns
// the wallet, so no connect/disconnect/sign here. Uses the exact same markup +
// classes as franklin-run's connected wallet (two rows: network + balance, then
// address) so it looks identical to the web; the right-hand button copies the
// address instead of disconnecting.

import { useState } from "react";
import { Copy, Check, RefreshCw } from "lucide-react";
import type { WalletInfo } from "../lib/wire";
import type { AgentConnectionState } from "../lib/ws";
import { copyText } from "../lib/clipboard";

interface Props {
  wallet: WalletInfo | null;
  connectionState: AgentConnectionState;
  isLoading: boolean;
  error: string | null;
  switchingChain?: "base" | "solana" | null;
  onSwitchChain?: (chain: "base" | "solana") => void | Promise<void>;
}

function fmtBal(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function WalletPill({ wallet, connectionState, isLoading, error, switchingChain, onSwitchChain }: Props) {
  const [copied, setCopied] = useState(false);

  if (connectionState !== "open" || !wallet) {
    const status = connectionState === "connecting"
      ? "Connecting…"
      : connectionState === "closed"
        ? "Reconnecting…"
        : isLoading
          ? "Loading wallet…"
          : error
            ? "Wallet unavailable"
            : "Wallet unavailable";
    return (
      <div className="try-wallet" style={{ opacity: 0.72 }}>
        <div className="try-wallet-info">
          <div className="try-wallet-row1">
            <span className="try-wallet-net">{status}</span>
          </div>
          <span className="try-wallet-addr">—</span>
        </div>
      </div>
    );
  }

  if (wallet.authMode === "api-key") return (
    <div className="try-wallet"><div className="try-wallet-info">
      <span className="try-wallet-net">Account API key</span>
      <a className="try-wallet-addr" href="https://user.blockrun.ai/dashboard/credits" target="_blank" rel="noopener noreferrer">Manage credits and usage</a>
    </div></div>
  );

  const net = wallet.chain === "base" ? "Base" : "Solana";
  // RPC values are runtime data, even when the TypeScript contract says
  // `string`. Keep a malformed wallet response from taking down the whole UI.
  const safeAddress = typeof wallet.address === "string" ? wallet.address : "";
  const addr = safeAddress
    ? `${safeAddress.slice(0, 6)}…${safeAddress.slice(-4)}`
    : "Unavailable";

  const copy = async () => {
    if (safeAddress && await copyText(safeAddress)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="try-wallet">
      <div className="try-wallet-info">
        <div className="try-wallet-row1">
          <button className="try-wallet-net try-wallet-chain" disabled={!!switchingChain} onClick={() => void onSwitchChain?.(wallet.chain === "base" ? "solana" : "base")} title={`Switch to ${wallet.chain === "base" ? "Solana" : "Base"}`}>
            {switchingChain ? <RefreshCw className="spin" /> : null}{switchingChain ? (switchingChain === "base" ? "Base" : "Solana") : net}
          </button>
          {wallet.balanceUsd !== undefined && <span className="try-wallet-bal">{fmtBal(wallet.balanceUsd)}</span>}
        </div>
        <span className="try-wallet-addr">{addr}</span>
      </div>
      <button
        className="try-wallet-disconnect"
        onClick={copy}
        title={safeAddress || "Wallet address unavailable"}
        aria-label="Copy address"
        disabled={!safeAddress}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}
