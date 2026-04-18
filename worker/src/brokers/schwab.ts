import {
  createApiClient,
  createSchwabAuth,
  AuthStrategy,
  EnhancedTokenManager,
  type SchwabApiClient,
} from '@sudowealth/schwab-api';
import type { Env } from '../env';
import { loadSchwabTokens, saveSchwabTokens } from '../kv';
import type { BrokerAdapter, PlaceOrderInput } from './ibkr';

// Build a per-user Schwab auth client. Must be constructed per request —
// load/save close over `userSub` so they hit the right KV key.
export function schwabAuthFor(env: Env, userSub: string): EnhancedTokenManager {
  return createSchwabAuth({
    strategy: AuthStrategy.ENHANCED,
    oauthConfig: {
      clientId: env.SCHWAB_CLIENT_ID,
      clientSecret: env.SCHWAB_CLIENT_SECRET,
      redirectUri: env.SCHWAB_REDIRECT_URI,
      load: () => loadSchwabTokens(env, userSub),
      save: (tokens) => saveSchwabTokens(env, userSub, tokens),
    },
  });
}

export function schwabClient(env: Env, userSub: string): SchwabApiClient {
  const auth = schwabAuthFor(env, userSub);
  return createApiClient({ auth });
}

export function schwabAdapter(env: Env): BrokerAdapter {
  return {
    async placeOrder(userSub, input: PlaceOrderInput) {
      const existing = await loadSchwabTokens(env, userSub);
      if (!existing) {
        throw new Error('schwab not linked — start OAuth at /api/auth/schwab/start');
      }

      const client = schwabClient(env, userSub);

      const accountNumbers = await client.trader.accounts.getAccountNumbers({});
      const first = accountNumbers?.[0];
      if (!first?.hashValue) {
        throw new Error('schwab: no account found for this user');
      }

      const body = buildStopBuyWithOcoOrder(input);

      // The SDK's zod body schema is generated from Schwab's read-back Order shape,
      // which requires many read-only fields (cusip, status, filledQuantity, etc.)
      // that must NOT be in POST payloads. Cast to bypass the over-specified type;
      // at runtime the middleware strips unknowns and the API accepts the payload.
      const result = await client.trader.orders.placeOrderForAccount({
        pathParams: { accountNumber: first.hashValue },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: body as any,
      });

      // Schwab returns 201 with Location: /orders/{orderId}; the SDK may
      // surface this as the response. Fall back to a descriptive id.
      const id = extractOrderId(result) ?? `schwab:${Date.now()}`;
      return { id };
    },
  };
}

// Build the Schwab payload described in the trader API docs:
// parent = BUY STOP at `entry`, child OCO = SELL LIMIT @ target + SELL STOP @ stop.
// All 1-share for now, as specified.
export function buildStopBuyWithOcoOrder(input: PlaceOrderInput) {
  if (input.side !== 'buy') {
    throw new Error('only buy-side trigger→OCO is wired; sell-side not yet implemented');
  }
  if (!(input.stop < input.entry && input.entry < input.target)) {
    throw new Error('expected stop < entry < target for a buy trigger→OCO');
  }

  const symbol = input.ticker;
  const qty = 1;

  return {
    orderStrategyType: 'TRIGGER',
    session: 'NORMAL',
    duration: 'DAY',
    orderType: 'STOP',
    stopPrice: input.entry.toFixed(2),
    orderLegCollection: [
      {
        instruction: 'BUY',
        quantity: qty,
        instrument: { symbol, assetType: 'EQUITY' },
      },
    ],
    childOrderStrategies: [
      {
        orderStrategyType: 'OCO',
        childOrderStrategies: [
          {
            orderStrategyType: 'SINGLE',
            session: 'NORMAL',
            duration: 'GOOD_TILL_CANCEL',
            orderType: 'LIMIT',
            price: input.target.toFixed(2),
            orderLegCollection: [
              {
                instruction: 'SELL',
                quantity: qty,
                instrument: { symbol, assetType: 'EQUITY' },
              },
            ],
          },
          {
            orderStrategyType: 'SINGLE',
            session: 'NORMAL',
            duration: 'GOOD_TILL_CANCEL',
            orderType: 'STOP',
            stopPrice: input.stop.toFixed(2),
            orderLegCollection: [
              {
                instruction: 'SELL',
                quantity: qty,
                instrument: { symbol, assetType: 'EQUITY' },
              },
            ],
          },
        ],
      },
    ],
  };
}

function extractOrderId(result: unknown): string | null {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.orderId === 'string' || typeof r.orderId === 'number') return String(r.orderId);
    if (typeof r.id === 'string') return r.id;
    if (r.headers && typeof r.headers === 'object') {
      const loc = (r.headers as Record<string, unknown>).location;
      if (typeof loc === 'string') {
        const m = /\/orders\/(\d+)/.exec(loc);
        if (m && m[1]) return m[1];
      }
    }
  }
  return null;
}
