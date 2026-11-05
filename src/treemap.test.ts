import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, groupEntries, squarify, yearChange } from './treemap.ts';
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

test('yearChange compares the latest two selected years without inventing values', () => {
  const r = row('a', '近卫', { 2024: 100, 2025: 150, 2026: null });
  assert.deepEqual(yearChange(r, [2024, 2025]), { kind: 'pct', value: 0.5, from: 2024, to: 2025 });
  assert.deepEqual(yearChange(r, [2025, 2026]), { kind: 'na' });
  assert.deepEqual(yearChange(row('b', '近卫', { 2025: null, 2026: 10 }), [2026, 2025]), {
    kind: 'new',
    from: 2025,
    to: 2026,
  });
  assert.deepEqual(yearChange(r, [2025]), { kind: 'na' });
});

test('buildEntries drops operators without data and groups by profession', () => {
  const entries = buildEntries(
    [
      row('a', '近卫', { 2025: 10, 2026: 30 }),
      row('b', '术师', { 2025: 5, 2026: null }),
      row('c', '近卫', { 2025: null, 2026: null }),
    ],
    [2025, 2026],
  );
  assert.deepEqual(
    entries.map((e) => [e.row.operator.id, e.value, e.peakYear]),
    [
      ['a', 40, 2026],
      ['b', 5, 2025],
    ],
  );
  const groups = groupEntries(entries, true);
  assert.deepEqual(
    groups.map((g) => [g.key, g.value]),
    [
      ['近卫', 40],
      ['术师', 5],
    ],
  );
  assert.equal(groupEntries(entries, false)[0].value, 45);
});
