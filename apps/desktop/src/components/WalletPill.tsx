// Wallet status pill at the bottom of the sidebar. Pure display — the CLI owns
// the wallet, so no connect/disconnect/sign here. Uses the exact same markup +
// classes as franklin-run's connected wallet (two rows: network + balance, then
// address) so it looks identical to the web; the right-hand button copies the
// address instead of disconnecting.

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import type { WalletInfo } from "../lib/wire";
import { copyText } from "../lib/clipboard";

interface Props {
  wallet: WalletInfo | null;
}

function fmtBal(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function WalletPill({ wallet }: Props) {
  const [copied, setCopied] = useState(false);

  if (!wallet) {
    return (
      <div className="try-wallet" style={{ opacity: 0.6 }}>
        <div className="try-wallet-info">
          <div className="try-wallet-row1">
            <span className="try-wallet-net">CLI offline</span>
          </div>
          <span className="try-wallet-addr">—</span>
        </div>
      </div>
    );
  }

  const net = wallet.chain === "base" ? "Base" : "Solana";
  const addr = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;

  const copy = async () => {
    if (await copyText(wallet.address)) {
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
      <button className="try-wallet-disconnect" onClick={copy} title={wallet.address} aria-label="Copy address">
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}
