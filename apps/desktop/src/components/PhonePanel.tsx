import { useEffect, useState } from "react";
import { Loader2, RotateCcw, RefreshCw, Plus, Trash2 } from "lucide-react";
import { usePhoneCall } from "../hooks/use-phone-call";

// Dashboard-style Phone panel: manage provisioned numbers (list / buy / renew /
// release). Locally the number-management RPCs aren't wired over the agent
// socket yet (see use-phone-call), so this renders inert — placing a call still
// works from chat via the agent's make_phone_call tool.
export function PhonePanel() {
  const {
    isConnected,
    numbers,
    numbersError,
    loadingNumbers,
    actionBusy,
    loadNumbers,
    buyNumber,
    releaseNumber,
    renewNumber,
  } = usePhoneCall();

  const [country, setCountry] = useState("US");
  const [areaCode, setAreaCode] = useState("");

  useEffect(() => {
    if (isConnected) loadNumbers();
  }, [isConnected, loadNumbers]);

  const fmtExpiry = (v?: string | number) => {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? "" : `expires ${d.toLocaleDateString()}`;
  };

  return (
    <div className="try-phone">
      <div className="try-phone-card">
        {!isConnected && <p className="try-phone-hint">The local CLI wallet manages phone numbers.</p>}

        <div className="try-phone-section-head">
          <h2 className="try-phone-title">Your numbers</h2>
          <button className="try-reset" onClick={loadNumbers} disabled={!isConnected || loadingNumbers}>
            <RefreshCw className={`h-3.5 w-3.5${loadingNumbers ? " try-spin" : ""}`} /> Refresh
          </button>
        </div>
        <p className="try-phone-sub">
          Dedicated numbers Franklin can call from. $5 / 30 days each. To place a call, just ask Franklin in chat.
        </p>

        <div className="try-phone-numbers">
          {numbers.length === 0 ? (
            <p className="try-phone-empty">{loadingNumbers ? "Loading…" : "No numbers yet."}</p>
          ) : (
            numbers.map((n) => (
              <div key={n.phone_number} className="try-phone-num">
                <span className="try-phone-num-val">{n.phone_number}</span>
                <span className="try-phone-num-exp">{fmtExpiry(n.expires_at)}</span>
                <button onClick={() => renewNumber(n.phone_number)} disabled={actionBusy}>
                  {actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Renew
                </button>
                <button
                  className="try-phone-release"
                  onClick={() => releaseNumber(n.phone_number)}
                  disabled={actionBusy}
                  aria-label="Release"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="try-phone-buy">
          <select
            className="try-phone-input"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={actionBusy || !isConnected}
          >
            <option value="US">United States (+1)</option>
            <option value="GB">United Kingdom (+44)</option>
            <option value="CA">Canada (+1)</option>
          </select>
          <input
            className="try-phone-input"
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value)}
            placeholder="Area code (optional)"
            disabled={actionBusy || !isConnected}
          />
          <button
            className="btn-primary"
            onClick={() => buyNumber(country, areaCode || undefined)}
            disabled={!isConnected || actionBusy}
          >
            {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Get a number · $5
          </button>
        </div>
        {numbersError && <div className="try-error">{numbersError}</div>}
      </div>
    </div>
  );
}
