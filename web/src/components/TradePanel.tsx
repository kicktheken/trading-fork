import { useEffect, useRef, useState } from 'react';
import {
  fetchOrder,
  fetchSchwabStatus,
  submitOrder,
  type OrderRequest,
  type SchwabOrderSnapshot,
} from '../api/client';
import type { PriceLines } from './Chart';
import { SwipeButton } from './SwipeButton';

// Schwab order statuses that are "done" — no further updates expected for
// THIS orderId. (REPLACED is terminal for this id; a new id is issued.)
const TERMINAL_STATUSES = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'REPLACED',
]);

// Recursively check whether an order tree is fully settled — parent is terminal
// AND every child is terminal. We keep polling past parent FILL because OCO
// children stay WORKING until one fills/cancels the other.
function isTreeTerminal(o: SchwabOrderSnapshot): boolean {
  if (!TERMINAL_STATUSES.has(o.status)) return false;
  for (const c of o.childOrderStrategies ?? []) {
    if (!isTreeTerminal(c)) return false;
  }
  return true;
}

// Walk the tree and return the first child with a REJECTED state, if any.
function findRejectedChild(o: SchwabOrderSnapshot): SchwabOrderSnapshot | null {
  for (const c of o.childOrderStrategies ?? []) {
    if (c.status === 'REJECTED') return c;
    const deeper = findRejectedChild(c);
    if (deeper) return deeper;
  }
  return null;
}

// Flatten the bracket: parent's children are an OCO group whose children are
// the actual leg orders (LIMIT take-profit + STOP stop-loss).
function flattenChildren(o: SchwabOrderSnapshot): SchwabOrderSnapshot[] {
  const out: SchwabOrderSnapshot[] = [];
  for (const c of o.childOrderStrategies ?? []) {
    if (c.childOrderStrategies && c.childOrderStrategies.length > 0) {
      out.push(...c.childOrderStrategies);
    } else {
      out.push(c);
    }
  }
  return out;
}

function childLabel(_c: SchwabOrderSnapshot, i: number): string {
  // We submit the OCO with [LIMIT (target), STOP (stop-loss)] in that order.
  return i === 0 ? 'Target' : i === 1 ? 'Stop' : `Leg ${i + 1}`;
}

function childLabelFor(child: SchwabOrderSnapshot, root: SchwabOrderSnapshot): string {
  const flat = flattenChildren(root);
  const idx = flat.findIndex((x) => x.orderId === child.orderId);
  return idx >= 0 ? childLabel(child, idx) : 'child order';
}

interface Props {
  ticker: string;
  lines: PriceLines;
}

export function TradePanel({ ticker, lines }: Props) {
  const [broker, setBroker] = useState<OrderRequest['broker']>('schwab');
  const [side, setSide] = useState<OrderRequest['side']>('buy');
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null = unknown / loading; true/false = known link state.
  const [schwabLinked, setSchwabLinked] = useState<boolean | null>(null);
  const [orderSnapshot, setOrderSnapshot] = useState<SchwabOrderSnapshot | null>(null);
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSchwabStatus()
      .then((s) => {
        if (!cancelled) setSchwabLinked(s.linked);
      })
      .catch(() => {
        if (!cancelled) setSchwabLinked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stop any in-flight polling on unmount.
  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    },
    [],
  );

  const startPolling = (orderId: string) => {
    if (broker !== 'schwab') return;
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    let attempt = 0;
    let currentId = orderId;
    let firstFetchSucceeded = false;
    const tick = async () => {
      attempt++;
      try {
        const snap = await fetchOrder('schwab', currentId);
        firstFetchSucceeded = true;
        setOrderSnapshot(snap);

        // If a child rejected (e.g. the OCO bracket failed validation post-fill),
        // surface Schwab's reason prominently — the parent buy may have filled,
        // but the protective stop/target won't be in place.
        const rejected = findRejectedChild(snap);
        if (rejected) {
          const reason = rejected.statusDescription?.trim();
          setError(
            reason
              ? `Schwab rejected ${childLabelFor(rejected, snap)}: ${reason}`
              : `Schwab rejected ${childLabelFor(rejected, snap)}. Review your account.`,
          );
        } else if (snap.status === 'REJECTED' && snap.statusDescription) {
          setError(`Schwab rejected order: ${snap.statusDescription}`);
        }

        // Follow REPLACED orders to the new id.
        if (snap.status === 'REPLACED' && snap.childOrderStrategies?.[0]?.orderId) {
          currentId = snap.childOrderStrategies[0].orderId;
        } else if (isTreeTerminal(snap)) {
          return;
        }
      } catch (e) {
        // First poll commonly 404s while Schwab finishes propagating the order
        // to its read API. Retry transiently for the first few attempts.
        const transient = !firstFetchSucceeded && attempt <= 3;
        if (!transient) {
          setError(`status poll failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
      // Cap polling at ~5 minutes total.
      if (attempt > 60) return;
      const delay = attempt < 15 ? 2000 : 10000;
      pollTimer.current = window.setTimeout(tick, delay);
    };
    // Schwab's POST → GET propagation time isn't published. 300ms is usually
    // enough but occasionally the first poll 404s; we retry up to 3 times.
    pollTimer.current = window.setTimeout(tick, 300);
  };

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setOrderSnapshot(null);
    try {
      const res = await submitOrder({
        broker,
        ticker,
        side,
        quantity,
        entry: lines.entry,
        stop: lines.stop,
        target: lines.target,
      });
      setStatus(`Submitted: ${res.id}`);
      // Schwab order ids are numeric; our worker falls back to "schwab:<ts>"
      // when the Location header is missing — only poll real ids.
      if (broker === 'schwab' && /^\d+$/.test(res.id)) {
        startPolling(res.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-panel">
      <div>
        <label>Broker</label>
        <select value={broker} onChange={(e) => setBroker(e.target.value as OrderRequest['broker'])}>
          <option value="schwab">Schwab</option>
          <option value="ibkr">Interactive Brokers</option>
        </select>
      </div>
      <div>
        <label>Side</label>
        <select value={side} onChange={(e) => setSide(e.target.value as OrderRequest['side'])}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
      </div>
      <div>
        <label>Qty</label>
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
        />
      </div>
      <div>
        <label>Entry / Stop / Target</label>
        <input
          readOnly
          value={`${lines.entry.toFixed(2)} / ${lines.stop.toFixed(2)} / ${lines.target.toFixed(2)}`}
        />
      </div>
      <div className="swipe-wrap">
        {broker === 'schwab' && schwabLinked === false ? (
          <a className="connect-btn" href="/api/auth/schwab/start">
            Connect Schwab
          </a>
        ) : (
          <SwipeButton
            label={`Swipe to ${side.toUpperCase()} ${ticker || ''}`}
            busy={busy || schwabLinked === null}
            disabled={!ticker}
            onConfirm={onSubmit}
          />
        )}
      </div>
      {status && <div className="status">{status}</div>}
      {orderSnapshot && (
        <div className="status">
          <div>
            Parent: <strong>{orderSnapshot.status}</strong>
            {typeof orderSnapshot.filledQuantity === 'number' && (
              <>
                {' '}· filled {orderSnapshot.filledQuantity}/
                {orderSnapshot.filledQuantity + (orderSnapshot.remainingQuantity ?? 0)}
              </>
            )}
            {orderSnapshot.statusDescription && (
              <div className="status-detail">{orderSnapshot.statusDescription}</div>
            )}
          </div>
          {flattenChildren(orderSnapshot).map((c, i) => (
            <div key={c.orderId ?? i}>
              {childLabel(c, i)}: <strong>{c.status}</strong>
              {c.statusDescription && <div className="status-detail">{c.statusDescription}</div>}
            </div>
          ))}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
