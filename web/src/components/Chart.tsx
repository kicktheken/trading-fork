import { useEffect, useRef } from 'react';
import {
  init,
  dispose,
  registerOverlay,
  PolygonType,
  type Chart as KChart,
  type KLineData,
  type OverlayFigure,
} from 'klinecharts';
import type { Bar } from '../api/client';

export interface PriceLines {
  entry: number;
  stop: number;
  target: number;
}

interface Props {
  bars: Bar[];
  lines: PriceLines;
  onLinesChange: (lines: PriceLines) => void;
}

const LINE_SPEC: Array<{ key: keyof PriceLines; color: string; zLevel: number }> = [
  // Render order matters when tags overlap: stop (lowest), entry, target (highest).
  { key: 'stop', color: '#f85149', zLevel: 100 },
  { key: 'entry', color: '#58a6ff', zLevel: 110 },
  { key: 'target', color: '#3fb950', zLevel: 120 },
];

// Vertical hit-area (px) around the line for pointer interaction.
const HIT_HEIGHT = 36;
// Price-tag dimensions, drawn inside the chart pane on the right edge so they
// don't sit on top of KlineCharts' built-in last-price label on the Y-axis.
const TAG_WIDTH = 64;
const TAG_HEIGHT = 30;
const TAG_RIGHT_INSET = 6;

let overlayRegistered = false;
function ensureOverlayRegistered() {
  if (overlayRegistered) return;
  overlayRegistered = true;

  registerOverlay({
    name: 'fatPriceLine',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay, precision, thousandsSeparator }) => {
      const pt = coordinates[0];
      if (!pt) return [];
      const y = pt.y;
      const ext = overlay.extendData as
        | {
            color?: string;
            kind?: 'entry' | 'stop' | 'target';
            lastClose?: number;
            entryPrice?: number;
          }
        | undefined;
      const color = ext?.color ?? '#58a6ff';
      const kind = ext?.kind;
      const value = overlay.points[0]?.value;
      const priceText =
        typeof value === 'number'
          ? formatPrice(value, precision.price, thousandsSeparator)
          : '';
      // Entry shows % from current price; stop/target show % from entry.
      let pctText = '';
      if (typeof value === 'number') {
        if (kind === 'entry' && typeof ext?.lastClose === 'number' && ext.lastClose > 0) {
          pctText = formatPct((value - ext.lastClose) / ext.lastClose);
        } else if (
          (kind === 'stop' || kind === 'target') &&
          typeof ext?.entryPrice === 'number' &&
          ext.entryPrice > 0
        ) {
          pctText = formatPct((value - ext.entryPrice) / ext.entryPrice);
        }
      }
      const tagX = bounding.width - TAG_WIDTH - TAG_RIGHT_INSET;
      const tagY = y - TAG_HEIGHT / 2;
      const centerX = tagX + TAG_WIDTH / 2;
      // Two text lines stacked vertically inside the tag.
      const priceY = tagY + TAG_HEIGHT * 0.3;
      const pctY = tagY + TAG_HEIGHT * 0.72;
      const figures: OverlayFigure[] = [
        // Fat invisible hit rect spanning full width.
        {
          key: 'hit',
          type: 'rect',
          attrs: {
            x: 0,
            y: y - HIT_HEIGHT / 2,
            width: bounding.width,
            height: HIT_HEIGHT,
          },
          styles: {
            style: 'fill',
            color: 'rgba(0,0,0,0)',
            borderColor: 'rgba(0,0,0,0)',
          },
        },
        // Visible solid line — stops just before the tag so it doesn't underline it.
        {
          key: 'line',
          type: 'line',
          attrs: {
            coordinates: [
              { x: 0, y },
              { x: tagX - 4, y },
            ],
          },
          styles: {
            style: 'solid',
            color,
            size: 1.5,
          },
          ignoreEvent: true,
        },
        // Draggable price tag pinned to the right edge of the chart pane.
        {
          key: 'tag',
          type: 'rect',
          attrs: { x: tagX, y: tagY, width: TAG_WIDTH, height: TAG_HEIGHT },
          styles: { style: PolygonType.Fill, color, borderColor: color },
        },
        {
          key: 'tagPriceText',
          type: 'text',
          attrs: {
            x: centerX,
            y: priceY,
            text: priceText,
            align: 'center',
            baseline: 'middle',
          },
          styles: {
            color: '#ffffff',
            size: 11,
            family: '-apple-system, system-ui, sans-serif',
            weight: '600',
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
          },
          ignoreEvent: true,
        },
        {
          key: 'tagPctText',
          type: 'text',
          attrs: {
            x: centerX,
            y: pctY,
            text: pctText,
            align: 'center',
            baseline: 'middle',
          },
          styles: {
            color: '#ffffff',
            size: 10,
            family: '-apple-system, system-ui, sans-serif',
            weight: '500',
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
          },
          ignoreEvent: true,
        },
      ];
      return figures;
    },
    createYAxisFigures: () => [],
  });
}

function formatPrice(v: number, precision: number, thousandsSeparator: string): string {
  const fixed = v.toFixed(precision);
  const [int, dec] = fixed.split('.');
  const withSep = int!.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);
  return dec ? `${withSep}.${dec}` : withSep;
}

function formatPct(ratio: number): string {
  const pct = ratio * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

// Convert a #rrggbb color into rgba(r, g, b, alpha). Returns the input unchanged
// if it's not a recognized 6-digit hex.
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Debug HUD — only active when ?dragdebug=1 is in the URL.
const DRAG_DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('dragdebug') === '1';
let debugEl: HTMLDivElement | null = null;
let debugLines: string[] = [];
function ensureDebugEl() {
  if (!DRAG_DEBUG) return null;
  if (debugEl) return debugEl;
  debugEl = document.createElement('div');
  debugEl.style.cssText =
    'position:fixed;left:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.8);color:#0f0;font:10px monospace;padding:6px;max-width:100vw;max-height:40vh;overflow:auto;white-space:pre-wrap;pointer-events:none;';
  document.body.appendChild(debugEl);
  return debugEl;
}
function debugMisc(line: string) {
  if (!DRAG_DEBUG) return;
  debugLines.push(line);
  if (debugLines.length > 12) debugLines = debugLines.slice(-12);
  const el = ensureDebugEl();
  if (el) el.textContent = debugLines.join('\n');
}
function debugLog(kind: string, e: TouchEvent) {
  if (!DRAG_DEBUG) return;
  const t = e.touches[0] ?? e.changedTouches[0];
  if (!t) return;
  const target = e.target as HTMLElement | null;
  const targetRect = target?.getBoundingClientRect();
  // Find the chart container to compute relative-to-chart coords.
  const chartEl = (e.currentTarget as HTMLElement) ?? null;
  const chartRect = chartEl?.getBoundingClientRect();
  const relX = chartRect ? Math.round(t.clientX - chartRect.left) : 0;
  const relY = chartRect ? Math.round(t.clientY - chartRect.top) : 0;
  const chartW = chartRect ? Math.round(chartRect.width) : 0;
  const fromRight = chartW - relX;
  // Heuristic: KlineCharts Y-axis is roughly the rightmost ~50px.
  const onYAxis = fromRight <= 60;
  const line = `${kind} touches=${e.touches.length} rel=${relX},${relY} fromRight=${fromRight} ${onYAxis ? 'Y-AXIS' : 'CANDLE'} target=${target?.tagName}.${(target?.className?.toString() ?? '').slice(0, 30)}`;
  debugLines.push(line);
  if (debugLines.length > 12) debugLines = debugLines.slice(-12);
  const el = ensureDebugEl();
  if (el) el.textContent = debugLines.join('\n');
  void targetRect;
}

export function Chart({ bars, lines, onLinesChange }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<KChart | null>(null);
  const overlayIds = useRef<Record<keyof PriceLines, string | null>>({
    entry: null,
    stop: null,
    target: null,
  });
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const onChangeRef = useRef(onLinesChange);
  onChangeRef.current = onLinesChange;

  useEffect(() => {
    ensureOverlayRegistered();
    if (!elRef.current) return;
    const chart = init(elRef.current, {
      styles: {
        grid: { show: true },
        candle: {
          bar: {
            upColor: '#3fb950',
            downColor: '#f85149',
            upBorderColor: '#3fb950',
            downBorderColor: '#f85149',
            upWickColor: '#3fb950',
            downWickColor: '#f85149',
          },
        },
        indicator: {
          bars: [
            {
              style: PolygonType.Fill,
              upColor: '#3fb950',
              downColor: '#f85149',
              noChangeColor: '#8b97a4',
            },
          ],
        },
      },
    });
    chartRef.current = chart ?? null;
    chart?.createIndicator(
      { name: 'EMA', calcParams: [10, 20] },
      true,
      { id: 'candle_pane' },
    );
    chart?.createIndicator('VOL', false, { height: 80 });
    // Explicitly enable Y-axis scroll/zoom on both panes after they exist.
    chart?.setPaneOptions({ id: 'candle_pane', axisOptions: { scrollZoomEnabled: true } });

    // KlineCharts sizes its internal canvases to the container size at init time
    // and doesn't re-measure on its own. Watch for any container resize (e.g.
    // the trade panel growing once accounts load) and tell the chart to resize.
    const resizeObserver = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    resizeObserver.observe(elRef.current);

    // iOS Safari fires WebKit-specific gesture* events for 2-finger gestures,
    // which trigger native page zoom unless we preventDefault. We only block
    // when 2+ touches are active so single-finger drags still reach KlineCharts.
    const el = elRef.current;
    let activeTouches = 0;

    // KlineCharts 9.8.12 lacks Y-axis touch panning. We implement it directly by
    // computing the price range on touchstart and adjusting the Y-axis range as
    // the touch moves. Reaches into chart internals to call setRange on the
    // pane's axis component.
    const isYAxisTouch = (touch: Touch): boolean => {
      const rect = el.getBoundingClientRect();
      return rect.right - touch.clientX <= 56;
    };

    // Reach into the chart's panes via the chart instance.
    type PrivChart = {
      _drawPanes?: Array<{
        getId(): string;
        getBounding?(): { width: number; height: number; left: number; top: number };
        getAxisComponent(): {
          getRange(): { from: number; to: number; range: number; realFrom: number; realTo: number; realRange: number };
          setRange(r: { from: number; to: number; range: number; realFrom: number; realTo: number; realRange: number }): void;
          convertToRealValue(v: number): number;
          setAutoCalcTickFlag(b: boolean): void;
        };
      }>;
      adjustPaneViewport?: (a: boolean, b: boolean, c: boolean, d: boolean) => void;
    };
    const getCandlePane = () => {
      const c = chartRef.current as unknown as PrivChart | null;
      if (!c?._drawPanes) return null;
      return c._drawPanes.find((p) => p.getId() === 'candle_pane') ?? null;
    };
    const getCandlePaneAxis = () => getCandlePane()?.getAxisComponent() ?? null;
    const getCandlePaneHeight = () => {
      const p = getCandlePane();
      const b = p?.getBounding?.();
      return b?.height ?? 0;
    };

    type DragMode = 'none' | 'yAxisScale' | 'panePan';
    let dragMode: DragMode = 'none';
    let dragStartY = 0;
    let dragStartRange: ReturnType<NonNullable<ReturnType<typeof getCandlePaneAxis>>['getRange']> | null =
      null;
    let dragPaneHeight = 0;

    // Don't start a Y-axis pan if the touch landed on one of our price-line
    // overlays — those need to handle drag themselves.
    const isOnPriceLine = (t: Touch): boolean => {
      const rect = el.getBoundingClientRect();
      const localY = t.clientY - rect.top;
      // We have entry/stop/target lines drawn at their respective prices.
      // Hit tolerance matches HIT_HEIGHT (36px around each line).
      const axis = getCandlePaneAxis();
      const pane = getCandlePane();
      const b = pane?.getBounding?.();
      if (!axis || !b) return false;
      const range = axis.getRange();
      // y to price: pixel = (top..top+height) maps to (to..from) for a normal axis
      const ratio = (localY - b.top) / b.height;
      const price = range.to - ratio * range.range;
      const tol = (36 / b.height) * range.range;
      const lns = linesRef.current;
      return (
        Math.abs(price - lns.entry) < tol ||
        Math.abs(price - lns.stop) < tol ||
        Math.abs(price - lns.target) < tol
      );
    };

    const onTouchStart = (e: TouchEvent) => {
      activeTouches = e.touches.length;
      debugLog('touchstart', e);
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t) return;

      const axis = getCandlePaneAxis();
      if (!axis) {
        debugMisc('axis: not found');
        return;
      }

      if (isYAxisTouch(t)) {
        dragMode = 'yAxisScale';
        dragStartY = t.clientY;
        dragStartRange = { ...axis.getRange() };
        axis.setAutoCalcTickFlag(false);
        debugMisc('drag: y-axis scale');
      } else if (!isOnPriceLine(t)) {
        // Touch in candle area, not on a price line: enable vertical pan
        // alongside KlineCharts' built-in horizontal time-scroll.
        dragMode = 'panePan';
        dragStartY = t.clientY;
        dragStartRange = { ...axis.getRange() };
        dragPaneHeight = getCandlePaneHeight();
        axis.setAutoCalcTickFlag(false);
        debugMisc(`drag: pane pan h=${dragPaneHeight}`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      debugLog('touchmove', e);
      const t = e.touches[0];
      if (!t || dragMode === 'none' || !dragStartRange) return;
      const axis = getCandlePaneAxis();
      const c = chartRef.current as unknown as PrivChart | null;
      if (!axis || !c) return;
      const { from, to, range } = dragStartRange;

      if (dragMode === 'yAxisScale') {
        const scale = t.clientY / dragStartY;
        if (!Number.isFinite(scale) || scale <= 0) return;
        const newRange = range * scale;
        const difRange = (newRange - range) / 2;
        const newFrom = from - difRange;
        const newTo = to + difRange;
        axis.setRange({
          from: newFrom,
          to: newTo,
          range: newRange,
          realFrom: axis.convertToRealValue(newFrom),
          realTo: axis.convertToRealValue(newTo),
          realRange: axis.convertToRealValue(newTo) - axis.convertToRealValue(newFrom),
        });
        c.adjustPaneViewport?.(false, true, true, true);
      } else if (dragMode === 'panePan') {
        if (dragPaneHeight <= 0) return;
        // Drag down → bring lower prices into view (shift range down).
        // dy positive = finger moved down = visible range should also move down.
        const dy = t.clientY - dragStartY;
        const shift = (dy / dragPaneHeight) * range;
        const newFrom = from + shift;
        const newTo = to + shift;
        axis.setRange({
          from: newFrom,
          to: newTo,
          range: range,
          realFrom: axis.convertToRealValue(newFrom),
          realTo: axis.convertToRealValue(newTo),
          realRange: axis.convertToRealValue(newTo) - axis.convertToRealValue(newFrom),
        });
        c.adjustPaneViewport?.(false, true, true, true);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      activeTouches = e.touches.length;
      debugLog('touchend', e);
      if (dragMode !== 'none') {
        dragMode = 'none';
        dragStartRange = null;
        debugMisc('drag end');
      }
    };
    const onGesture = (e: Event) => {
      if (activeTouches >= 2) e.preventDefault();
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('gesturestart', onGesture);
    el.addEventListener('gesturechange', onGesture);
    el.addEventListener('gestureend', onGesture);

    return () => {
      resizeObserver.disconnect();
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('gesturestart', onGesture);
      el.removeEventListener('gesturechange', onGesture);
      el.removeEventListener('gestureend', onGesture);
      if (elRef.current) dispose(elRef.current);
      chartRef.current = null;
      overlayIds.current = { entry: null, stop: null, target: null };
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars.length === 0) return;
    const data: KLineData[] = bars.map((b) => ({
      timestamp: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    // Reset Y-axis to auto-fit. Our pan/scale handlers disable auto-tick calc
    // so the axis stays put during drag; we re-enable it here so a fresh dataset
    // (new ticker / timeframe) gets a properly zoomed view.
    type PrivPane = {
      getId(): string;
      getAxisComponent(): { setAutoCalcTickFlag(b: boolean): void };
    };
    const privChart = chart as unknown as { _drawPanes?: PrivPane[] };
    privChart._drawPanes?.forEach((p) => p.getAxisComponent().setAutoCalcTickFlag(true));
    chart.applyNewData(data);
  }, [bars]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars.length === 0) return;

    const lastClose = bars[bars.length - 1]?.close;
    const entryPrice = lines.entry;

    for (const { key, color, zLevel } of LINE_SPEC) {
      const price = lines[key];
      const existingId = overlayIds.current[key];
      if (existingId) {
        chart.removeOverlay(existingId);
        overlayIds.current[key] = null;
      }
      const id = chart.createOverlay({
        name: 'fatPriceLine',
        lock: false,
        zLevel,
        points: [{ value: price }],
        extendData: { color, kind: key, lastClose, entryPrice },
        onPressedMoving: (event) => {
          const newValue = event.overlay?.points?.[0]?.value;
          if (typeof newValue === 'number' && Number.isFinite(newValue)) {
            const rounded = Number(newValue.toFixed(2));
            if (linesRef.current[key] !== rounded) {
              const next: PriceLines = { ...linesRef.current, [key]: rounded };
              linesRef.current = next;
              onChangeRef.current(next);
            }
          }
          return false;
        },
      });
      overlayIds.current[key] = typeof id === 'string' ? id : null;
    }
  }, [bars, lines.entry, lines.stop, lines.target]);

  return <div className="chart" ref={elRef} />;
}
