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
  accountHash?: string;
}

export interface SchwabAccountSummary {
  accountNumber: string;
  hashValue: string;
  type: string;
  availableFunds: number;
  totalValue: number;
}

export async function fetchSchwabAccounts(): Promise<SchwabAccountSummary[]> {
  const res = await fetch('/api/accounts/schwab');
  const data = await json<{ accounts: SchwabAccountSummary[] }>(res);
  return data.accounts;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchBars(ticker: string, tf: 'daily' | 'weekly' = 'daily'): Promise<Bar[]> {
  const res = await fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=${tf}`);
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

export interface SchwabStatus {
  linked: boolean;
  expiresAt: number | null;
}

export async function fetchSchwabStatus(): Promise<SchwabStatus> {
  const res = await fetch('/api/auth/schwab/status');
  return json<SchwabStatus>(res);
}

export interface SchwabOrderSnapshot {
  orderId: string;
  status: string;
  statusDescription?: string;
  enteredTime?: string;
  filledQuantity?: number;
  remainingQuantity?: number;
  childOrderStrategies?: SchwabOrderSnapshot[];
}

export async function fetchOrder(
  broker: 'schwab',
  orderId: string,
  accountHash?: string,
): Promise<SchwabOrderSnapshot> {
  const qs = accountHash ? `?accountHash=${encodeURIComponent(accountHash)}` : '';
  const res = await fetch(`/api/orders/${broker}/${encodeURIComponent(orderId)}${qs}`);
  return json<SchwabOrderSnapshot>(res);
}
