export interface RSIResult {
    value: number;
    values: number[];
    interpretation: 'oversold' | 'neutral' | 'overbought';
}
export interface MACDResult {
    macd: number;
    signal: number;
    histogram: number;
    trend: 'bullish' | 'bearish' | 'neutral';
}
export interface BollingerResult {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number;
    position: 'above' | 'within' | 'below';
}
export interface VolatilityResult {
    daily: number;
    annualized: number;
    interpretation: 'low' | 'medium' | 'high';
}
export declare function sma(data: number[], period: number): number;
export declare function ema(closes: number[], period: number): number[];
export declare function rsi(closes: number[], period?: number): RSIResult;
export declare function macd(closes: number[], fast?: number, slow?: number, signal?: number): MACDResult;
export declare function bollingerBands(closes: number[], period?: number, stdDev?: number): BollingerResult;
export declare function volatility(closes: number[], period?: number): VolatilityResult;
