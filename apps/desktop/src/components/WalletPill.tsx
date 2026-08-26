// Wallet status pill at the bottom of the sidebar. Pure display — the CLI owns
// the wallet, so no connect/disconnect/sign here. Uses the exact same markup +
// classes as franklin-run's connected wallet (two rows: network + balance, then
// address) so it looks identical to the web; the right-hand button copies the
// address instead of disconnecting.

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import type { WalletInfo } from "../lib/wire";
import type { AgentConnectionState } from "../lib/ws";
import { copyText } from "../lib/clipboard";

interface Props {
  wallet: WalletInfo | null;
  connectionState: AgentConnectionState;
  isLoading: boolean;
  error: string | null;
}

function fmtBal(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function WalletPill({ wallet, connectionState, isLoading, error }: Props) {
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

  const net = wallet.chain === "base" ? "Base" : "Solana";
  // RPC values are runtime data, even when the TypeScript contract says
  // `string`. Keep a malformed wallet response from taking down the whole UI.
  const fullAddress = typeof wallet.address === "string" ? wallet.address : "";
  const addr = fullAddress
    ? `${fullAddress.slice(0, 6)}…${fullAddress.slice(-4)}`
    : "Unavailable";

  const copy = async () => {
    if (fullAddress && await copyText(fullAddress)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="try-wallet">
      <div className="try-wallet-info">
        <div className="try-wallet-row1">
          <span className="try-wallet-net">{net}</span>
          {wallet.balanceUsd !== undefined && <span className="try-wallet-bal">{fmtBal(wallet.balanceUsd)}</span>}
        </div>
        <span className="try-wallet-addr">{addr}</span>
      </div>
      <button
        className="try-wallet-disconnect"
        onClick={copy}
        title={fullAddress || "Wallet address unavailable"}
        aria-label="Copy address"
        disabled={!fullAddress}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}
