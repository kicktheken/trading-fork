import type { Env } from '../env';
import { getSchwabTokens, putSchwabTokens } from '../kv';
import type { BrokerAdapter, PlaceOrderInput } from './ibkr';

export function schwabAdapter(env: Env): BrokerAdapter {
  return {
    async placeOrder(userSub, input: PlaceOrderInput) {
      let tokens = await getSchwabTokens(env, userSub);
      if (!tokens) {
        throw new Error('schwab not linked — start OAuth at /api/auth/schwab/start');
      }

      // Refresh if expired.
      if (tokens.expiresAt < Date.now() + 60_000) {
        tokens = await refreshSchwabToken(env, userSub, tokens.refreshToken);
      }

      // TODO(live-trading): submit via @sudowealth/schwab-api.
      //
      //   const { createApiClient } = await import('@sudowealth/schwab-api');
      //   const client = createApiClient({ accessToken: tokens.accessToken });
      //   const accounts = await client.trader.getAccounts();
      //   const accountHash = accounts[0].hashValue;
      //   const res = await client.trader.placeOrder(accountHash, {
      //     orderType: 'LIMIT',
      //     session: 'NORMAL',
      //     duration: 'DAY',
      //     orderStrategyType: 'TRIGGER',
      //     price: input.entry,
      //     orderLegCollection: [{
      //       instruction: input.side === 'buy' ? 'BUY' : 'SELL',
      //       quantity: input.quantity,
      //       instrument: { symbol: input.ticker, assetType: 'EQUITY' },
      //     }],
      //     // childOrderStrategies: [stopLoss, takeProfit]
      //   });
      //   return { id: res.orderId };

      throw new Error(
        `schwab placeOrder stub: ${input.side} ${input.quantity} ${input.ticker} @ ${input.entry} (stop ${input.stop}, target ${input.target})`,
      );
    },
  };
}

async function refreshSchwabToken(env: Env, userSub: string, refreshToken: string) {
  const basic = btoa(`${env.SCHWAB_CLIENT_ID}:${env.SCHWAB_CLIENT_SECRET}`);
  const res = await fetch('https://api.schwabapi.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`schwab refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const next = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    updatedAt: Date.now(),
  };
  await putSchwabTokens(env, userSub, next);
  return next;
}
