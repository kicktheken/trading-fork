import { useState } from 'react';
import { submitOrder, type OrderRequest } from '../api/client';
import type { PriceLines } from './Chart';

interface Props {
  ticker: string;
  lines: PriceLines;
}

export function TradePanel({ ticker, lines }: Props) {
  const [broker, setBroker] = useState<OrderRequest['broker']>('ibkr');
  const [side, setSide] = useState<OrderRequest['side']>('buy');
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await submitOrder({
        broker,
        ticker,
        side,
        quantity,
        entry: lines.entry,
        stop: lines.stop,
        target: lines.target,
      });
      setStatus(`Submitted: ${res.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-panel">
      <div>
        <label>Broker</label>
        <select value={broker} onChange={(e) => setBroker(e.target.value as OrderRequest['broker'])}>
          <option value="ibkr">Interactive Brokers</option>
          <option value="schwab">Schwab</option>
        </select>
      </div>
      <div>
        <label>Side</label>
        <select value={side} onChange={(e) => setSide(e.target.value as OrderRequest['side'])}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
      </div>
      <div>
        <label>Qty</label>
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
        />
      </div>
      <div>
        <label>Entry / Stop / Target</label>
        <input
          readOnly
          value={`${lines.entry.toFixed(2)} / ${lines.stop.toFixed(2)} / ${lines.target.toFixed(2)}`}
        />
      </div>
      <button className="submit" disabled={busy || !ticker} onClick={onSubmit}>
        {busy ? 'Submitting…' : `Submit ${side.toUpperCase()} ${ticker || ''}`}
      </button>
      {status && <div className="status">{status}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
