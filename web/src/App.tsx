import { useEffect, useState } from 'react';
import { Chart, type PriceLines } from './components/Chart';
import { TradePanel } from './components/TradePanel';
import { fetchBars, type Bar } from './api/client';

export function App() {
  const [tickerInput, setTickerInput] = useState('AAPL');
  const [ticker, setTicker] = useState('AAPL');
  const [bars, setBars] = useState<Bar[]>([]);
  const [lines, setLines] = useState<PriceLines>({ entry: 0, stop: 0, target: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchBars(ticker)
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
  }, [ticker]);

  const load = () => {
    const next = tickerInput.trim().toUpperCase();
    if (next) setTicker(next);
  };

  return (
    <div className="app">
      <div className="topbar">
        <input
          value={tickerInput}
          onChange={(e) => setTickerInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
          placeholder="TICKER"
          autoCapitalize="characters"
          autoCorrect="off"
        />
        <button onClick={load} disabled={loading}>
          {loading ? '…' : 'Load'}
        </button>
      </div>
      <div className="chart-wrap">
        <Chart bars={bars} lines={lines} onLinesChange={setLines} />
      </div>
      <TradePanel ticker={ticker} lines={lines} />
      {err && <div className="error" style={{ padding: 8 }}>{err}</div>}
    </div>
  );
}
