import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchActiveOrdersForTicker,
  fetchOrder,
  fetchSchwabAccounts,
  fetchSchwabStatus,
  submitOrder,
  type SchwabAccountSummary,
  type SchwabOrderSnapshot,
} from '../api/client';
import type { PriceLines } from './Chart';
import { SwipeButton } from './SwipeButton';

const TERMINAL_STATUSES = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'REPLACED',
]);

const ALLOC_STORAGE_KEY = 'trading-fork:schwab-allocations';

interface AllocationRecord {
  // accountNumber -> { dollars: string, enabled: bool }
  [accountNumber: string]: { dollars: string; enabled: boolean };
}

function loadAllocations(): AllocationRecord {
  try {
    const raw = localStorage.getItem(ALLOC_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as AllocationRecord;
  } catch {
    // ignore
  }
  return {};
}

function saveAllocations(allocs: AllocationRecord) {
  try {
    localStorage.setItem(ALLOC_STORAGE_KEY, JSON.stringify(allocs));
  } catch {
    // ignore
  }
}

function isTreeTerminal(o: SchwabOrderSnapshot): boolean {
  if (!TERMINAL_STATUSES.has(o.status)) return false;
  for (const c of o.childOrderStrategies ?? []) {
    if (!isTreeTerminal(c)) return false;
  }
  return true;
}

// "Accepted" = Schwab took the order and it's healthy. This includes terminal
// success states AND the "waiting/working" states that mean the order was
// successfully placed and the user has nothing left to do.
const ACCEPTED_STATUSES = new Set([
  'FILLED',
  'WORKING',
  'PENDING_ACTIVATION',
  'PENDING_ACKNOWLEDGEMENT',
  'AWAITING_PARENT_ORDER',
  'AWAITING_CONDITION',
  'AWAITING_STOP_CONDITION',
  'AWAITING_RELEASE_TIME',
  'ACCEPTED',
  'QUEUED',
  'NEW',
]);

function isTreeAccepted(o: SchwabOrderSnapshot): boolean {
  if (!ACCEPTED_STATUSES.has(o.status)) return false;
  for (const c of o.childOrderStrategies ?? []) {
    if (!isTreeAccepted(c)) return false;
  }
  return true;
}

function findRejectedChild(o: SchwabOrderSnapshot): SchwabOrderSnapshot | null {
  for (const c of o.childOrderStrategies ?? []) {
    if (c.status === 'REJECTED') return c;
    const deeper = findRejectedChild(c);
    if (deeper) return deeper;
  }
  return null;
}

// REPLACED legs accumulate as history when the user edits an OCO via TOS —
// they're terminal versions of the live order and shouldn't be shown.
const HIDE_FROM_DISPLAY = new Set(['REPLACED']);

function flattenChildren(o: SchwabOrderSnapshot): SchwabOrderSnapshot[] {
  const out: SchwabOrderSnapshot[] = [];
  for (const c of o.childOrderStrategies ?? []) {
    if (c.childOrderStrategies && c.childOrderStrategies.length > 0) {
      out.push(...c.childOrderStrategies);
    } else {
      out.push(c);
    }
  }
  return out.filter((c) => !HIDE_FROM_DISPLAY.has(c.status));
}

function childLabel(c: SchwabOrderSnapshot, i: number): string {
  // Label by order type: LIMIT = take-profit Target, STOP/STOP_LIMIT = Stop.
  // Falls back to position index if orderType is missing for any reason.
  if (c.orderType === 'LIMIT') return 'Target';
  if (c.orderType === 'STOP' || c.orderType === 'STOP_LIMIT' || c.orderType === 'TRAILING_STOP') {
    return 'Stop';
  }
  return i === 0 ? 'Target' : i === 1 ? 'Stop' : `Leg ${i + 1}`;
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function fmtAcctMask(num: string): string {
  return num.length > 4 ? `••••${num.slice(-4)}` : num;
}

interface AccountResult {
  accountNumber: string;
  accountHash: string;
  ok: boolean;
  orderId?: string;
  error?: string;
  snapshot?: SchwabOrderSnapshot;
  polling?: boolean;
}

function statusClass(status: string): string {
  if (status === 'FILLED') return 'st st-filled';
  if (status === 'WORKING' || status === 'PENDING_ACTIVATION' || status === 'ACCEPTED') {
    return 'st st-working';
  }
  if (status === 'AWAITING_PARENT_ORDER') return 'st st-waiting';
  if (status === 'REJECTED' || status === 'CANCELED' || status === 'EXPIRED') {
    return 'st st-bad';
  }
  return 'st';
}

interface Props {
  ticker: string;
  lines: PriceLines;
  currentPrice: number | null;
}

export function TradePanel({ ticker, lines, currentPrice }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schwabLinked, setSchwabLinked] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<SchwabAccountSummary[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [allocations, setAllocations] = useState<AllocationRecord>(loadAllocations);
  const [results, setResults] = useState<AccountResult[]>([]);
  // accountNumber -> count of active orders matching the current ticker.
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({});
  // accountNumber -> active orders cache (so the click handler can show without a refetch).
  const activeOrdersCache = useRef<Record<string, SchwabOrderSnapshot[]>>({});

  const pollTimers = useRef<Map<string, number>>(new Map());
  const pollGen = useRef(0);

  // Persist allocations on every change.
  useEffect(() => {
    saveAllocations(allocations);
  }, [allocations]);

  // Load schwab status + accounts on mount.
  useEffect(() => {
    let cancelled = false;
    fetchSchwabStatus()
      .then((s) => {
        if (cancelled) return;
        setSchwabLinked(s.linked);
        if (s.linked) {
          fetchSchwabAccounts()
            .then((accts) => {
              if (!cancelled) setAccounts(accts);
            })
            .catch((e) => {
              if (!cancelled) setAccountsError(e instanceof Error ? e.message : String(e));
            });
        }
      })
      .catch(() => {
        if (!cancelled) setSchwabLinked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cancel polling on unmount.
  useEffect(
    () => () => {
      stopAllPolling();
    },
    [],
  );

  // Refresh per-account active-order counts when accounts or ticker change.
  useEffect(() => {
    if (!accounts || !ticker) {
      setActiveCounts({});
      activeOrdersCache.current = {};
      return;
    }
    let cancelled = false;
    Promise.all(
      accounts.map(async (a) => {
        try {
          const orders = await fetchActiveOrdersForTicker(a.hashValue, ticker);
          return { acctNum: a.accountNumber, orders };
        } catch {
          return { acctNum: a.accountNumber, orders: [] as SchwabOrderSnapshot[] };
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const counts: Record<string, number> = {};
      const cache: Record<string, SchwabOrderSnapshot[]> = {};
      for (const r of rows) {
        counts[r.acctNum] = r.orders.length;
        cache[r.acctNum] = r.orders;
      }
      setActiveCounts(counts);
      activeOrdersCache.current = cache;
    });
    return () => {
      cancelled = true;
    };
  }, [accounts, ticker]);

  const showActiveOrdersFor = (account: SchwabAccountSummary) => {
    const cached = activeOrdersCache.current[account.accountNumber] ?? [];
    stopAllPolling();
    setError(null);
    setResults(
      cached.map((snap) => ({
        accountNumber: account.accountNumber,
        accountHash: account.hashValue,
        ok: true,
        orderId: snap.orderId,
        snapshot: snap,
        polling: false,
      })),
    );
  };

  const stopAllPolling = () => {
    for (const id of pollTimers.current.values()) {
      window.clearTimeout(id);
    }
    pollTimers.current.clear();
    pollGen.current++;
  };

  const setPolling = (accountNumber: string, polling: boolean) => {
    setResults((prev) =>
      prev.map((r) => (r.accountNumber === accountNumber ? { ...r, polling } : r)),
    );
  };

  const startPollingFor = (accountNumber: string, accountHash: string, orderId: string) => {
    const myGen = pollGen.current;
    let attempt = 0;
    let currentId = orderId;
    let firstFetchSucceeded = false;
    setPolling(accountNumber, true);
    const tick = async () => {
      if (myGen !== pollGen.current) return;
      attempt++;
      try {
        const snap = await fetchOrder('schwab', currentId, accountHash);
        if (myGen !== pollGen.current) return;
        firstFetchSucceeded = true;
        setResults((prev) =>
          prev.map((r) => (r.accountNumber === accountNumber ? { ...r, snapshot: snap } : r)),
        );
        const rejected = findRejectedChild(snap);
        if (rejected) {
          const reason = rejected.statusDescription?.trim();
          const acct = fmtAcctMask(accountNumber);
          setError(
            reason
              ? `${acct} rejected ${childLabel(rejected, 0)}: ${reason}`
              : `${acct} rejected child order. Review your account.`,
          );
        }
        if (snap.status === 'REPLACED' && snap.childOrderStrategies?.[0]?.orderId) {
          currentId = snap.childOrderStrategies[0].orderId;
        } else if (isTreeTerminal(snap)) {
          setPolling(accountNumber, false);
          pollTimers.current.delete(accountNumber);
          return;
        }
      } catch (e) {
        const transient = !firstFetchSucceeded && attempt <= 3;
        if (!transient) {
          setError(
            `${fmtAcctMask(accountNumber)} status poll failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          setPolling(accountNumber, false);
          pollTimers.current.delete(accountNumber);
          return;
        }
      }
      if (attempt > 60) {
        setPolling(accountNumber, false);
        pollTimers.current.delete(accountNumber);
        return;
      }
      const delay = attempt < 15 ? 2000 : 10000;
      const tid = window.setTimeout(tick, delay);
      pollTimers.current.set(accountNumber, tid);
    };
    const tid = window.setTimeout(tick, 300);
    pollTimers.current.set(accountNumber, tid);
  };

  const setAlloc = (accountNumber: string, patch: Partial<AllocationRecord[string]>) => {
    setAllocations((prev) => ({
      ...prev,
      [accountNumber]: {
        dollars: prev[accountNumber]?.dollars ?? '',
        enabled: prev[accountNumber]?.enabled ?? false,
        ...patch,
      },
    }));
  };

  // Compute per-account quantity given the entry price and dollar amount.
  const planned = useMemo(() => {
    if (!accounts || lines.entry <= 0) return [];
    return accounts.map((a) => {
      const alloc = allocations[a.accountNumber];
      const dollars = Number(alloc?.dollars ?? '');
      const enabled = !!alloc?.enabled;
      const qty = enabled && Number.isFinite(dollars) && dollars > 0
        ? Math.floor(dollars / lines.entry)
        : 0;
      return { account: a, dollars, enabled, qty };
    });
  }, [accounts, allocations, lines.entry]);

  const ordersToSubmit = planned.filter((p) => p.enabled && p.qty > 0);
  const canSubmit =
    !!ticker &&
    schwabLinked === true &&
    ordersToSubmit.length > 0 &&
    lines.stop < lines.entry &&
    lines.entry < lines.target;

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    setResults([]);
    stopAllPolling();

    const initial: AccountResult[] = ordersToSubmit.map((p) => ({
      accountNumber: p.account.accountNumber,
      accountHash: p.account.hashValue,
      ok: false,
    }));
    setResults(initial);

    await Promise.all(
      ordersToSubmit.map(async (p) => {
        try {
          const res = await submitOrder({
            broker: 'schwab',
            ticker,
            side: 'buy',
            quantity: p.qty,
            entry: lines.entry,
            stop: lines.stop,
            target: lines.target,
            accountHash: p.account.hashValue,
            currentPrice: currentPrice ?? undefined,
          });
          setResults((prev) =>
            prev.map((r) =>
              r.accountNumber === p.account.accountNumber
                ? { ...r, ok: true, orderId: res.id }
                : r,
            ),
          );
          if (/^\d+$/.test(res.id)) {
            startPollingFor(p.account.accountNumber, p.account.hashValue, res.id);
          }
        } catch (e) {
          setResults((prev) =>
            prev.map((r) =>
              r.accountNumber === p.account.accountNumber
                ? { ...r, ok: false, error: e instanceof Error ? e.message : String(e) }
                : r,
            ),
          );
        }
      }),
    );

    setBusy(false);
  };

  const dismissBanner = () => {
    stopAllPolling();
    setError(null);
    setResults([]);
  };

  const showBanner = error || results.length > 0;

  return (
    <div className="trade-panel">
      {schwabLinked === false ? (
        <div className="trade-panel-row">
          <a className="connect-btn" href="/api/auth/schwab/start">
            Connect Schwab
          </a>
        </div>
      ) : (
        <>
          <div className="trade-panel-row">
            {accountsError ? (
              <div className="error-text">{accountsError}</div>
            ) : !accounts ? (
              <div className="muted-text">Loading accounts…</div>
            ) : accounts.length === 0 ? (
              <div className="muted-text">No Schwab accounts found.</div>
            ) : (
              <div className="account-list">
                {accounts.map((a) => {
                  const alloc = allocations[a.accountNumber] ?? { dollars: '', enabled: false };
                  const dollars = Number(alloc.dollars);
                  const pct =
                    a.totalValue > 0 && Number.isFinite(dollars) && dollars > 0
                      ? (dollars / a.totalValue) * 100
                      : 0;
                  const qty =
                    alloc.enabled &&
                    Number.isFinite(dollars) &&
                    dollars > 0 &&
                    lines.entry > 0
                      ? Math.floor(dollars / lines.entry)
                      : 0;
                  const activeCount = activeCounts[a.accountNumber] ?? 0;
                  return (
                    <div className="account-row" key={a.accountNumber}>
                      <label className="account-check">
                        <input
                          type="checkbox"
                          checked={alloc.enabled}
                          onChange={(e) => setAlloc(a.accountNumber, { enabled: e.target.checked })}
                        />
                        <span className="account-name">{fmtAcctMask(a.accountNumber)}</span>
                        {activeCount > 0 && (
                          <button
                            type="button"
                            className="active-badge"
                            title={`${activeCount} active ${ticker} order${activeCount > 1 ? 's' : ''}`}
                            onClick={(e) => {
                              e.preventDefault();
                              showActiveOrdersFor(a);
                            }}
                          >
                            {activeCount}
                          </button>
                        )}
                      </label>
                      <div className="account-balance">
                        <span>{fmtMoney(a.availableFunds)}</span>
                        <span className="muted-text">{fmtMoney(a.totalValue)}</span>
                      </div>
                      <div className="account-meta">
                        <span className="muted-text">{pct > 0 ? `${pct.toFixed(1)}%` : '—'}</span>
                        <span className="muted-text">{qty > 0 ? `${qty} sh` : ''}</span>
                      </div>
                      <div className="account-amount">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={50}
                          placeholder="$"
                          value={alloc.dollars}
                          onChange={(e) => setAlloc(a.accountNumber, { dollars: e.target.value })}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="trade-panel-row">
            <SwipeButton
              label={
                ordersToSubmit.length === 0
                  ? `Set qty on at least one account`
                  : `Swipe to BUY ${ticker} (${ordersToSubmit.length} acct${
                      ordersToSubmit.length > 1 ? 's' : ''
                    })`
              }
              busy={busy || schwabLinked === null || accounts === null}
              disabled={!canSubmit}
              onConfirm={onSubmit}
            />
          </div>
        </>
      )}

      {showBanner &&
        createPortal(
          <div
            className={`top-banner${error ? ' top-banner-error' : ''}`}
            role={error ? 'alert' : 'status'}
          >
            <div className="top-banner-body">
              {error && <div className="top-banner-line">{error}</div>}
              {results.map((r) => {
                const snap = r.snapshot;
                const filled = snap?.filledQuantity;
                const total =
                  typeof filled === 'number'
                    ? filled + (snap?.remainingQuantity ?? 0)
                    : null;
                const treeDone = snap ? isTreeTerminal(snap) : false;
                const treeAccepted = snap ? isTreeAccepted(snap) : false;
                // Show the green check as soon as Schwab has accepted the order
                // (e.g. PENDING_ACTIVATION, WORKING, FILLED). The spinner only
                // shows when we're still polling AND the order isn't yet in a
                // happy state.
                const showSpinner = r.polling && !treeAccepted && !treeDone && !r.error;
                const showCheck = treeAccepted || treeDone;
                return (
                  <div key={r.accountNumber} className="result-block">
                    <div className="result-header">
                      <strong>{fmtAcctMask(r.accountNumber)}</strong>
                      {showSpinner && <span className="spinner" aria-label="polling" />}
                      {showCheck && <span className="result-done">✓</span>}
                    </div>
                    {r.error ? (
                      <div className="result-line">
                        <span className="st st-bad">ERROR</span> {r.error}
                      </div>
                    ) : snap ? (
                      <>
                        <div className="result-line">
                          <span className="result-label">Parent</span>
                          <span className={statusClass(snap.status)}>{snap.status}</span>
                          {typeof filled === 'number' && total !== null && (
                            <span className="muted-text">
                              {filled}/{total}
                            </span>
                          )}
                          {snap.statusDescription && (
                            <span className="status-detail">{snap.statusDescription}</span>
                          )}
                        </div>
                        {flattenChildren(snap).map((c, i) => (
                          <div key={c.orderId ?? i} className="result-line">
                            <span className="result-label">{childLabel(c, i)}</span>
                            <span className={statusClass(c.status)}>{c.status}</span>
                            {c.statusDescription && (
                              <span className="status-detail">{c.statusDescription}</span>
                            )}
                          </div>
                        ))}
                      </>
                    ) : r.orderId ? (
                      <div className="result-line">
                        <span className="muted-text">submitted ({r.orderId}), waiting…</span>
                      </div>
                    ) : (
                      <div className="result-line">
                        <span className="muted-text">submitting…</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="top-banner-close"
              aria-label="Dismiss"
              onClick={dismissBanner}
            >
              ×
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
