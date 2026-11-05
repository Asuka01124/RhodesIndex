import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, buildTagCountEntries, squarify, TREEMAP_LIMIT } from './treemap.ts';
import type { RankedTagCountRow } from './treemap.ts';
import type { Operator, RankedOperator } from './types.ts';

function row(id: string, profession: string, yearly: Record<number, number | null>): RankedOperator {
  const values = Object.values(yearly).filter((v): v is number => v !== null);
  return {
    operator: { id, name: id, profession } as Operator,
    total: values.reduce((s, v) => s + v, 0),
    available: values.length > 0,
    yearly,
  };
}

test('squarify fills the container, keeps monotonic areas, and avoids thin slivers on small cohorts', () => {
  const items = [
    { value: 6321 },
    { value: 2606 },
    { value: 2276 },
    { value: 1368 },
    { value: 1279 },
    { value: 180 },
  ];
  const rects = squarify(items, 0, 0, 1000, 380);
  assert.equal(rects.length, items.length);
  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(area - 1000 * 380) < 1e-6);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    assert.ok(r.w >= 90 && r.h >= 90, `tile ${i} too thin: ${r.w}x${r.h}`);
    assert.ok(
      r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1000 + 1e-6 && r.y + r.h <= 380 + 1e-6,
    );
    if (i > 0) {
      assert.ok(rects[i - 1].w * rects[i - 1].h >= r.w * r.h - 1e-6);
    }
  }
});

test('squarify skips zero values and empty containers', () => {
  assert.deepEqual(squarify([{ value: 0 }], 0, 0, 100, 100), []);
  assert.deepEqual(squarify([{ value: 1 }], 0, 0, 0, 100), []);
});

test('buildEntries keeps only operators with positive totals, sorts descending, and caps at top 30', () => {
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
  const many = Array.from({ length: 40 }, (_, i) => row(`op_${i}`, '近卫', { 2026: i + 1 }));
  const top = buildEntries(many);
  assert.equal(top.length, TREEMAP_LIMIT);
  assert.equal(top[0].value, 40);
  assert.equal(top[top.length - 1].value, 11);
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
