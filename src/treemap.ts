import type { RankedOperator } from './types';

export interface TreemapRect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls et al.). Items must carry a positive `value`. */
export function squarify<T extends { value: number }>(
  items: readonly T[],
  x: number,
  y: number,
  w: number,
  h: number,
): TreemapRect<T>[] {
  const out: TreemapRect<T>[] = [];
  const positive = items.filter((item) => item.value > 0);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  const rest = [...positive]
    .sort((a, b) => b.value - a.value)
    .map((item) => ({ item, area: item.value * scale }));
  let row: typeof rest = [];

  const worst = (candidate: typeof rest, side: number) => {
    let sum = 0;
    let max = 0;
    let min = Infinity;
    for (const c of candidate) {
      sum += c.area;
      max = Math.max(max, c.area);
      min = Math.min(min, c.area);
    }
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const layout = (current: typeof rest) => {
    const sum = current.reduce((s, c) => s + c.area, 0);
    if (w >= h) {
      const colWidth = sum / h;
      let cy = y;
      for (const c of current) {
        const ch = c.area / colWidth;
        out.push({ item: c.item, x, y: cy, w: colWidth, h: ch });
        cy += ch;
      }
      x += colWidth;
      w -= colWidth;
    } else {
      const rowHeight = sum / w;
      let cx = x;
      for (const c of current) {
        const cw = c.area / rowHeight;
        out.push({ item: c.item, x: cx, y, w: cw, h: rowHeight });
        cx += cw;
      }
      y += rowHeight;
      h -= rowHeight;
    }
  };

  while (rest.length) {
    const side = Math.min(w, h);
    const next = rest[0];
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      rest.shift();
    } else {
      layout(row);
      row = [];
    }
  }
  if (row.length) layout(row);
  return out;
}

export type YearChange =
  | { kind: 'pct'; value: number; from: number; to: number }
  | { kind: 'new'; from: number; to: number }
  | { kind: 'na' };

export interface TreemapEntry {
  row: RankedOperator;
  value: number;
  peakYear: number | null;
  change: YearChange;
}

/**
 * Compare the latest two selected years. Missing values stay missing:
 * a null previous year with a present latest year is reported as "new",
 * never as an infinite or zero-based growth rate.
 */
export function yearChange(row: RankedOperator, years: readonly number[]): YearChange {
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length < 2) return { kind: 'na' };
  const to = sorted[sorted.length - 1];
  const from = sorted[sorted.length - 2];
  const current = row.yearly[to] ?? null;
  const previous = row.yearly[from] ?? null;
  if (current === null) return { kind: 'na' };
  if (previous === null || previous === 0) return { kind: 'new', from, to };
  return { kind: 'pct', value: current / previous - 1, from, to };
}

export function peakYear(row: RankedOperator, years: readonly number[]): number | null {
  let best: number | null = null;
  let bestValue = -Infinity;
  for (const year of years) {
    const value = row.yearly[year];
    if (value != null && value > bestValue) {
      bestValue = value;
      best = year;
    }
  }
  return best;
}

export function buildEntries(rows: readonly RankedOperator[], years: readonly number[]) {
  return rows
    .filter((row) => row.available && row.total > 0)
    .map<TreemapEntry>((row) => ({
      row,
      value: row.total,
      peakYear: peakYear(row, years),
      change: yearChange(row, years),
    }));
}

export interface TreemapGroup {
  key: string;
  value: number;
  entries: TreemapEntry[];
}

export function groupEntries(entries: readonly TreemapEntry[], byProfession: boolean) {
  if (!byProfession) {
    return [
      { key: '', value: entries.reduce((s, e) => s + e.value, 0), entries: [...entries] },
    ] satisfies TreemapGroup[];
  }
  const map = new Map<string, TreemapEntry[]>();
  for (const entry of entries) {
    const key = entry.row.operator.profession || '未知';
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  }
  return [...map].map<TreemapGroup>(([key, list]) => ({
    key,
    value: list.reduce((s, e) => s + e.value, 0),
    entries: list,
  }));
}
