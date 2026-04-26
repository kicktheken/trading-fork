import {
  createSchwabAuth,
  AuthStrategy,
  EnhancedTokenManager,
} from '@sudowealth/schwab-api';
import type { Env } from '../env';
import { loadSchwabTokens, saveSchwabTokens } from '../kv';
import type { BrokerAdapter, PlaceOrderInput } from './ibkr';

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

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

export interface SchwabOrderOptions {
  accountHash?: string;
}

export function schwabAdapter(env: Env, options: SchwabOrderOptions = {}): BrokerAdapter {
  return {
    async placeOrder(userSub, input: PlaceOrderInput) {
      const existing = await loadSchwabTokens(env, userSub);
      if (!existing) {
        throw new Error('schwab not linked — start OAuth at /api/auth/schwab/start');
      }

      const auth = schwabAuthFor(env, userSub);
      // Let the manager refresh if the cached token is stale.
      if (auth.refreshIfNeeded) await auth.refreshIfNeeded();
      const accessToken = await auth.getAccessToken();
      if (!accessToken) {
        throw new Error('schwab: no access token available; re-link at /api/auth/schwab/start');
      }

      const accountHash = options.accountHash ?? (await firstAccountHash(accessToken));
      const body = buildStopBuyWithOcoOrder(input);

      const res = await fetch(`${TRADER_BASE}/accounts/${accountHash}/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`schwab placeOrder ${res.status}: ${detail}`);
      }

      const location = res.headers.get('location');
      const id = location?.match(/\/orders\/(\d+)/)?.[1] ?? `schwab:${Date.now()}`;
      return { id };
    },
  };
}

async function firstAccountHash(accessToken: string): Promise<string> {
  const res = await fetch(`${TRADER_BASE}/accounts/accountNumbers`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`schwab getAccountNumbers ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Array<{ accountNumber: string; hashValue: string }>;
  const first = data[0];
  if (!first?.hashValue) throw new Error('schwab: no accounts found for this user');
  return first.hashValue;
}

export interface SchwabAccountSummary {
  accountNumber: string;
  hashValue: string;
  type: string;
  availableFunds: number;
  totalValue: number;
}

interface AccountNumbersEntry {
  accountNumber: string;
  hashValue: string;
}

interface AccountsApiEntry {
  securitiesAccount?: {
    type?: string;
    accountNumber?: string;
    currentBalances?: {
      cashAvailableForTrading?: number;
      buyingPower?: number;
      liquidationValue?: number;
      equity?: number;
    };
  };
}

export async function fetchSchwabAccounts(env: Env, userSub: string): Promise<SchwabAccountSummary[]> {
  const auth = schwabAuthFor(env, userSub);
  if (auth.refreshIfNeeded) await auth.refreshIfNeeded();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) throw new Error('schwab: no access token');

  const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };

  const [numbersRes, accountsRes] = await Promise.all([
    fetch(`${TRADER_BASE}/accounts/accountNumbers`, { headers }),
    fetch(`${TRADER_BASE}/accounts`, { headers }),
  ]);
  if (!numbersRes.ok) {
    throw new Error(`schwab getAccountNumbers ${numbersRes.status}: ${await numbersRes.text()}`);
  }
  if (!accountsRes.ok) {
    throw new Error(`schwab getAccounts ${accountsRes.status}: ${await accountsRes.text()}`);
  }

  const numbers = (await numbersRes.json()) as AccountNumbersEntry[];
  const accounts = (await accountsRes.json()) as AccountsApiEntry[];

  const balanceByAccount = new Map<string, { type: string; available: number; total: number }>();
  for (const a of accounts) {
    const sa = a.securitiesAccount;
    if (!sa?.accountNumber) continue;
    const balances = sa.currentBalances ?? {};
    // For cash accounts use cashAvailableForTrading; for margin, buyingPower.
    const available =
      balances.cashAvailableForTrading ??
      balances.buyingPower ??
      0;
    const total = balances.liquidationValue ?? balances.equity ?? 0;
    balanceByAccount.set(sa.accountNumber, {
      type: sa.type ?? 'UNKNOWN',
      available,
      total,
    });
  }

  return numbers.map((n) => {
    const b = balanceByAccount.get(n.accountNumber);
    return {
      accountNumber: n.accountNumber,
      hashValue: n.hashValue,
      type: b?.type ?? 'UNKNOWN',
      availableFunds: b?.available ?? 0,
      totalValue: b?.total ?? 0,
    };
  });
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

export async function fetchSchwabOrder(
  env: Env,
  userSub: string,
  orderId: string,
  accountHash?: string,
): Promise<SchwabOrderSnapshot> {
  const auth = schwabAuthFor(env, userSub);
  if (auth.refreshIfNeeded) await auth.refreshIfNeeded();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) throw new Error('schwab: no access token');

  // If the caller knows which account the order lives on, use that. Otherwise
  // fall back to scanning all accounts (Schwab orderIds are unique per account
  // and 404 on accounts that don't own them).
  if (accountHash) {
    const res = await fetch(`${TRADER_BASE}/accounts/${accountHash}/orders/${orderId}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`schwab getOrder ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as SchwabOrderSnapshot;
  }

  // No accountHash specified — try each account until one returns the order.
  const numbersRes = await fetch(`${TRADER_BASE}/accounts/accountNumbers`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!numbersRes.ok) {
    throw new Error(`schwab getAccountNumbers ${numbersRes.status}: ${await numbersRes.text()}`);
  }
  const accounts = (await numbersRes.json()) as Array<{ hashValue: string }>;
  let lastErr = '';
  for (const a of accounts) {
    const res = await fetch(`${TRADER_BASE}/accounts/${a.hashValue}/orders/${orderId}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (res.ok) return (await res.json()) as SchwabOrderSnapshot;
    if (res.status !== 404) {
      lastErr = `${res.status}: ${await res.text()}`;
    }
  }
  throw new Error(
    lastErr ? `schwab getOrder failed across accounts: ${lastErr}` : `schwab getOrder: order ${orderId} not found in any account`,
  );
}

// Parent BUY STOP at `entry`, child OCO = SELL LIMIT @ target + SELL STOP @ stop.
// All prices are numbers (Schwab rejects strings on the new API).
export function buildStopBuyWithOcoOrder(input: PlaceOrderInput) {
  if (input.side !== 'buy') {
    throw new Error('only buy-side trigger→OCO is wired; sell-side not yet implemented');
  }
  if (!(input.stop < input.entry && input.entry < input.target)) {
    throw new Error('expected stop < entry < target for a buy trigger→OCO');
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error(`quantity must be a positive integer, got ${input.quantity}`);
  }

  const symbol = input.ticker;
  const qty = input.quantity;
  const round = (n: number) => Number(n.toFixed(2));

  return {
    orderStrategyType: 'TRIGGER',
    session: 'NORMAL',
    duration: 'DAY',
    orderType: 'STOP',
    stopPrice: round(input.entry),
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
            price: round(input.target),
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
            stopPrice: round(input.stop),
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
