import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankTagCounts, validateTagCounts } from './tagCounts.ts';
import { EMPTY_FILTERS } from './domain.ts';
import type { BilibiliCountDataset, BilibiliTagCount, Filters, Operator } from './types.ts';

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
const singleRow = (count: number | null): BilibiliTagCount => ({
  ...row('base', count),
  tag: '阿米娅',
  nativeTag: '阿米娅',
  countBasis: 'native_tag_use_sum',
  sharedOperatorIds: ['base', 'medical'],
  complete: count !== null,
  lowerBound: false,
  components: [
    {
      tag: '阿米娅',
      nativeTag: '阿米娅',
      tagId: count === null ? null : 1,
      workCount: count,
      status: count === null ? 'pending' : 'completed',
      observedAt: count === null ? null : '2026-11-07T00:00:00Z',
      url: 'https://www.bilibili.com/tag/1',
      apiSourceUrl: 'https://api.bilibili.com/x/tag/info?tag_name=test',
      missingReason: null,
    },
  ],
});
const dataset = (records: BilibiliTagCount[]): BilibiliCountDataset => ({
  schemaVersion: 1,
  kind: 'tag_count',
  platform: 'bilibili',
  records,
  metadata: {
    plannedTags: records.reduce((sum, r) => sum + (r.components?.length ?? 0), 0),
    availableTags: records.flatMap((r) => r.components ?? []).filter((r) => r.workCount !== null)
      .length,
    missingTags: records.flatMap((r) => r.components ?? []).filter((r) => r.workCount === null)
      .length,
    coverage: 'partial',
    generatedAt: null,
    timeBasis: 'all_time_at_observation',
    methodology: '单 TAG 使用数合计，跨标签未去重',
    countBasis: 'native_tag_use_sum',
  },
});

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
test('合并记录拒绝重复归属、非法数值和不安全来源', () => {
  assert.throws(() => validateTagCounts(dataset([singleRow(1), singleRow(2)])));
  assert.throws(() => validateTagCounts(dataset([singleRow(-1)])));
  assert.throws(() =>
    validateTagCounts(dataset([{ ...singleRow(1), url: 'javascript:alert(1)' }])),
  );
  assert.throws(() => validateTagCounts(dataset([{ ...singleRow(1), observedAt: null }])));
  assert.equal(validateTagCounts(dataset([singleRow(0)])).records[0].workCount, 0);
  assert.equal(validateTagCounts(dataset([singleRow(null)])).records[0].workCount, null);
});
test('旧搜索数不能混用，合计必须等于各形态 TAG 小计', () => {
  assert.throws(() =>
    validateTagCounts(dataset([{ ...singleRow(1), countBasis: 'search_result_total' }])),
  );
  assert.throws(() => validateTagCounts(dataset([{ ...singleRow(1), workCount: 999 }])));
  const bad = singleRow(1);
  bad.components![0].observedAt = null;
  assert.throws(() => validateTagCounts(dataset([bad])));
});
test('本体异格只排一行，搜索异格、按异格职业筛选及关注仍能找到合并角色', () => {
  const records = [singleRow(10)];
  const cases: [string, Filters, Set<string> | undefined][] = [
    ['医疗', EMPTY_FILTERS, undefined],
    ['', { ...EMPTY_FILTERS, professions: ['医疗'] }, undefined],
    ['', EMPTY_FILTERS, new Set(['medical'])],
  ];
  for (const [query, filters, favorites] of cases) {
    const result = rankTagCounts(operators, records, filters, query, 'desc', favorites);
    assert.deepEqual(
      result.map((r) => [r.operator.id, r.record?.workCount]),
      [['base', 10]],
    );
  }
});
test('缺失形态必须标明部分小计，不补零，也不能省略缺失覆盖', () => {
  const merged = singleRow(10);
  merged.components!.push({
    ...merged.components![0],
    tag: '阿米娅(医疗)',
    nativeTag: '阿米娅(医疗)',
    tagId: null,
    workCount: null,
    observedAt: null,
    missingReason: '标签不存在',
  });
  merged.complete = false;
  merged.lowerBound = true;
  assert.equal(validateTagCounts(dataset([merged])).records[0].workCount, 10);
  assert.throws(() => validateTagCounts(dataset([{ ...merged, lowerBound: false }])));
});
