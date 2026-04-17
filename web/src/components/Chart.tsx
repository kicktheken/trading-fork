import { useEffect, useRef } from 'react';
import { init, dispose, LineType, type Chart as KChart, type KLineData } from 'klinecharts';
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

export function Chart({ bars, lines, onLinesChange }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<KChart | null>(null);
  const overlayIds = useRef<Record<string, string | null>>({
    entry: null,
    stop: null,
    target: null,
  });
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const onChangeRef = useRef(onLinesChange);
  onChangeRef.current = onLinesChange;

  // init / dispose
  useEffect(() => {
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
      },
    });
    chartRef.current = chart ?? null;
    return () => {
      if (elRef.current) dispose(elRef.current);
      chartRef.current = null;
      overlayIds.current = { entry: null, stop: null, target: null };
    };
  }, []);

  // feed data
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

  // sync overlays when lines change externally (e.g. ticker change sets defaults)
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
        name: 'priceLine',
        lock: false,
        points: [{ value: price }],
        styles: {
          line: { color, size: 2, style: LineType.Dashed },
          text: { color, backgroundColor: 'rgba(0,0,0,0.6)' },
        },
        extendData: { label: key.toUpperCase() },
        onPressedMoving: (event) => {
          const pt = event.overlay?.points?.[0];
          const newValue = pt?.value;
          if (typeof newValue === 'number' && Number.isFinite(newValue)) {
            const next: PriceLines = { ...linesRef.current, [key]: Number(newValue.toFixed(2)) };
            linesRef.current = next;
            onChangeRef.current(next);
          }
          return false;
        },
      });
      overlayIds.current[key] = typeof id === 'string' ? id : null;
    }
  }, [bars, lines.entry, lines.stop, lines.target]);

  return <div className="chart" ref={elRef} />;
}
