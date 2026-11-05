import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, buildTagCountEntries, squarify } from './treemap.ts';
import type { RankedTagCountRow } from './treemap.ts';
import type { Operator, RankedOperator } from './types.ts';

function row(
  id: string,
  profession: string,
  yearly: Record<number, number | null>,
): RankedOperator {
  const values = Object.values(yearly).filter((v): v is number => v !== null);
  return {
    operator: { id, name: id, profession } as Operator,
    total: values.reduce((s, v) => s + v, 0),
    available: values.length > 0,
    yearly,
  };
}

test('squarify fills the container and keeps areas proportional', () => {
  const items = [
    { value: 6 },
    { value: 6 },
    { value: 4 },
    { value: 3 },
    { value: 2 },
    { value: 2 },
    { value: 1 },
  ];
  const rects = squarify(items, 0, 0, 600, 400);
  assert.equal(rects.length, items.length);
  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(area - 600 * 400) < 1e-6);
  for (const r of rects) {
    assert.ok(Math.abs(r.w * r.h - (r.item.value / 24) * 240000) < 1e-6);
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-6 && r.y + r.h <= 400 + 1e-6);
  }
});

test('squarify skips zero values and empty containers', () => {
  assert.deepEqual(squarify([{ value: 0 }], 0, 0, 100, 100), []);
  assert.deepEqual(squarify([{ value: 1 }], 0, 0, 0, 100), []);
});

test('buildEntries keeps only operators with positive totals and assigns descending ranks', () => {
  const entries = buildEntries([
    row('b', '术师', { 2025: 5, 2026: null }),
    row('a', '近卫', { 2025: 10, 2026: 30 }),
    row('c', '近卫', { 2025: null, 2026: null }),
  ]);
  assert.deepEqual(
    entries.map((e) => [e.operator.id, e.value, e.rank]),
    [
      ['a', 40, 1],
      ['b', 5, 2],
    ],
  );
});

test('buildTagCountEntries preserves approximate/lower-bound labels and drops missing/zero', () => {
  const tagRows: RankedTagCountRow[] = [
    {
      operator: { id: 'x', name: '甲', profession: '近卫', factions: [] } as unknown as Operator,
      record: {
        workCount: 12000,
        displayValue: '1.2万',
        approximate: true,
      },
    },
    {
      operator: { id: 'y', name: '乙', profession: '术师', factions: [] } as unknown as Operator,
      record: {
        workCount: 0,
      },
    },
    {
      operator: { id: 'z', name: '丙', profession: '辅助', factions: [] } as unknown as Operator,
      record: null,
    },
  ];
  const entries = buildTagCountEntries(tagRows);
  assert.deepEqual(
    entries.map((e) => [e.operator.id, e.value, e.displayValue, e.rank]),
    [['x', 12000, '约 1.2万', 1]],
  );
});
