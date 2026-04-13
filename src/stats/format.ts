/**
 * Shared formatting utilities for token counts, costs, and model names.
 */

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function shortModelName(model: string): string {
  const idx = model.indexOf('/');
  return idx > -1 ? model.slice(idx + 1) : model;
}
