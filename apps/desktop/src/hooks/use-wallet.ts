// Wallet info — strictly read-only on the web side. The CLI owns the private
// key in ~/.blockrun/, signs all x402 payments locally, and just publishes
// address + balance + chain through this hook.
//
// SINGLETON: a single shared wallet state + a single wallet.info fetch is shared
// by every consumer (the sidebar pill AND the wallet page). Previously each
// useWallet() instance fetched independently, so the pill and the page could
// show DIFFERENT balances (two fetches at slightly different times resolve to
// different gateway balances). One source of truth fixes that mismatch.

import { useEffect, useState } from "react";
import { agent, type AgentConnectionState } from "../lib/ws";
import type { ServerMsg, WalletInfo } from "../lib/wire";

let current: WalletInfo | null = null;
let loading = true;
let lastError: string | null = null;
let connectionState: AgentConnectionState = agent.state;
let switchingChain: "base" | "solana" | null = null;
let started = false;
const subs = new Set<() => void>();

function emit() {
  for (const fn of subs) fn();
}

async function refresh() {
  loading = true;
  emit();
  try {
    current = await agent.request<undefined, WalletInfo>("wallet.info");
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : "Failed to load wallet";
  } finally {
    loading = false;
    emit();
  }
}

// Wire socket listeners once, globally — not per hook instance.
function ensureStarted() {
  if (started) return;
  started = true;
  agent.onState((state) => {
    connectionState = state;
    emit();
    if (state === "open") void refresh();
  });
  // CLI broadcasts wallet.event after every turn (settlement may have changed
  // the balance); merge it into the shared state so all consumers update.
  agent.subscribe((msg: ServerMsg) => {
    if (msg.kind === "wallet.event") {
      current = { ...(current ?? { address: "", chain: "base" }), ...(msg.payload as Partial<WalletInfo>) } as WalletInfo;
      emit();
    }
  });
  // Periodic refresh so the balance self-heals when it changes WITHOUT a chat
  // turn — e.g. the user tops up, or the agent spends in the background. Without
  // this, balanceUsd only updates on (re)connect or after a turn (wallet.event),
  // so it could sit stale (and disagree with the live on-chain Holdings) until
  // the next turn. 30s is a light single RPC call.
  setInterval(() => { void refresh(); }, 30_000);
}

export function useWallet(): {
  wallet: WalletInfo | null;
  isLoading: boolean;
  error: string | null;
  connectionState: AgentConnectionState;
  switchingChain: "base" | "solana" | null;
  switchChain: (chain: "base" | "solana") => Promise<void>;
} {
  ensureStarted();
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subs.add(fn);
    return () => { subs.delete(fn); };
  }, []);
  const switchChain = async (chain: "base" | "solana") => {
    if (switchingChain || current?.chain === chain) return;
    const switchWallet = window.__FRANKLIN__?.switchWalletChain;
    if (!switchWallet) throw new Error("Wallet switching is available in Franklin Desktop");
    switchingChain = chain;
    lastError = null;
    emit();
    try {
      await switchWallet(chain);
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Failed to switch wallet network";
      throw err;
    } finally {
      switchingChain = null;
      emit();
    }
  };
  return { wallet: current, isLoading: loading, error: lastError, connectionState, switchingChain, switchChain };
}
