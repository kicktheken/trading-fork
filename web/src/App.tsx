import { useEffect, useMemo, useState } from 'react';
import { Chart, type PriceLines } from './components/Chart';
import { TradePanel, type SchwabContext, type ViewMode } from './components/TradePanel';
import {
  fetchBars,
  fetchQuote,
  replaceChildOrderPrice,
  replaceParentEntry,
  submitOrder,
  type Bar,
  type ExistingOrderLevels,
  type SchwabOrderSnapshot,
} from './api/client';
import { confirm } from './components/ConfirmDialog';
import { ema, pctChangeOverLookback } from './lib/ema';
import { aggregate, type Timeframe } from './lib/aggregate';

const EMA_LOOKBACK = 20;

const TICKER_STORAGE_KEY = 'trading-fork:ticker';

function loadStoredTicker(): string {
  try {
    const v = localStorage.getItem(TICKER_STORAGE_KEY);
    if (v && /^[A-Z.\-]{1,10}$/.test(v)) return v;
  } catch {
    // localStorage may be unavailable (privacy mode, etc.)
  }
  return 'QQQ';
}

function fmtAgo(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function App() {
  const initialTicker = loadStoredTicker();
  const [tickerInput, setTickerInput] = useState(initialTicker);
  const [ticker, setTicker] = useState(initialTicker);
  const [bars, setBars] = useState<Bar[]>([]);
  const [bidAsk, setBidAsk] = useState<{
    bid: number;
    ask: number;
    timestamp: number;
  } | null>(null);
  // Coarse "now" used to render the "Ns ago" label. Ticks once a second so
  // the label re-renders without thrashing the rest of the tree.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const [timeframe, setTimeframe] = useState<Timeframe>('daily');
  const [lines, setLines] = useState<PriceLines>({ entry: 0, stop: 0, target: 0 });
  const [existingLevels, setExistingLevels] = useState<ExistingOrderLevels>({
    entries: [],
    stops: [],
    targets: [],
  });
  const [schwabCtx, setSchwabCtx] = useState<SchwabContext>({
    accounts: [],
    ordersByAccount: {},
  });
  // Bump to force TradePanel to re-fetch active orders (e.g. after we mutate
  // orders via PUT/POST in update mode).
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0);
  const [mode, setMode] = useState<ViewMode>('buy');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Aggregate the position the user has of the current ticker across linked
  // Schwab accounts. Drives the topbar gain readout and the U mode gating.
  const tickerPosition = useMemo(() => {
    let totalQty = 0;
    let totalCost = 0;
    let marketValue = 0;
    for (const a of schwabCtx.accounts) {
      for (const p of a.positions) {
        if (p.symbol !== ticker) continue;
        const net = (p.longQuantity ?? 0) - (p.shortQuantity ?? 0);
        if (net === 0) continue;
        totalQty += net;
        totalCost += net * (p.averagePrice ?? 0);
        marketValue += p.marketValue ?? 0;
      }
    }
    if (totalQty === 0) return null;
    const livePx = bars.length > 0 ? bars[bars.length - 1]!.close : null;
    // Use marketValue as Schwab reports it; fall back to live px * qty.
    const mv = marketValue !== 0 ? marketValue : livePx != null ? livePx * totalQty : 0;
    const dollarGain = mv - totalCost;
    const pctGain = totalCost > 0 ? (dollarGain / totalCost) * 100 : 0;
    return { qty: totalQty, cost: totalCost, marketValue: mv, dollarGain, pctGain };
  }, [schwabCtx.accounts, ticker, bars]);

  // Auto-leave update mode if the underlying position disappears.
  useEffect(() => {
    if (mode === 'update' && !tickerPosition) {
      setMode('buy');
    }
  }, [mode, tickerPosition]);

  // Average of existing TP / SL / entry across all accounts. In update mode the
  // chart's draggable lines snap to these. Fallback to 0 when none exist —
  // those lines are then hidden client-side in the chart (we filter out 0s).
  const avgLevels = useMemo(() => {
    const avg = (arr: number[]) =>
      arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
    return {
      entry: avg(existingLevels.entries),
      stop: avg(existingLevels.stops),
      target: avg(existingLevels.targets),
    };
  }, [existingLevels]);

  // In update mode, lines reflect averages and any drag triggers a confirm flow.
  // We track a "live" copy that the chart can drag freely, then snap back if the
  // user cancels the modal. The handler wraps the diff and resolves it server-side.
  const [updateLines, setUpdateLines] = useState<PriceLines>(avgLevels);
  useEffect(() => {
    setUpdateLines(avgLevels);
  }, [avgLevels.entry, avgLevels.stop, avgLevels.target]);

  // Walk the order trees for the current ticker, returning a flat list of
  // {accountHash, orderId, role: 'entry'|'target'|'stop'} for active leaves.
  // Replaced/cancelled/filled legs are skipped.
  const findActiveLegs = (
    role: 'entry' | 'target' | 'stop',
  ): Array<{ accountHash: string; accountNumber: string; orderId: string; price: number }> => {
    const out: Array<{ accountHash: string; accountNumber: string; orderId: string; price: number }> =
      [];
    const isLive = (s: string) =>
      s !== 'CANCELED' && s !== 'REJECTED' && s !== 'EXPIRED' && s !== 'REPLACED' && s !== 'FILLED';
    for (const a of schwabCtx.accounts) {
      const trees = schwabCtx.ordersByAccount[a.accountNumber] ?? [];
      for (const t of trees) {
        if (role === 'entry') {
          if (t.orderStrategyType === 'TRIGGER' && isLive(t.status)) {
            const px = t.orderType === 'LIMIT' ? t.price : t.stopPrice;
            if (typeof px === 'number') {
              out.push({
                accountHash: a.hashValue,
                accountNumber: a.accountNumber,
                orderId: String(t.orderId),
                price: px,
              });
            }
          }
        } else {
          // Walk the tree for OCO children matching the role.
          const visit = (n: SchwabOrderSnapshot) => {
            if (n.orderStrategyType === 'OCO') {
              for (const c of n.childOrderStrategies ?? []) {
                if (!isLive(c.status)) continue;
                if (role === 'target' && c.orderType === 'LIMIT' && typeof c.price === 'number') {
                  out.push({
                    accountHash: a.hashValue,
                    accountNumber: a.accountNumber,
                    orderId: String(c.orderId),
                    price: c.price,
                  });
                }
                if (
                  role === 'stop' &&
                  (c.orderType === 'STOP' ||
                    c.orderType === 'STOP_LIMIT' ||
                    c.orderType === 'TRAILING_STOP') &&
                  typeof c.stopPrice === 'number'
                ) {
                  out.push({
                    accountHash: a.hashValue,
                    accountNumber: a.accountNumber,
                    orderId: String(c.orderId),
                    price: c.stopPrice,
                  });
                }
              }
            }
            for (const c of n.childOrderStrategies ?? []) visit(c);
          };
          for (const t of trees) visit(t);
        }
      }
    }
    return out;
  };

  // Account numbers that hold a position in the current ticker but have NO
  // active orders. TP/SL drags on these accounts should offer to create a new
  // OCO bracket; entry drags do nothing (no entry line shown for these).
  const positionsWithoutOrders = useMemo(() => {
    return schwabCtx.accounts.filter((a) => {
      const hasPosition = a.positions.some(
        (p) => p.symbol === ticker && (p.longQuantity ?? 0) - (p.shortQuantity ?? 0) > 0,
      );
      const hasOrders = (schwabCtx.ordersByAccount[a.accountNumber] ?? []).length > 0;
      return hasPosition && !hasOrders;
    });
  }, [schwabCtx, ticker]);

  // In update mode, hide the entry line if there are no active entry orders.
  const updateLinesMasked = useMemo<PriceLines>(() => {
    if (mode !== 'update') return updateLines;
    return {
      entry: existingLevels.entries.length > 0 ? updateLines.entry : 0,
      stop: updateLines.stop,
      target: updateLines.target,
    };
  }, [mode, updateLines, existingLevels.entries.length]);

  const onUpdateModeDrag = async (next: PriceLines) => {
    // Identify which line moved by comparing the released value against the
    // PRE-drag average. We can't compare against `updateLines` because the
    // intermediate setUpdateLines() calls during the drag have already moved
    // it to the final position by the time onPressedMoveEnd fires.
    const round = (n: number) => Number(n.toFixed(2));
    let role: 'entry' | 'target' | 'stop' | null = null;
    let newPrice = 0;
    const eps = 0.005;
    if (Math.abs(next.entry - avgLevels.entry) > eps && existingLevels.entries.length > 0) {
      role = 'entry';
      newPrice = round(next.entry);
    } else if (Math.abs(next.target - avgLevels.target) > eps) {
      role = 'target';
      newPrice = round(next.target);
    } else if (Math.abs(next.stop - avgLevels.stop) > eps) {
      role = 'stop';
      newPrice = round(next.stop);
    }
    if (!role || newPrice <= 0) {
      // No meaningful change — reset to averages.
      setUpdateLines(avgLevels);
      return;
    }

    const livePx = bars.length > 0 ? bars[bars.length - 1]!.close : null;
    const legs = findActiveLegs(role);

    // For TP/SL: also offer to create new OCO brackets on accounts with positions
    // but no orders.
    const newBrackets = role !== 'entry' ? positionsWithoutOrders : [];

    if (legs.length === 0 && newBrackets.length === 0) {
      // Nothing to do — snap back.
      setUpdateLines(avgLevels);
      return;
    }

    // Build modal body.
    const label = role === 'entry' ? 'entry' : role === 'target' ? 'take-profit' : 'stop-loss';
    const switchCallout =
      role === 'entry' && livePx != null
        ? legs
            .map((l) => {
              const wasStop = l.price > livePx; // existing was BUY STOP if entry > current
              const willBeStop = newPrice > livePx;
              return wasStop !== willBeStop
                ? `${l.accountNumber.slice(-4)}: ${wasStop ? 'STOP→LIMIT' : 'LIMIT→STOP'}`
                : null;
            })
            .filter(Boolean)
        : [];

    const body = (
      <div>
        <div>
          Update {legs.length} {label} order{legs.length === 1 ? '' : 's'} to{' '}
          <strong>${newPrice.toFixed(2)}</strong>?
        </div>
        {legs.length > 0 && (
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {legs.map((l) => (
              <li key={l.orderId}>
                ••••{l.accountNumber.slice(-4)}: ${l.price.toFixed(2)} → ${newPrice.toFixed(2)}
              </li>
            ))}
          </ul>
        )}
        {switchCallout.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <strong>Order type will switch:</strong>{' '}
            {switchCallout.join(', ')}
          </div>
        )}
        {newBrackets.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <strong>
              {newBrackets.length} account{newBrackets.length === 1 ? '' : 's'} with positions but
              no orders
            </strong>{' '}
            will get a new OCO bracket (TP ${updateLines.target.toFixed(2)} / SL $
            {updateLines.stop.toFixed(2)}).
          </div>
        )}
      </div>
    );

    const ok = await confirm({
      title: `Update ${label}`,
      body,
      confirmLabel: 'Update',
    });
    if (!ok) {
      // User canceled — snap line back to the average.
      setUpdateLines(avgLevels);
      return;
    }

    // Fire PUT/POSTs in parallel.
    const results: Array<{ ok: boolean; account: string; error?: string }> = [];
    await Promise.all([
      ...legs.map(async (l) => {
        try {
          if (role === 'entry') {
            await replaceParentEntry(l.orderId, l.accountHash, newPrice, livePx ?? undefined);
          } else {
            await replaceChildOrderPrice(l.orderId, l.accountHash, newPrice);
          }
          results.push({ ok: true, account: l.accountNumber });
        } catch (e) {
          results.push({
            ok: false,
            account: l.accountNumber,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
      ...newBrackets.map(async (a) => {
        try {
          // For new bracket creation: use the user's current updateLines for entry
          // (or fall back to live price if entry isn't set).
          const entryPx = role === 'target' ? livePx ?? updateLines.entry : updateLines.entry;
          if (!entryPx || entryPx <= 0) {
            throw new Error('cannot create bracket: entry price unavailable');
          }
          // Determine quantity from this account's position.
          const pos = a.positions.find((p) => p.symbol === ticker);
          const qty = pos
            ? Math.max(0, (pos.longQuantity ?? 0) - (pos.shortQuantity ?? 0))
            : 0;
          if (qty < 1) throw new Error('no shares held to bracket');
          await submitOrder({
            broker: 'schwab',
            ticker,
            side: 'buy',
            quantity: qty,
            entry: entryPx,
            stop: role === 'stop' ? newPrice : updateLines.stop,
            target: role === 'target' ? newPrice : updateLines.target,
            accountHash: a.hashValue,
            currentPrice: livePx ?? undefined,
          });
          results.push({ ok: true, account: a.accountNumber });
        } catch (e) {
          results.push({
            ok: false,
            account: a.accountNumber,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    ]);
    // Surface a quick alert if anything failed; otherwise the next refresh
    // will pick up the new prices.
    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      await confirm({
        title: 'Some updates failed',
        body: (
          <div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {failures.map((f, i) => (
                <li key={i}>
                  ••••{f.account.slice(-4)}: {f.error}
                </li>
              ))}
            </ul>
          </div>
        ),
        confirmLabel: 'OK',
        cancelLabel: 'Dismiss',
      });
    }
    // Trigger a re-fetch of active orders so existingLevels picks up the new
    // broker-side prices; avgLevels then re-derives via its useEffect and we
    // sync updateLines to that.
    setOrdersRefreshKey((k) => k + 1);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchBars(ticker, timeframe)
      .then((data) => {
        if (cancelled) return;
        setBars(data);
        const last = data[data.length - 1];
        if (last) {
          const px = last.close;
          setLines({
            entry: Number(px.toFixed(2)),
            stop: Number((px * 0.97).toFixed(2)),
            target: Number((px * 1.05).toFixed(2)),
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, timeframe]);

  const load = () => {
    const next = tickerInput.trim().toUpperCase();
    if (next) {
      setTicker(next);
      try {
        localStorage.setItem(TICKER_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
  };

  // Live price polling: every 500ms, fetch the latest trade + NBBO and update
  // the most recent bar's close (extending high/low if the live price breaks
  // them) plus the bid/ask readout in the topbar.
  useEffect(() => {
    if (!ticker) return;
    setBidAsk(null);
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const q = await fetchQuote(ticker);
        if (cancelled) return;
        if (typeof q.bid === 'number' && typeof q.ask === 'number' && q.bid > 0 && q.ask > 0) {
          setBidAsk({ bid: q.bid, ask: q.ask, timestamp: q.timestamp });
        }
        setBars((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1]!;
          if (last.close === q.price && last.high >= q.price && last.low <= q.price) {
            return prev;
          }
          const updated: Bar = {
            ...last,
            close: q.price,
            high: Math.max(last.high, q.price),
            low: Math.min(last.low, q.price),
          };
          return [...prev.slice(0, -1), updated];
        });
      } catch {
        // ignore transient errors; next tick will retry
      }
      if (!cancelled) timer = window.setTimeout(tick, 500);
    };
    timer = window.setTimeout(tick, 500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ticker]);

  // Browser tab title reflects live ticker + bid×ask. Updates as the poll
  // refreshes bidAsk; falls back to last close when bid/ask are zero (off-hours
  // for thin names). Resets to the default app name when no ticker is set.
  useEffect(() => {
    if (!ticker) {
      document.title = 'trading-fork';
      return;
    }
    if (bidAsk && bidAsk.bid > 0 && bidAsk.ask > 0) {
      document.title = `${ticker} ${bidAsk.bid.toFixed(2)}×${bidAsk.ask.toFixed(2)}`;
    } else if (bars.length > 0) {
      document.title = `${ticker} ${bars[bars.length - 1]!.close.toFixed(2)}`;
    } else {
      document.title = ticker;
    }
  }, [ticker, bidAsk, bars]);

  const displayBars = useMemo(() => aggregate(bars, timeframe), [bars, timeframe]);

  const emaStats = useMemo(() => {
    const ema10 = ema(displayBars, 10);
    const ema20 = ema(displayBars, 20);
    return {
      ema10: pctChangeOverLookback(ema10, EMA_LOOKBACK),
      ema20: pctChangeOverLookback(ema20, EMA_LOOKBACK),
    };
  }, [displayBars]);

  const fmtPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  const pctClass = (v: number | null) =>
    v == null ? 'ema-pct' : v >= 0 ? 'ema-pct ema-pct-up' : 'ema-pct ema-pct-down';

  return (
    <div className="app">
      <div className="ema-bar" title={`% change of the EMA over the last ${EMA_LOOKBACK} bars`}>
        <span className="ema-label">EMA10 {EMA_LOOKBACK}b</span>
        <span className={pctClass(emaStats.ema10)}>{fmtPct(emaStats.ema10)}</span>
        <span className="ema-label">EMA20 {EMA_LOOKBACK}b</span>
        <span className={pctClass(emaStats.ema20)}>{fmtPct(emaStats.ema20)}</span>
        {bidAsk && (
          <div
            className="bid-ask"
            title={`Spread: $${(bidAsk.ask - bidAsk.bid).toFixed(2)} · quote at ${new Date(bidAsk.timestamp).toLocaleTimeString()}`}
          >
            <span className="bid-ask-bid">{bidAsk.bid.toFixed(2)}</span>
            <span className="bid-ask-sep">×</span>
            <span className="bid-ask-ask">{bidAsk.ask.toFixed(2)}</span>
            <span className="bid-ask-age">
              {fmtAgo(Math.max(0, Math.round((nowMs - bidAsk.timestamp) / 1000)))}
            </span>
          </div>
        )}
      </div>
      <div className="chart-wrap">
        <Chart
          bars={displayBars}
          lines={mode === 'update' ? updateLinesMasked : lines}
          onLinesChange={mode === 'update' ? setUpdateLines : setLines}
          onLinesCommit={mode === 'update' ? onUpdateModeDrag : undefined}
          existingLevels={mode === 'update' ? { entries: [], stops: [], targets: [] } : existingLevels}
        />
      </div>
      <div className="topbar">
        <input
          value={tickerInput}
          onChange={(e) => setTickerInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={load}
          placeholder="TICKER"
          autoCapitalize="characters"
          autoCorrect="off"
        />
        {tickerPosition && (
          <div
            className={`pos-gain ${tickerPosition.dollarGain >= 0 ? 'pos-gain-up' : 'pos-gain-down'}`}
            title={`${tickerPosition.qty} sh @ avg ${(tickerPosition.cost / tickerPosition.qty).toFixed(2)}`}
          >
            <span className="pos-gain-dollar">
              {tickerPosition.dollarGain >= 0 ? '+' : ''}
              ${Math.abs(tickerPosition.dollarGain).toFixed(2)}
            </span>
            <span className="pos-gain-pct">
              {tickerPosition.pctGain >= 0 ? '+' : ''}
              {tickerPosition.pctGain.toFixed(2)}%
            </span>
          </div>
        )}
        <div className="tf-toggle" role="group" aria-label="Timeframe">
          <button
            className={timeframe === 'daily' ? 'tf-btn active' : 'tf-btn'}
            onClick={() => setTimeframe('daily')}
          >
            D
          </button>
          <button
            className={timeframe === 'weekly' ? 'tf-btn active' : 'tf-btn'}
            onClick={() => setTimeframe('weekly')}
          >
            W
          </button>
        </div>
        <button
          className={`mode-btn${mode === 'update' ? ' active' : ''}`}
          disabled={!tickerPosition}
          onClick={() => setMode((m) => (m === 'update' ? 'buy' : 'update'))}
          title={
            tickerPosition
              ? mode === 'update'
                ? 'Switch to Buy mode'
                : 'Switch to Update mode'
              : `No position in ${ticker}`
          }
        >
          U
        </button>
      </div>
      <TradePanel
        ticker={ticker}
        lines={lines}
        currentPrice={bars.length > 0 ? bars[bars.length - 1]!.close : null}
        mode={mode}
        refreshKey={ordersRefreshKey}
        onExistingLevelsChange={setExistingLevels}
        onSchwabContextChange={setSchwabCtx}
      />
      {err && <div className="error" style={{ padding: 8 }}>{err}</div>}
    </div>
  );
}
