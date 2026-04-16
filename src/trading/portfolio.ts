/**
 * Paper-trading Portfolio.
 *
 * Tracks cash, positions, and P&L as the agent executes trades. Pure in-memory
 * math — an Exchange (mock or real) produces Fill events; Portfolio applies
 * them. Persistence is handled separately in store.ts so tests don't touch disk.
 *
 * This is the execution substrate for Franklin's Trading Agent vertical —
 * the first place where "the AI agent with a wallet" actually makes autonomous
 * economic decisions and carries real P&L. No live-exchange integration here
 * yet; MockExchange (mock-exchange.ts) gives deterministic fills for testing,
 * and a real ExchangeClient adapter can be dropped in later against the same
 * Fill contract.
 */

export type Side = 'buy' | 'sell';

export interface Fill {
  symbol: string;
  side: Side;
  qty: number;
  priceUsd: number;
  feeUsd?: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avgPriceUsd: number;
}

export interface PortfolioOptions {
  startingCashUsd: number;
}

export interface MarketSnapshot {
  equityUsd: number;
  cashUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  positions: Array<Position & { markUsd: number; unrealizedPnlUsd: number }>;
}

export class Portfolio {
  cashUsd: number;
  realizedPnlUsd = 0;
  private positions = new Map<string, Position>();

  constructor(opts: PortfolioOptions) {
    this.cashUsd = opts.startingCashUsd;
  }

  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  listPositions(): Position[] {
    return [...this.positions.values()];
  }

  /** Serializable snapshot for persistence; paired with `restore()`. */
  snapshot(): { cashUsd: number; realizedPnlUsd: number; positions: Position[] } {
    return {
      cashUsd: this.cashUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      positions: this.listPositions().map((p) => ({ ...p })),
    };
  }

  /** Rehydrate state from a prior snapshot; overwrites all current fields. */
  restore(snap: { cashUsd: number; realizedPnlUsd: number; positions: Position[] }): void {
    this.cashUsd = snap.cashUsd;
    this.realizedPnlUsd = snap.realizedPnlUsd;
    this.positions.clear();
    for (const p of snap.positions) this.positions.set(p.symbol, { ...p });
  }

  applyFill(fill: Fill): void {
    const fee = fill.feeUsd ?? 0;
    const notional = fill.qty * fill.priceUsd;

    if (fill.side === 'buy') {
      const existing = this.positions.get(fill.symbol);
      if (!existing) {
        this.positions.set(fill.symbol, {
          symbol: fill.symbol,
          qty: fill.qty,
          avgPriceUsd: fill.priceUsd,
        });
      } else {
        // Weighted-average price update.
        const totalQty = existing.qty + fill.qty;
        const totalCost = existing.qty * existing.avgPriceUsd + notional;
        existing.qty = totalQty;
        existing.avgPriceUsd = totalCost / totalQty;
      }
      this.cashUsd -= notional + fee;
    } else {
      // sell: close or reduce existing position, realize P&L against avg price
      const existing = this.positions.get(fill.symbol);
      if (!existing) {
        throw new Error(`Cannot sell ${fill.symbol}: no open position`);
      }
      if (fill.qty > existing.qty + 1e-12) {
        throw new Error(
          `Cannot sell ${fill.qty} ${fill.symbol}: only ${existing.qty} held`,
        );
      }
      const realized = fill.qty * (fill.priceUsd - existing.avgPriceUsd) - fee;
      this.realizedPnlUsd += realized;
      existing.qty -= fill.qty;
      this.cashUsd += notional - fee;
      if (existing.qty <= 1e-12) {
        this.positions.delete(fill.symbol);
      }
    }
  }

  /**
   * Value the portfolio against a live price table. Callers supply the marks
   * (e.g. from TradingSignal or a live feed) so this stays pure and testable.
   * Symbols with no mark are valued at avgPriceUsd (zero unrealized P&L).
   */
  markToMarket(priceTable: Record<string, number>): MarketSnapshot {
    let unrealized = 0;
    let marketValue = 0;
    const positions = this.listPositions().map((p) => {
      const mark = priceTable[p.symbol] ?? p.avgPriceUsd;
      const pnl = p.qty * (mark - p.avgPriceUsd);
      unrealized += pnl;
      marketValue += p.qty * mark;
      return { ...p, markUsd: mark, unrealizedPnlUsd: pnl };
    });
    return {
      equityUsd: this.cashUsd + marketValue,
      cashUsd: this.cashUsd,
      unrealizedPnlUsd: unrealized,
      realizedPnlUsd: this.realizedPnlUsd,
      positions,
    };
  }
}
