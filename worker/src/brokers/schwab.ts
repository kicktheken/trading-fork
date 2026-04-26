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

      // Visible in `wrangler tail` for debugging. Includes everything we send
      // to Schwab so you can confirm releaseTime is actually being included.
      console.log(
        '[schwab placeOrder] ticker=%s qty=%d entry=%s currentPrice=%s payload=%s',
        input.ticker,
        input.quantity,
        input.entry,
        input.currentPrice ?? 'unset',
        JSON.stringify(body),
      );

      const res = await fetch(`${TRADER_BASE}/accounts/${accountHash}/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      const responseText = await res.text();
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      console.log(
        '[schwab placeOrder response] status=%d headers=%s body=%s',
        res.status,
        JSON.stringify(responseHeaders),
        responseText || '<empty>',
      );

      if (!res.ok) {
        throw new Error(`schwab placeOrder ${res.status}: ${responseText}`);
      }

      const location = responseHeaders.location ?? '';
      const id = location.match(/\/orders\/(\d+)/)?.[1] ?? `schwab:${Date.now()}`;
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
  releaseTime?: string;
  quantity?: number;
  filledQuantity?: number;
  remainingQuantity?: number;
  orderType?: string;
  orderStrategyType?: string;
  price?: number;
  stopPrice?: number;
  orderLegCollection?: Array<{
    instruction?: string;
    quantity?: number;
    instrument?: { symbol?: string };
  }>;
  childOrderStrategies?: SchwabOrderSnapshot[];
}

// Schwab order leg shape, narrowed to what we need to filter by symbol.
interface SchwabOrderListEntry extends SchwabOrderSnapshot {
  orderLegCollection?: Array<{
    instrument?: { symbol?: string };
  }>;
}

const ACTIVE_STATUS_SET = new Set([
  'AWAITING_PARENT_ORDER',
  'AWAITING_CONDITION',
  'AWAITING_STOP_CONDITION',
  'AWAITING_MANUAL_REVIEW',
  'AWAITING_UR_OUT',
  'AWAITING_RELEASE_TIME',
  'ACCEPTED',
  'PENDING_ACTIVATION',
  'PENDING_ACKNOWLEDGEMENT',
  'PENDING_CANCEL',
  'PENDING_REPLACE',
  'PENDING_RECALL',
  'QUEUED',
  'WORKING',
  'NEW',
]);

// Recursively check if an order or any descendant matches a given ticker.
function orderMatchesTicker(o: SchwabOrderListEntry, symbol: string): boolean {
  for (const leg of o.orderLegCollection ?? []) {
    if (leg.instrument?.symbol === symbol) return true;
  }
  for (const c of (o.childOrderStrategies ?? []) as SchwabOrderListEntry[]) {
    if (orderMatchesTicker(c, symbol)) return true;
  }
  return false;
}

// Recursively check if any node in an order tree is in an active (non-terminal)
// status. A TRIGGER parent's own status goes to FILLED once the BUY fires, but
// the OCO children remain WORKING — we should still consider the tree active.
function treeHasActiveStatus(o: SchwabOrderListEntry): boolean {
  if (ACTIVE_STATUS_SET.has(o.status)) return true;
  for (const c of (o.childOrderStrategies ?? []) as SchwabOrderListEntry[]) {
    if (treeHasActiveStatus(c)) return true;
  }
  return false;
}

// Statuses we care about for "active orders" badges. Schwab's GET /orders
// status filter only accepts one value at a time, so we fan out one request
// per status and merge the results.
const ACTIVE_STATUSES_TO_QUERY = [
  'WORKING',
  'PENDING_ACTIVATION',
  'PENDING_ACKNOWLEDGEMENT',
  'AWAITING_PARENT_ORDER',
  'AWAITING_RELEASE_TIME',
  'AWAITING_CONDITION',
  'AWAITING_STOP_CONDITION',
  'AWAITING_MANUAL_REVIEW',
  'ACCEPTED',
  'QUEUED',
  'NEW',
] as const;

async function fetchOrdersByStatus(
  accessToken: string,
  accountHash: string,
  status: string,
  fromIso: string,
  toIso: string,
): Promise<SchwabOrderListEntry[]> {
  const url = new URL(`${TRADER_BASE}/accounts/${accountHash}/orders`);
  url.searchParams.set('fromEnteredTime', fromIso);
  url.searchParams.set('toEnteredTime', toIso);
  url.searchParams.set('maxResults', '500');
  url.searchParams.set('status', status);
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    // 404/204 from a status with no orders is fine — just return [].
    if (res.status === 404 || res.status === 204) return [];
    throw new Error(`schwab getOrdersByAccount[${status}] ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  if (!text) return [];
  return JSON.parse(text) as SchwabOrderListEntry[];
}

export async function fetchSchwabActiveOrdersForTicker(
  env: Env,
  userSub: string,
  accountHash: string,
  ticker: string,
): Promise<SchwabOrderSnapshot[]> {
  const auth = schwabAuthFor(env, userSub);
  if (auth.refreshIfNeeded) await auth.refreshIfNeeded();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) throw new Error('schwab: no access token');

  // 90-day window catches GTC orders that were placed a while ago but are still working.
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const buckets = await Promise.all(
    ACTIVE_STATUSES_TO_QUERY.map((s) =>
      fetchOrdersByStatus(accessToken, accountHash, s, fromIso, toIso).catch(() => []),
    ),
  );
  // Dedupe by orderId since the same order tree may surface across multiple
  // status buckets (parent FILLED + children WORKING — though we don't query FILLED).
  const seen = new Set<string | number>();
  const all: SchwabOrderListEntry[] = [];
  for (const bucket of buckets) {
    for (const o of bucket) {
      const id = o.orderId ?? '';
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(o);
    }
  }
  const wanted = ticker.toUpperCase();
  return all.filter((o) => orderMatchesTicker(o, wanted));
}

// Diagnostic version that explains why each order was kept or dropped.
export async function fetchSchwabActiveOrdersDebug(
  env: Env,
  userSub: string,
  accountHash: string,
  ticker: string,
): Promise<{
  orders: SchwabOrderSnapshot[];
  ticker: string;
  totalFromSchwab: number;
  considered: Array<{
    orderId: string | number | undefined;
    parentStatus: string;
    treeHasActive: boolean;
    matchesTicker: boolean;
    seenSymbols: string[];
    kept: boolean;
  }>;
}> {
  const auth = schwabAuthFor(env, userSub);
  if (auth.refreshIfNeeded) await auth.refreshIfNeeded();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) throw new Error('schwab: no access token');

  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const buckets = await Promise.all(
    ACTIVE_STATUSES_TO_QUERY.map((s) =>
      fetchOrdersByStatus(accessToken, accountHash, s, fromIso, toIso).catch(() => []),
    ),
  );
  const seen = new Set<string | number>();
  const all: SchwabOrderListEntry[] = [];
  for (const bucket of buckets) {
    for (const o of bucket) {
      const id = o.orderId ?? '';
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(o);
    }
  }
  const wanted = ticker.toUpperCase();

  const collectSymbols = (o: SchwabOrderListEntry, out: Set<string>): void => {
    for (const leg of o.orderLegCollection ?? []) {
      if (leg.instrument?.symbol) out.add(leg.instrument.symbol);
    }
    for (const c of (o.childOrderStrategies ?? []) as SchwabOrderListEntry[]) {
      collectSymbols(c, out);
    }
  };

  const considered = all.map((o) => {
    const symbols = new Set<string>();
    collectSymbols(o, symbols);
    const treeHasActive = treeHasActiveStatus(o);
    const matchesTicker = orderMatchesTicker(o, wanted);
    return {
      orderId: o.orderId,
      parentStatus: o.status,
      treeHasActive,
      matchesTicker,
      seenSymbols: [...symbols],
      kept: treeHasActive && matchesTicker,
    };
  });

  return {
    orders: all.filter((o) => treeHasActiveStatus(o) && orderMatchesTicker(o, wanted)),
    ticker: wanted,
    totalFromSchwab: all.length,
    considered,
  };
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

// Format choices for releaseTime — useful while we're still figuring out
// which (if any) format Schwab honors for retail accounts.
//   'z'      => 2026-04-26T13:31:00.000Z       (default ISO, what JS Date emits)
//   'offset' => 2026-04-26T13:31:00.000+0000   (no colon, matches Schwab echo)
//   'naive'  => 2026-04-26T13:31:00.000        (no timezone designator)
export type ReleaseTimeFormat = 'z' | 'offset' | 'naive';

function formatReleaseTime(d: Date, format: ReleaseTimeFormat): string {
  const iso = d.toISOString();
  if (format === 'offset') return iso.replace(/Z$/, '+0000');
  if (format === 'naive') return iso.replace(/Z$/, '');
  return iso;
}

// Compute 1 minute after the next NYSE regular open (09:30 NY -> return 09:31 NY).
// Skips weekends. Doesn't account for early closes / holidays — Schwab will
// still accept the releaseTime; if it lands on a holiday the order just sits
// in AWAITING_RELEASE_TIME until the next session.
export function oneMinuteAfterNextMarketOpen(
  now: Date = new Date(),
  format: ReleaseTimeFormat = 'z',
): string {
  const nyParts = nyDateParts(now);
  let candidate = nyDateAt(nyParts.year, nyParts.month, nyParts.day, 9, 31);
  if (candidate.getTime() <= now.getTime()) {
    candidate = addDays(candidate, 1);
  }
  while (true) {
    const dow = candidate.getUTCDay();
    if (dow === 0 || dow === 6) {
      candidate = addDays(candidate, 1);
      continue;
    }
    break;
  }
  return formatReleaseTime(candidate, format);
}

function nyDateParts(d: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Build a UTC instant that corresponds to the given Y-M-D h:m wall time in NY.
function nyDateAt(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Start with the naive UTC instant; iteratively correct until the formatted
  // NY parts match the requested inputs. (Handles DST without a tz library.)
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let i = 0; i < 3; i++) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(guess);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const y = get('year'),
      mo = get('month'),
      d = get('day'),
      h = get('hour') % 24, // hour12:false sometimes returns "24"
      mi = get('minute');
    const wantMinutes = hour * 60 + minute;
    const gotMinutes = h * 60 + mi;
    const dayOff =
      Date.UTC(year, month - 1, day) - Date.UTC(y, mo - 1, d);
    const offsetMs = dayOff + (wantMinutes - gotMinutes) * 60_000;
    if (offsetMs === 0) break;
    guess = new Date(guess.getTime() + offsetMs);
  }
  return guess;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

// Parent BUY at `entry` (STOP if entry > current, LIMIT if entry <= current),
// child OCO = SELL LIMIT @ target + SELL STOP @ stop. All prices are numbers
// (Schwab rejects strings on the new API).
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

  // If we have a live price reference and entry is at/below it, the parent is
  // a BUY LIMIT (fills immediately or waits for a pullback). Otherwise it's a
  // BUY STOP (waits for a breakout above the current market).
  const useLimit =
    typeof input.currentPrice === 'number' &&
    input.currentPrice > 0 &&
    input.entry <= input.currentPrice;

  const parent = useLimit
    ? { orderType: 'LIMIT', price: round(input.entry) }
    : { orderType: 'STOP', stopPrice: round(input.entry) };

  // For BUY STOPs, hold the order until 1 minute after the next market open.
  // This avoids the order firing on the opening auction's first prints, which
  // are often volatile and can trigger a stop above resting size at a bad
  // print. LIMIT orders submit immediately (they can sit on the book safely).
  const releaseTime = useLimit
    ? null
    : oneMinuteAfterNextMarketOpen(new Date(), input.releaseTimeFormat ?? 'z');

  return {
    orderStrategyType: 'TRIGGER',
    session: 'NORMAL',
    duration: 'DAY',
    ...parent,
    ...(releaseTime ? { releaseTime } : {}),
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
