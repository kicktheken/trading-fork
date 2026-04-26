import { Hono } from 'hono';
import type { AppVariables, Env } from '../env';
import { ibkrAdapter, type PlaceOrderInput } from '../brokers/ibkr';
import { fetchSchwabOrder, schwabAdapter } from '../brokers/schwab';

export const ordersRoute = new Hono<{ Bindings: Env; Variables: AppVariables }>();

interface OrderBody extends PlaceOrderInput {
  broker: 'ibkr' | 'schwab';
  accountHash?: string;
}

ordersRoute.post('/', async (c) => {
  let body: OrderBody;
  try {
    body = await c.req.json<OrderBody>();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const err = validate(body);
  if (err) return c.json({ error: err }, 400);

  const identity = c.get('identity');
  const adapter =
    body.broker === 'ibkr'
      ? ibkrAdapter(c.env)
      : schwabAdapter(c.env, body.accountHash ? { accountHash: body.accountHash } : {});

  try {
    const result = await adapter.placeOrder(identity.sub, {
      ticker: body.ticker,
      side: body.side,
      quantity: body.quantity,
      entry: body.entry,
      stop: body.stop,
      target: body.target,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

ordersRoute.get('/:broker/:id', async (c) => {
  const broker = c.req.param('broker');
  const id = c.req.param('id');
  if (broker !== 'schwab') {
    return c.json({ error: `${broker} order status not implemented` }, 400);
  }
  if (!/^\d+$/.test(id)) return c.json({ error: 'invalid order id' }, 400);

  const accountHash = c.req.query('accountHash') ?? undefined;
  const identity = c.get('identity');
  try {
    const order = await fetchSchwabOrder(c.env, identity.sub, id, accountHash);
    return c.json(order);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

function validate(b: OrderBody): string | null {
  if (b.broker !== 'ibkr' && b.broker !== 'schwab') return 'broker must be ibkr or schwab';
  if (!b.ticker || !/^[A-Z.\-]{1,10}$/.test(b.ticker)) return 'invalid ticker';
  if (b.side !== 'buy' && b.side !== 'sell') return 'side must be buy or sell';
  if (!Number.isFinite(b.quantity) || b.quantity < 1) return 'quantity must be >= 1';
  for (const k of ['entry', 'stop', 'target'] as const) {
    if (!Number.isFinite(b[k]) || b[k] <= 0) return `${k} must be > 0`;
  }
  if (b.side === 'buy' && !(b.stop < b.entry && b.entry < b.target)) {
    return 'for buy: stop < entry < target';
  }
  if (b.side === 'sell' && !(b.target < b.entry && b.entry < b.stop)) {
    return 'for sell: target < entry < stop';
  }
  return null;
}
