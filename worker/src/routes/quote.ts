import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';

export const quoteRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Alpaca quote shape — IEX NBBO snapshot.
//   t: ISO timestamp
//   ax/bx: ask/bid exchange code
//   ap/bp: ask/bid price
//   as/bs: ask/bid size (round lots)
interface AlpacaQuote {
  t: string;
  ax?: string;
  ap: number;
  as?: number;
  bx?: string;
  bp: number;
  bs?: number;
}

interface AlpacaQuoteResponse {
  symbol: string;
  quote: AlpacaQuote;
}

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

  // Fetch quote (bid/ask, updates sub-second) and trade (last print, lags
  // since IEX is ~2-3% of US volume) in parallel. Display price is the trade
  // print; bid/ask come from the quote and tick more frequently in the UI.
  const headers = {
    'APCA-API-KEY-ID': c.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': c.env.ALPACA_SECRET,
  };
  const cf = { cacheTtl: 1, cacheEverything: true } as const;

  const quoteUrl = new URL(
    `/v2/stocks/${encodeURIComponent(ticker)}/quotes/latest`,
    c.env.ALPACA_DATA_BASE,
  );
  quoteUrl.searchParams.set('feed', 'iex');
  const tradeUrl = new URL(
    `/v2/stocks/${encodeURIComponent(ticker)}/trades/latest`,
    c.env.ALPACA_DATA_BASE,
  );
  tradeUrl.searchParams.set('feed', 'iex');

  const [qRes, tRes] = await Promise.all([
    fetch(quoteUrl.toString(), { headers, cf }),
    fetch(tradeUrl.toString(), { headers, cf }),
  ]);

  if (!qRes.ok && !tRes.ok) {
    return c.json(
      {
        error: 'alpaca request failed',
        quoteStatus: qRes.status,
        tradeStatus: tRes.status,
      },
      502,
    );
  }

  const q = qRes.ok ? ((await qRes.json()) as AlpacaQuoteResponse).quote : null;
  const t = tRes.ok ? ((await tRes.json()) as AlpacaTradeResponse).trade : null;

  if (!t && !q) {
    return c.json({ error: 'no quote or trade data' }, 502);
  }

  // Price = last trade. Falls back to bid/ask midpoint only if no trade exists
  // at all (rare, e.g. brand new symbol).
  let price = 0;
  if (t && t.p > 0) price = t.p;
  else if (q && q.ap > 0 && q.bp > 0) price = (q.ap + q.bp) / 2;
  else if (q && q.ap > 0) price = q.ap;
  else if (q && q.bp > 0) price = q.bp;

  return c.json({
    ticker,
    price: Number(price.toFixed(4)),
    bid: q?.bp ?? 0,
    ask: q?.ap ?? 0,
    bidSize: q?.bs ?? 0,
    askSize: q?.as ?? 0,
    size: t?.s ?? 0,
    timestamp: t ? Date.parse(t.t) : q ? Date.parse(q.t) : Date.now(),
  });
});
