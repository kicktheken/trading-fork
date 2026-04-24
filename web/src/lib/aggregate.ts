import type { Bar } from '../api/client';

export type Timeframe = 'daily' | 'weekly';

// Aggregate daily bars into ISO weeks (Mon-Fri buckets). Bars assumed sorted ascending.
export function aggregateWeekly(bars: Bar[]): Bar[] {
  if (bars.length === 0) return bars;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curKey = '';

  for (const b of bars) {
    const key = isoWeekKey(new Date(b.timestamp));
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { ...b };
      curKey = key;
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function aggregate(bars: Bar[], tf: Timeframe): Bar[] {
  return tf === 'weekly' ? aggregateWeekly(bars) : bars;
}

// ISO-week key "YYYY-Www" — matches Thursday-of-week rule so weeks are stable across years.
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
