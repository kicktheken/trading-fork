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

const LINE_SPEC: Array<{ key: keyof PriceLines; color: string }> = [
  { key: 'entry', color: '#58a6ff' },
  { key: 'stop', color: '#f85149' },
  { key: 'target', color: '#3fb950' },
];

// Vertical hit-area (px) around the line for pointer interaction.
const HIT_HEIGHT = 36;
// Price-tag dimensions on the Y-axis.
const TAG_WIDTH = 64;
const TAG_HEIGHT = 26;

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
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const pt = coordinates[0];
      if (!pt) return [];
      const y = pt.y;
      const color = (overlay.extendData as { color?: string } | undefined)?.color ?? '#58a6ff';
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
        // Visible dashed line.
        {
          key: 'line',
          type: 'line',
          attrs: {
            coordinates: [
              { x: 0, y },
              { x: bounding.width, y },
            ],
          },
          styles: {
            style: 'dashed',
            color,
            size: 1.5,
            dashedValue: [6, 4],
          },
          ignoreEvent: true,
        },
      ];
      return figures;
    },
    createYAxisFigures: ({ coordinates, bounding, overlay, precision, thousandsSeparator }) => {
      const pt = coordinates[0];
      if (!pt) return [];
      const ext = overlay.extendData as { color?: string; label?: string } | undefined;
      const color = ext?.color ?? '#58a6ff';
      const label = ext?.label ?? '';
      const value = overlay.points[0]?.value;
      const priceText =
        typeof value === 'number'
          ? formatPrice(value, precision.price, thousandsSeparator)
          : '';
      const y = pt.y;
      const x = 0;
      const figures: OverlayFigure[] = [
        // Draggable price tag on the Y-axis.
        {
          key: 'tag',
          type: 'rect',
          attrs: {
            x,
            y: y - TAG_HEIGHT / 2,
            width: Math.min(TAG_WIDTH, bounding.width),
            height: TAG_HEIGHT,
          },
          styles: {
            style: 'fill',
            color,
            borderColor: color,
          },
        },
        {
          key: 'tagText',
          type: 'text',
          attrs: {
            x: x + 6,
            y: y - TAG_HEIGHT / 2 + 4,
            text: label ? `${label} ${priceText}` : priceText,
          },
          styles: {
            color: '#061108',
            size: 11,
            family: '-apple-system, system-ui, sans-serif',
            weight: '600',
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: 2,
            paddingBottom: 2,
          },
          ignoreEvent: true,
        },
      ];
      return figures;
    },
  });
}

function formatPrice(v: number, precision: number, thousandsSeparator: string): string {
  const fixed = v.toFixed(precision);
  const [int, dec] = fixed.split('.');
  const withSep = int!.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);
  return dec ? `${withSep}.${dec}` : withSep;
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

    for (const { key, color } of LINE_SPEC) {
      const price = lines[key];
      const existingId = overlayIds.current[key];
      if (existingId) {
        chart.removeOverlay(existingId);
        overlayIds.current[key] = null;
      }
      const id = chart.createOverlay({
        name: 'fatPriceLine',
        lock: false,
        points: [{ value: price }],
        extendData: { color, label: key.toUpperCase().slice(0, 1) },
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
