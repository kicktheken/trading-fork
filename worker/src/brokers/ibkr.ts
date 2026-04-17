import type { Env } from '../env';
import { getIbkrTokens } from '../kv';

export interface PlaceOrderInput {
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  entry: number;
  stop: number;
  target: number;
}

export interface BrokerAdapter {
  placeOrder(userSub: string, input: PlaceOrderInput): Promise<{ id: string }>;
}

// Wraps @quentinadam/ibkr (OAuth 1.0a IBKR Web API).
// NOTE: `@quentinadam/ibkr` is distributed on JSR primarily; verify runtime
// compatibility with Workers before enabling live trades. We import lazily
// so a missing package at dev time won't break the Worker boot.
export function ibkrAdapter(env: Env): BrokerAdapter {
  return {
    async placeOrder(userSub, input) {
      const tokens = await getIbkrTokens(env, userSub);
      if (!tokens) {
        throw new Error('ibkr not linked — start OAuth at /api/auth/ibkr/start');
      }

      // TODO(live-trading): construct the IBKR client and submit the order.
      //
      // Expected shape (pseudo):
      //
      //   const { Client } = await import('@quentinadam/ibkr');
      //   const client = new Client({
      //     consumerKey: env.IBKR_CONSUMER_KEY,
      //     consumerSecret: env.IBKR_CONSUMER_SECRET,
      //     accessToken: tokens.accessToken,
      //     accessTokenSecret: tokens.accessTokenSecret,
      //   });
      //   const res = await client.placeOrder({
      //     conid: await client.resolveConid(input.ticker),
      //     side: input.side.toUpperCase(),
      //     quantity: input.quantity,
      //     orderType: 'LMT',
      //     price: input.entry,
      //     // bracket children for stop / target
      //   });
      //   return { id: res.orderId };

      throw new Error(
        `ibkr placeOrder stub: ${input.side} ${input.quantity} ${input.ticker} @ ${input.entry} (stop ${input.stop}, target ${input.target})`,
      );
    },
  };
}
