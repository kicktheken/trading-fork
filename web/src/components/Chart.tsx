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
    return () => {
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
