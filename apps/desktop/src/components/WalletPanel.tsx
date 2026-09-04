import { Wallet, ArrowDownToLine, Coins, ArrowLeftRight, ExternalLink, Check, RefreshCw } from "lucide-react";
import type { Usage } from "../hooks/use-usage-stats";
import { useUsdcBalance } from "../hooks/use-usdc-balance";
import { useWalletTokens } from "../hooks/use-wallet-tokens";
import { useWalletSwaps } from "../hooks/use-wallet-swaps";
import { useTryLang } from "../lib/i18n";
import { useWallet } from "../hooks/use-wallet";
import { safeExternalHttpUrl } from "../lib/external-url";

const HOLDINGS_LABEL: Record<string, string> = { en: "Holdings", zh: "持仓", es: "Tenencias" };
const SWAPS_LABEL: Record<string, string> = { en: "Swaps", zh: "换币记录", es: "Intercambios" };

function fmtAmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
}
function shortModel(id: string): string {
  return id.includes("/") ? id.split("/")[1] : id;
}

// Wallet & receipts (Franklin's differentiator): USDC balance + everything
// spent, per model/tool, with a per-request receipt log. Locally the balance
// comes from the CLI wallet (useUsdcBalance → useWallet), and receipts come
// from the CLI's authoritative settlement ledger through useSpend.
export function WalletPanel({ usage }: { usage: Usage }) {
  const { wallet } = useWallet();
  if (wallet?.authMode === "api-key") return <div className="try-wallet-panel"><div className="try-wallet-inner">
    <h2 className="try-tools-h">BlockRun account</h2>
    <p>Models, media, search and data use your API key. Local cost totals are estimates.</p>
    <a href="https://user.blockrun.ai/dashboard/credits" target="_blank" rel="noopener noreferrer">Manage credits and account usage</a>
    <p>On-chain transactions require a separate transaction wallet.</p>
  </div></div>;
  if (!wallet) return <p>Loading account status…</p>;
  return <WalletTransactionPanel usage={usage} />;
}

function WalletTransactionPanel({ usage }: { usage: Usage }) {
  const { t, lang } = useTryLang();
  const { balance } = useUsdcBalance();
  const { wallet, switchingChain, switchChain, error: walletError } = useWallet();
  const { tokens } = useWalletTokens();
  const swaps = useWalletSwaps();
  const byModel = Object.entries(usage.byModel).sort((a, b) => b[1].usd - a[1].usd);
  const maxUsd = byModel[0]?.[1].usd || 1;

  return (
    <div className="try-wallet-panel">
      <div className="try-wallet-inner">
        <h2 className="try-tools-h">{t.walletTitle}</h2>

        <section className="try-wallet-network-card">
          <div><strong>Payment network</strong><small>Franklin keeps a separate local wallet for each network. Switching restarts the local agent, never exports a key.</small></div>
          <div className="try-wallet-network-options" role="group" aria-label="Payment network">
            {(["solana", "base"] as const).map((chain) => <button key={chain} className={wallet?.chain === chain ? "is-active" : ""} disabled={!!switchingChain || !wallet} onClick={() => void switchChain(chain)}>{switchingChain === chain ? <RefreshCw className="spin" /> : wallet?.chain === chain ? <Check /> : null}{chain === "base" ? "Base" : "Solana"}</button>)}
          </div>
        </section>
        {walletError && <div className="cloud-error">{walletError}</div>}

        <div className="try-wallet-stats">
          <div className="try-wallet-stat">
            <div className="try-wallet-stat-label">{t.balance}</div>
            <div className="try-wallet-stat-val gold">
              {balance !== undefined ? fmtUsd(balance) : "—"}
            </div>
          </div>
          <div className="try-wallet-stat">
            <div className="try-wallet-stat-label">{t.spent}</div>
            <div className="try-wallet-stat-val">{fmtUsd(usage.totalUsd)}</div>
            <div className="try-wallet-stat-sub">{t.requests(usage.requests)}</div>
          </div>
        </div>

        <p className="try-wallet-topup">
          <ArrowDownToLine className="h-3.5 w-3.5" />
          {t.topUp}
        </p>

        {tokens.length > 0 && (
          <div className="try-wallet-section">
            <div className="try-wallet-holdings-head">
              <span className="try-tools-group-label">{HOLDINGS_LABEL[lang] ?? HOLDINGS_LABEL.en}</span>
              <span className="try-wallet-holdings-total">{fmtUsd(tokens.reduce((s, tk) => s + (tk.usd ?? 0), 0))}</span>
            </div>
            <div className="try-wallet-tokens">
              {tokens.map((tk) => (
                <div key={tk.symbol} className="try-wallet-token">
                  <span className="try-wallet-token-sym"><Coins className="h-3.5 w-3.5" />{tk.symbol}</span>
                  <span className="try-wallet-token-amt">{fmtAmount(tk.amount)}</span>
                  <span className="try-wallet-token-usd">{tk.usd != null ? fmtUsd(tk.usd) : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {swaps.length > 0 && (
          <div className="try-wallet-section">
            <div className="try-tools-group-label">{SWAPS_LABEL[lang] ?? SWAPS_LABEL.en}</div>
            <div className="try-wallet-swaps">
              {swaps.map((s, i) => (
                <div key={i} className="try-wallet-swap">
                  <ArrowLeftRight className="try-wallet-swap-icon h-3.5 w-3.5" />
                  <span className="try-wallet-swap-pair">
                    {fmtAmt(s.sellAmount)} {s.sellSym} → {fmtAmt(s.buyAmount)} {s.buySym}
                  </span>
                  <span className="try-wallet-swap-time">{new Date(s.ts).toLocaleDateString()}</span>
                  {safeExternalHttpUrl(s.explorer) && (
                    <a className="try-wallet-swap-link" href={safeExternalHttpUrl(s.explorer)!} target="_blank" rel="noopener noreferrer" title={s.txHash}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {byModel.length > 0 && (
          <div className="try-wallet-section">
            <div className="try-tools-group-label">{t.costByModel}</div>
            {byModel.map(([model, m]) => (
              <div key={model} className="try-wallet-bar-row">
                <span className="try-wallet-bar-name">{shortModel(model)}</span>
                <span className="try-wallet-bar-track">
                  <span className="try-wallet-bar-fill" style={{ width: `${Math.max(4, (m.usd / maxUsd) * 100)}%` }} />
                </span>
                <span className="try-wallet-bar-val">{fmtUsd(m.usd)}</span>
              </div>
            ))}
          </div>
        )}

        {usage.receipts.length > 0 && (
          <div className="try-wallet-section">
            <div className="try-tools-group-label">{t.receipts}</div>
            <div className="try-wallet-receipts">
              {usage.receipts.map((r, i) => (
                <div key={i} className="try-wallet-receipt">
                  <span className="try-wallet-receipt-model">{shortModel(r.model)}</span>
                  <span className="try-wallet-receipt-time">{new Date(r.ts).toLocaleString()}</span>
                  <span className="try-wallet-receipt-usd">{fmtUsd(r.usd)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {usage.requests === 0 && balance === undefined && (
          <p className="try-wallet-empty">
            <Wallet className="h-4 w-4" /> {t.walletEmpty}
          </p>
        )}
      </div>
    </div>
  );
}
