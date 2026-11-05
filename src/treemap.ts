import { compactNumber } from './domain.ts';
import type { Operator, RankedOperator, TagSummaryRow } from './types.ts';

export interface TreemapRect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Balanced binary treemap with soft minimum weight floor so small cohorts (e.g. 2–15 items)
 * never leave a trailing sliver, while preserving strict rank order of tile areas.
 */
export function squarify<T extends { value: number }>(
  items: readonly T[],
  x: number,
  y: number,
  w: number,
  h: number,
): TreemapRect<T>[] {
  const positive = items.filter((item) => item.value > 0);
  const n = positive.length;
  if (!n || w <= 0 || h <= 0) return [];
  const sorted = [...positive].sort((a, b) => b.value - a.value);
  const maxVal = sorted[0].value;
  // Soften extreme ratios and ensure every tile gets at least a readable share of area
  const minFloor = maxVal * (n <= 8 ? 0.14 : n <= 16 ? 0.08 : 0.045);
  const weights = sorted.map((item) => Math.pow(Math.max(item.value, minFloor), 0.78));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + weights[i];

  const out: TreemapRect<T>[] = [];
  const subdivide = (lo: number, hi: number, rx: number, ry: number, rw: number, rh: number) => {
    const count = hi - lo;
    if (count <= 0 || rw <= 0 || rh <= 0) return;
    if (count === 1) {
      out.push({ item: sorted[lo], x: rx, y: ry, w: rw, h: rh });
      return;
    }
    const total = prefix[hi] - prefix[lo];
    if (total <= 0) return;

    // For 2 or 3 items in an elongated box, lay them out in a single strip if that keeps better aspect ratios
    const horizontal = rw >= rh;
    const stripAspect = (k: number) => {
      const share = weights[k] / total;
      const bw = horizontal ? rw * share : rw;
      const bh = horizontal ? rh : rh * share;
      return Math.max(bw / bh, bh / bw);
    };
    if (count <= 3) {
      let worstStrip = 0;
      for (let k = lo; k < hi; k++) worstStrip = Math.max(worstStrip, stripAspect(k));
      if (worstStrip <= 2.1) {
        let pos = horizontal ? rx : ry;
        for (let k = lo; k < hi; k++) {
          const share = weights[k] / total;
          if (horizontal) {
            const cw = rw * share;
            out.push({ item: sorted[k], x: pos, y: ry, w: cw, h: rh });
            pos += cw;
          } else {
            const ch = rh * share;
            out.push({ item: sorted[k], x: rx, y: pos, w: rw, h: ch });
            pos += ch;
          }
        }
        return;
      }
    }

    // Choose split point that balances weight closest to 50/50 while avoiding orphan 1-item tail when count >= 4
    let bestSplit = lo + 1;
    let bestScore = Infinity;
    for (let mid = lo + 1; mid < hi; mid++) {
      const ratio = (prefix[mid] - prefix[lo]) / total;
      const tailPenalty = count >= 4 && hi - mid === 1 && ratio > 0.72 ? 0.35 : 0;
      const score = Math.abs(ratio - 0.5) + tailPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestSplit = mid;
      }
    }
    const ratio = (prefix[bestSplit] - prefix[lo]) / total;
    if (horizontal) {
      const leftW = rw * ratio;
      subdivide(lo, bestSplit, rx, ry, leftW, rh);
      subdivide(bestSplit, hi, rx + leftW, ry, rw - leftW, rh);
    } else {
      const topH = rh * ratio;
      subdivide(lo, bestSplit, rx, ry, rw, topH);
      subdivide(bestSplit, hi, rx, ry + topH, rw, rh - topH);
    }
  };

  subdivide(0, n, x, y, w, h);
  return out;
}

export interface TreemapEntry {
  operator: Operator;
  value: number;
  displayValue?: string;
  yearly?: Record<number, number | null>;
  rank: number;
}

export const TREEMAP_LIMIT = 30;

export function buildEntries(
  rows: readonly RankedOperator[],
  limit = TREEMAP_LIMIT,
): TreemapEntry[] {
  return [...rows]
    .filter((row) => row.available && row.total > 0)
    .sort((a, b) => b.total - a.total || a.operator.name.localeCompare(b.operator.name, 'zh-CN'))
    .slice(0, limit)
    .map((row, index) => ({
      operator: row.operator,
      value: row.total,
      yearly: row.yearly,
      rank: index + 1,
    }));
}

export interface RankedTagCountRow {
  operator: Operator;
  record: Pick<TagSummaryRow, 'workCount' | 'displayValue' | 'approximate' | 'lowerBound'> | null;
}

export function buildTagCountEntries(
  rows: readonly RankedTagCountRow[],
  limit = TREEMAP_LIMIT,
): TreemapEntry[] {
  return [...rows]
    .filter(
      (
        row,
      ): row is {
        operator: Operator;
        record: NonNullable<RankedTagCountRow['record']> & { workCount: number };
      } => row.record != null && row.record.workCount != null && row.record.workCount > 0,
    )
    .sort(
      (a, b) =>
        b.record.workCount - a.record.workCount ||
        a.operator.name.localeCompare(b.operator.name, 'zh-CN'),
    )
    .slice(0, limit)
    .map((row, index) => {
      const r = row.record;
      const prefix = r.lowerBound ? '≥ ' : r.approximate ? '约 ' : '';
      const raw = r.displayValue ?? compactNumber(r.workCount);
      return {
        operator: row.operator,
        value: r.workCount,
        displayValue: `${prefix}${raw}`,
        rank: index + 1,
      };
    });
}
