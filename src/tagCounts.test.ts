import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankTagCounts, validateTagCounts } from './tagCounts.ts';
import { EMPTY_FILTERS } from './domain.ts';
import type { BilibiliCountDataset, BilibiliTagCount, Operator } from './types.ts';

const operators = [
  {
    id: 'base',
    name: '阿米娅',
    englishName: 'Amiya',
    japaneseName: 'アーミヤ',
    profession: '术师',
    branch: '中坚术师',
    rarity: 5,
    factions: ['罗德岛'],
    gender: '女',
    originalGender: '女',
    releaseDate: '2019-04-30',
    avatar: '',
    sourceUrl: '',
  },
  {
    id: 'medical',
    name: '阿米娅(医疗)',
    englishName: 'Amiya',
    japaneseName: 'アーミヤ',
    profession: '医疗',
    branch: '咒愈师',
    rarity: 5,
    factions: ['罗德岛'],
    gender: '女',
    originalGender: '女',
    releaseDate: '2024-05-01',
    avatar: '',
    sourceUrl: '',
  },
] as Operator[];
const row = (operatorId: string, count: number | null): BilibiliTagCount => ({
  operatorId,
  tag: operatorId,
  nativeTag: operatorId,
  tagId: 1,
  workCount: count,
  status: count === null ? 'failed' : 'completed',
  observedAt: count === null ? null : '2026-11-03T00:00:00Z',
  url: 'https://www.bilibili.com/tag/1',
  apiSourceUrl: 'https://api.bilibili.com/x/tag/info?tag_name=test',
  missingReason: count === null ? '未取得' : null,
  countBasis: 'search_result_total',
  query: `${operatorId} 明日方舟`,
  searchTerms: [operatorId, '明日方舟'],
});
const dataset = (records: BilibiliTagCount[]) =>
  ({
    schemaVersion: 1,
    kind: 'tag_count',
    platform: 'bilibili',
    records,
    metadata: {
      plannedTags: 2,
      availableTags: records.filter((r) => r.workCount !== null).length,
      missingTags: records.filter((r) => r.workCount === null).length,
      coverage: 'partial',
      generatedAt: null,
      timeBasis: 'all_time_at_observation',
      methodology: '标签累计数量',
      countBasis: 'search_result_total',
    },
  }) as BilibiliCountDataset;

test('作品数量按干员ID关联，阿米娅本体和医疗型不混算', () => {
  const ranked = rankTagCounts(
    operators,
    [row('base', 95414), row('medical', 3)],
    EMPTY_FILTERS,
    '阿米娅',
  );
  assert.deepEqual(
    ranked.map((r) => [r.operator.id, r.record?.workCount]),
    [
      ['base', 95414],
      ['medical', 3],
    ],
  );
});
test('数量排名保留真实零值，缺失始终排在已取得数据之后', () => {
  for (const sort of ['asc', 'desc'] as const) {
    const ranked = rankTagCounts(
      operators,
      [row('base', 0), row('medical', null)],
      EMPTY_FILTERS,
      '',
      sort,
    );
    assert.equal(ranked[0].record?.workCount, 0);
    assert.equal(ranked[1].record?.workCount, null);
  }
});
test('作品数量支持原有职业筛选与关注，不依赖年份或互动指标', () => {
  const ranked = rankTagCounts(
    operators,
    [row('base', 9), row('medical', 3)],
    { ...EMPTY_FILTERS, professions: ['医疗'] },
    '',
    'desc',
    new Set(['medical']),
  );
  assert.deepEqual(
    ranked.map((r) => r.operator.id),
    ['medical'],
  );
});
test('数量接口拒绝重复干员、非法数值和不安全来源', () => {
  assert.throws(() => validateTagCounts(dataset([row('base', 1), row('base', 2)])));
  assert.throws(() => validateTagCounts(dataset([row('base', -1)])));
  assert.throws(() =>
    validateTagCounts(dataset([{ ...row('base', 1), url: 'javascript:alert(1)' }])),
  );
  assert.throws(() => validateTagCounts(dataset([{ ...row('base', 1), observedAt: null }])));
  assert.equal(
    validateTagCounts(dataset([row('base', 0), row('medical', null)])).records[1].workCount,
    null,
  );
});

test('搜索结果数拒绝混入旧交集口径和不一致的组合词', () => {
  assert.throws(() =>
    validateTagCounts(dataset([{ ...row('base', 1), countBasis: 'exact_tag_intersection' }])),
  );
  assert.throws(() =>
    validateTagCounts(dataset([{ ...row('base', 1), query: '其他词 明日方舟' }])),
  );
  assert.throws(() => validateTagCounts(dataset([{ ...row('base', 1), searchTerms: ['base'] }])));
});
