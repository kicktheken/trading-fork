export interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderRequest {
  broker: 'ibkr' | 'schwab';
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  entry: number;
  stop: number;
  target: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchBars(ticker: string): Promise<Bar[]> {
  const res = await fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}`);
  const data = await json<{ bars: Bar[] }>(res);
  return data.bars;
}

export async function submitOrder(order: OrderRequest): Promise<{ id: string }> {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(order),
  });
  return json<{ id: string }>(res);
}
