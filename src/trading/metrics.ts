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

export function sma(data: number[], period: number): number {
  if (data.length < period) return NaN;
  const slice = data.slice(data.length - period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

export function ema(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

export function rsi(closes: number[], period = 14): RSIResult {
  const values: number[] = new Array(closes.length).fill(NaN);

  if (closes.length < period + 1) {
    return { value: NaN, values, interpretation: 'neutral' };
  }

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;

  const computeRSI = (ag: number, al: number): number =>
    al === 0 ? 100 : 100 - 100 / (1 + ag / al);

  values[period] = computeRSI(avgGain, avgLoss);

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    values[i + 1] = computeRSI(avgGain, avgLoss);
  }

  const latest = values[values.length - 1];
  const interpretation: RSIResult['interpretation'] =
    latest < 30 ? 'oversold' : latest > 70 ? 'overbought' : 'neutral';

  return { value: latest, values, interpretation };
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MACDResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine: number[] = closes.map((_, i) =>
    isNaN(emaFast[i]) || isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i],
  );

  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signalLine = ema(validMacd, signal);

  const padded: number[] = new Array(macdLine.length - validMacd.length)
    .fill(NaN)
    .concat(signalLine);

  const histogram: number[] = macdLine.map((v, i) =>
    isNaN(v) || isNaN(padded[i]) ? NaN : v - padded[i],
  );

  const last = macdLine[macdLine.length - 1];
  const lastSignal = padded[padded.length - 1];
  const lastHist = histogram[histogram.length - 1];
  const prevHist = histogram[histogram.length - 2];

  let trend: MACDResult['trend'] = 'neutral';
  if (!isNaN(lastHist) && !isNaN(prevHist)) {
    if (lastHist > 0 && lastHist > prevHist) trend = 'bullish';
    else if (lastHist < 0 && lastHist < prevHist) trend = 'bearish';
  }

  return { macd: last, signal: lastSignal, histogram: lastHist, trend };
}

export function bollingerBands(
  closes: number[],
  period = 20,
  stdDev = 2,
): BollingerResult {
  if (closes.length < period) {
    return {
      upper: NaN,
      middle: NaN,
      lower: NaN,
      bandwidth: NaN,
      position: 'within',
    };
  }

  const slice = closes.slice(closes.length - period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;
  const variance =
    slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const sigma = Math.sqrt(variance);

  const upper = middle + stdDev * sigma;
  const lower = middle - stdDev * sigma;
  const bandwidth = (upper - lower) / middle;

  const price = closes[closes.length - 1];
  const position: BollingerResult['position'] =
    price > upper ? 'above' : price < lower ? 'below' : 'within';

  return { upper, middle, lower, bandwidth, position };
}

export function volatility(
  closes: number[],
  period = 14,
): VolatilityResult {
  if (closes.length < period + 1) {
    return { daily: NaN, annualized: NaN, interpretation: 'medium' };
  }

  const returns: number[] = [];
  const start = closes.length - period - 1;
  for (let i = start + 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance =
    returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
  const daily = Math.sqrt(variance);
  const annualized = daily * Math.sqrt(365);

  const interpretation: VolatilityResult['interpretation'] =
    annualized < 0.3 ? 'low' : annualized > 0.8 ? 'high' : 'medium';

  return { daily, annualized, interpretation };
}
