import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';

export const barsRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

interface AlpacaBar {
  t: string; // ISO timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars: AlpacaBar[];
  next_page_token: string | null;
}

barsRoute.get('/', async (c) => {
  const ticker = (c.req.query('ticker') ?? '').trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return c.json({ error: 'invalid ticker' }, 400);
  }
  const tf = c.req.query('tf') === 'weekly' ? 'weekly' : 'daily';

  // Daily view: ~1 year of trading days. Weekly view: ~5 years, so after
  // client-side weekly aggregation we get roughly the same number of bars.
  const end = new Date();
  const days = tf === 'weekly' ? 370 * 5 : 370;
  const start = new Date(end.getTime() - 1000 * 60 * 60 * 24 * days);

  const url = new URL(`/v2/stocks/${encodeURIComponent(ticker)}/bars`, c.env.ALPACA_DATA_BASE);
  url.searchParams.set('timeframe', '1Day');
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  url.searchParams.set('limit', tf === 'weekly' ? '2000' : '400');
  url.searchParams.set('adjustment', 'raw');
  url.searchParams.set('feed', 'iex');

  const res = await fetch(url.toString(), {
    headers: {
      'APCA-API-KEY-ID': c.env.ALPACA_KEY_ID,
      'APCA-API-SECRET-KEY': c.env.ALPACA_SECRET,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return c.json({ error: 'alpaca request failed', status: res.status, detail: text }, 502);
  }

  const data = (await res.json()) as AlpacaBarsResponse;
  const bars = (data.bars ?? []).map((b) => ({
    timestamp: Date.parse(b.t),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));

  return c.json({ ticker, bars });
});
