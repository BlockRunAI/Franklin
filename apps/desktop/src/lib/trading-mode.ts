const KEY = "franklin-desktop-trading-mode-v1";

export type TradingModeControl = {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
};

export function loadTradingMode(): boolean {
  try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
}
export function saveTradingMode(enabled: boolean): void {
  try { localStorage.setItem(KEY, String(enabled)); } catch { /* optional local preference */ }
}
