import { useEffect, useMemo, useState } from 'react';
import { Chart, type PriceLines } from './components/Chart';
import { TradePanel } from './components/TradePanel';
import { fetchBars, fetchQuote, type Bar } from './api/client';
import { ema, pctChangeOverLookback } from './lib/ema';
import { aggregate, type Timeframe } from './lib/aggregate';

const EMA_LOOKBACK = 20;

const TICKER_STORAGE_KEY = 'trading-fork:ticker';

function loadStoredTicker(): string {
  try {
    const v = localStorage.getItem(TICKER_STORAGE_KEY);
    if (v && /^[A-Z.\-]{1,10}$/.test(v)) return v;
  } catch {
    // localStorage may be unavailable (privacy mode, etc.)
  }
  return 'QQQ';
}

export function App() {
  const initialTicker = loadStoredTicker();
  const [tickerInput, setTickerInput] = useState(initialTicker);
  const [ticker, setTicker] = useState(initialTicker);
  const [bars, setBars] = useState<Bar[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>('daily');
  const [lines, setLines] = useState<PriceLines>({ entry: 0, stop: 0, target: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchBars(ticker, timeframe)
      .then((data) => {
        if (cancelled) return;
        setBars(data);
        const last = data[data.length - 1];
        if (last) {
          const px = last.close;
          setLines({
            entry: Number(px.toFixed(2)),
            stop: Number((px * 0.97).toFixed(2)),
            target: Number((px * 1.05).toFixed(2)),
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, timeframe]);

  const load = () => {
    const next = tickerInput.trim().toUpperCase();
    if (next) {
      setTicker(next);
      try {
        localStorage.setItem(TICKER_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
  };

  // Live price polling: every 1s, fetch the latest trade and update the most
  // recent bar's close (extending high/low if the live price breaks them).
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const q = await fetchQuote(ticker);
        if (cancelled) return;
        setBars((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1]!;
          if (last.close === q.price && last.high >= q.price && last.low <= q.price) {
            return prev;
          }
          const updated: Bar = {
            ...last,
            close: q.price,
            high: Math.max(last.high, q.price),
            low: Math.min(last.low, q.price),
          };
          return [...prev.slice(0, -1), updated];
        });
      } catch {
        // ignore transient errors; next tick will retry
      }
      if (!cancelled) timer = window.setTimeout(tick, 1000);
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ticker]);

  const displayBars = useMemo(() => aggregate(bars, timeframe), [bars, timeframe]);

  const emaStats = useMemo(() => {
    const ema10 = ema(displayBars, 10);
    const ema20 = ema(displayBars, 20);
    return {
      ema10: pctChangeOverLookback(ema10, EMA_LOOKBACK),
      ema20: pctChangeOverLookback(ema20, EMA_LOOKBACK),
    };
  }, [displayBars]);

  const fmtPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  const pctClass = (v: number | null) =>
    v == null ? 'ema-pct' : v >= 0 ? 'ema-pct ema-pct-up' : 'ema-pct ema-pct-down';

  return (
    <div className="app">
      <div className="ema-bar" title={`% change of the EMA over the last ${EMA_LOOKBACK} bars`}>
        <span className="ema-label">EMA10 {EMA_LOOKBACK}b</span>
        <span className={pctClass(emaStats.ema10)}>{fmtPct(emaStats.ema10)}</span>
        <span className="ema-label">EMA20 {EMA_LOOKBACK}b</span>
        <span className={pctClass(emaStats.ema20)}>{fmtPct(emaStats.ema20)}</span>
      </div>
      <div className="chart-wrap">
        <Chart bars={displayBars} lines={lines} onLinesChange={setLines} />
      </div>
      <div className="topbar">
        <input
          value={tickerInput}
          onChange={(e) => setTickerInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={load}
          placeholder="TICKER"
          autoCapitalize="characters"
          autoCorrect="off"
        />
        <button onClick={load} disabled={loading}>
          {loading ? '…' : 'Load'}
        </button>
        <div className="tf-toggle" role="group" aria-label="Timeframe">
          <button
            className={timeframe === 'daily' ? 'tf-btn active' : 'tf-btn'}
            onClick={() => setTimeframe('daily')}
          >
            D
          </button>
          <button
            className={timeframe === 'weekly' ? 'tf-btn active' : 'tf-btn'}
            onClick={() => setTimeframe('weekly')}
          >
            W
          </button>
        </div>
      </div>
      <TradePanel ticker={ticker} lines={lines} />
      {err && <div className="error" style={{ padding: 8 }}>{err}</div>}
    </div>
  );
}
