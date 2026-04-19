import type { Bar } from '../api/client';

// Classic EMA with seeded SMA: the first `period-1` outputs are null,
// index `period-1` is the SMA of the first `period` closes, then
// EMA_t = close_t * k + EMA_{t-1} * (1-k), k = 2 / (period+1).
export function ema(bars: Bar[], period: number): Array<number | null> {
  if (period <= 0 || bars.length === 0) return bars.map(() => null);
  const k = 2 / (period + 1);
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (bars.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i]!.close;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = bars[i]!.close * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// % change between the value at the last bar and the value `lookback` bars ago.
// Returns null if either endpoint is missing.
export function pctChangeOverLookback(
  series: Array<number | null>,
  lookback: number,
): number | null {
  if (series.length <= lookback) return null;
  const last = series[series.length - 1];
  const past = series[series.length - 1 - lookback];
  if (last == null || past == null || past === 0) return null;
  return ((last - past) / past) * 100;
}
