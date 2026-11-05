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

export interface TreemapEntry {
  row: RankedOperator;
  value: number;
  rank: number;
}

export function buildEntries(rows: readonly RankedOperator[]): TreemapEntry[] {
  return rows
    .filter((row) => row.available && row.total > 0)
    .map((row, index) => ({
      row,
      value: row.total,
      rank: index + 1,
    }));
}
