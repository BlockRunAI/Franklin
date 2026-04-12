export interface PriceData {
    price: number;
    change24h: number;
    volume24h: number;
    marketCap: number;
}
export interface OHLCVData {
    closes: number[];
    timestamps: number[];
}
export interface TrendingCoin {
    id: string;
    name: string;
    symbol: string;
    marketCapRank: number | null;
}
export interface MarketCoin {
    id: string;
    symbol: string;
    name: string;
    price: number;
    change24h: number;
    marketCap: number;
    volume24h: number;
}
export declare function resolveId(ticker: string): string;
export declare function getPrice(ticker: string): Promise<PriceData | string>;
export declare function getOHLCV(ticker: string, days?: number): Promise<OHLCVData | string>;
export declare function getTrending(): Promise<TrendingCoin[] | string>;
export declare function getMarketOverview(): Promise<MarketCoin[] | string>;
