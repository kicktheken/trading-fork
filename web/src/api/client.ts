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
  // Hint to the broker adapter so it can pick LIMIT vs STOP for the parent.
  currentPrice?: number;
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

export interface Quote {
  ticker: string;
  price: number;
  size: number;
  timestamp: number;
}

export async function fetchQuote(ticker: string): Promise<Quote> {
  const res = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
  return json<Quote>(res);
}

export async function submitOrder(order: OrderRequest): Promise<{ id: string }> {
  // Forward ?rtFmt= from the page URL so we can A/B-test releaseTime serialization
  // without touching the deployed code.
  const pageRtFmt = new URLSearchParams(window.location.search).get('rtFmt');
  const qs = pageRtFmt ? `?rtFmt=${encodeURIComponent(pageRtFmt)}` : '';
  const res = await fetch(`/api/orders${qs}`, {
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
  releaseTime?: string;
  quantity?: number;
  filledQuantity?: number;
  remainingQuantity?: number;
  orderType?: string;
  orderStrategyType?: string;
  // Price/stopPrice/legs are populated for actual order leaves; absent on
  // grouping nodes like OCO. Adapters echo what Schwab returns verbatim.
  price?: number;
  stopPrice?: number;
  orderLegCollection?: Array<{
    instruction?: string;
    quantity?: number;
    instrument?: { symbol?: string };
  }>;
  childOrderStrategies?: SchwabOrderSnapshot[];
}

export interface ExistingOrderLevels {
  entries: number[];
  stops: number[];
  targets: number[];
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

export async function fetchActiveOrdersForTicker(
  accountHash: string,
  ticker: string,
): Promise<SchwabOrderSnapshot[]> {
  const res = await fetch(
    `/api/orders/schwab/active?accountHash=${encodeURIComponent(accountHash)}&ticker=${encodeURIComponent(ticker)}`,
  );
  const data = await json<{ orders: SchwabOrderSnapshot[] }>(res);
  return data.orders;
}
