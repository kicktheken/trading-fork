import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';

export const quoteRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

interface AlpacaTrade {
  t: string;
  p: number;
  s: number;
  x: string;
}

interface AlpacaTradeResponse {
  symbol: string;
  trade: AlpacaTrade;
}

quoteRoute.get('/', async (c) => {
  const ticker = (c.req.query('ticker') ?? '').trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return c.json({ error: 'invalid ticker' }, 400);
  }

  // Alpaca's latest trade endpoint gives us a single price + timestamp.
  // /trades/latest is more useful than /quotes/latest for chart price updates,
  // since quotes are bid/ask and not the actual print.
  const url = new URL(
    `/v2/stocks/${encodeURIComponent(ticker)}/trades/latest`,
    c.env.ALPACA_DATA_BASE,
  );
  url.searchParams.set('feed', 'iex');

  const res = await fetch(url.toString(), {
    headers: {
      'APCA-API-KEY-ID': c.env.ALPACA_KEY_ID,
      'APCA-API-SECRET-KEY': c.env.ALPACA_SECRET,
    },
    cf: {
      // Edge-cache identical requests for 500ms so multiple tabs / fast polls
      // don't multiply our outbound rate. Alpaca's free tier allows 200 rpm;
      // this keeps us comfortable.
      cacheTtl: 1,
      cacheEverything: true,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return c.json({ error: 'alpaca request failed', status: res.status, detail: text }, 502);
  }

  const data = (await res.json()) as AlpacaTradeResponse;
  const t = data.trade;
  if (!t) return c.json({ error: 'no trade data' }, 502);

  return c.json({
    ticker,
    price: t.p,
    size: t.s,
    timestamp: Date.parse(t.t),
  });
});
