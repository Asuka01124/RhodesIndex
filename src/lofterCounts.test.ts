import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lofterDisplayRows, validateLofterCounts } from './lofterCounts.ts';
import type { LofterTagDataset } from './types.ts';

const dataset = (): LofterTagDataset => ({
  schemaVersion: 1,
  kind: 'tag_summary',
  platform: 'lofter',
  records: [
    {
      operatorId: 'alice',
      tag: '爱丽丝',
      url: 'https://www.lofter.com/tag/alice/new',
      observedAt: '2026-11-03T00:00:00Z',
      status: 'ok',
      missingReason: null,
      views: { display: '1.2万', exact: false, value: null, estimate: 12000, atLeast: null },
      participation: { display: '0', exact: true, value: 0, estimate: null, atLeast: null },
    },
    {
      operatorId: 'missing',
      tag: '令',
      url: null,
      observedAt: null,
      status: 'failed',
      missingReason: '未取得',
      views: null,
      participation: null,
    },
  ],
  metadata: {
    plannedTags: 2,
    availableTags: 1,
    missingTags: 1,
    coverage: 'partial',
    generatedAt: null,
    timeBasis: 'all_time_at_observation',
    methodology: '标签统计',
  },
});

test('LOFTER保留原始约数和精确零；缺失不变成零', () => {
  const data = validateLofterCounts(dataset());
  const views = lofterDisplayRows(data, 'views');
  assert.equal(views[0].workCount, 12000);
  assert.equal(views[0].displayValue, '1.2万');
  assert.equal(views[0].approximate, true);
  assert.equal(lofterDisplayRows(data, 'participation')[0].workCount, 0);
  assert.equal(views[1].workCount, null);
});

test('LOFTER拒绝把约数当精确值和不可信来源', () => {
  const data = dataset();
  data.records[0].views!.value = 12000;
  assert.throws(() => validateLofterCounts(data));
  const unsafe = dataset();
  unsafe.records[0].url = 'https://example.com/';
  assert.throws(() => validateLofterCounts(unsafe));
});
