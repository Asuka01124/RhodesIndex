import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePixivFilters, filterPixivRecords, validatePixivSummary } from './pixiv.ts';
import { EMPTY_FILTERS, rankOperators } from './domain.ts';
import type { HeatRecord, Operator } from './types.ts';

const base: HeatRecord = {
  operatorId: 'operator',
  platform: 'pixiv',
  year: 2026,
  workType: '插画',
  rating: '全年龄',
  likes: 1,
  views: 10,
  bookmarks: 0,
  comments: null,
  sourceUrls: ['https://www.pixiv.net/artworks/1'],
  observedAt: '2026-11-05T00:00:00Z',
};
const operator: Operator = {
  id: 'operator',
  name: '干员',
  englishName: '',
  japaneseName: '',
  profession: '狙击',
  branch: '',
  rarity: 6,
  factions: [],
  gender: '女',
  originalGender: '女',
  releaseDate: '',
  avatar: '',
  sourceUrl: '',
};

test('作品类型与分级取交集，同一组内多选取并集', () => {
  const rows = [base, { ...base, rating: 'R-18' }, { ...base, workType: '漫画' }];
  assert.deepEqual(
    filterPixivRecords(rows, { ...EMPTY_FILTERS, workTypes: ['插画'], ratings: ['全年龄'] }),
    [base],
  );
  assert.equal(
    filterPixivRecords(rows, { ...EMPTY_FILTERS, workTypes: ['插画', '漫画'], ratings: ['全年龄'] })
      .length,
    2,
  );
  assert.equal(filterPixivRecords(rows, EMPTY_FILTERS).length, 3);
});

test('收藏真实零值参与排名，评论缺失以及旧记录缺少新指标均保持未提供', () => {
  const rank = (metric: 'bookmarks' | 'comments', records = [base]) =>
    rankOperators([operator], records, 'pixiv', metric, [2026], EMPTY_FILTERS, '')[0];
  assert.equal(rank('bookmarks').available, true);
  assert.equal(rank('bookmarks').total, 0);
  assert.equal(rank('comments').available, false);
  assert.equal(rank('bookmarks', [{ ...base, bookmarks: undefined }]).available, false);
  assert.equal(
    rank('comments', [
      { ...base, comments: 2 },
      { ...base, rating: 'R-18', comments: 3 },
    ]).total,
    5,
  );
});

test('快照保留同年不同类型、分级，拒绝重复分组和错误指标', () => {
  const snapshot = {
    schemaVersion: 1,
    yearBasis: 'publication_year',
    records: [base, { ...base, rating: 'R-18' }],
    metadata: {
      kind: 'pixiv_completed_operators',
      generatedAt: base.observedAt,
      operatorIds: ['operator'],
      workCount: 2,
    },
  };
  assert.equal(validatePixivSummary(snapshot).records.length, 2);
  assert.throws(() => validatePixivSummary({ ...snapshot, records: [base, base] }));
  assert.throws(() => validatePixivSummary({ ...snapshot, records: [{ ...base, bookmarks: -1 }] }));
});

test('作品榜独立接收列表完整的干员，不要求互动指标补齐', () => {
  const snapshot = {
    schemaVersion: 1,
    yearBasis: 'publication_year',
    records: [],
    countRecords: [
      { ...base, likes: null, views: null, bookmarks: null, comments: null, workCount: 37 },
    ],
    metadata: {
      kind: 'pixiv_completed_operators',
      generatedAt: base.observedAt,
      operatorIds: [],
      workCount: 0,
      countOperatorIds: ['operator'],
      countWorkCount: 37,
      unknownYearCounts: {},
    },
  };
  const data = validatePixivSummary(snapshot);
  assert.equal(data.records.length, 0);
  assert.equal(
    rankOperators(
      [operator],
      data.countRecords!,
      'pixiv',
      'workCount',
      [2026],
      EMPTY_FILTERS,
      '',
    )[0].total,
    37,
  );
  assert.equal(
    rankOperators([operator], data.countRecords!, 'pixiv', 'views', [2026], EMPTY_FILTERS, '')[0]
      .available,
    false,
  );
  assert.throws(() =>
    validatePixivSummary({
      ...snapshot,
      countRecords: [{ ...snapshot.countRecords[0], workCount: -1 }],
    }),
  );
  assert.throws(() =>
    validatePixivSummary({ ...snapshot, metadata: { ...snapshot.metadata, countOperatorIds: [] } }),
  );
});

test('列表完整而当前年份或筛选没有作品时为真实零，未采集保持未知', () => {
  const rows = rankOperators(
    [operator, { ...operator, id: 'missing', name: '未知' }],
    [],
    'pixiv',
    'workCount',
    [2026],
    EMPTY_FILTERS,
    '',
    'desc',
    undefined,
    new Set(['operator']),
  );
  assert.equal(rows[0].available, true);
  assert.equal(rows[0].total, 0);
  assert.equal(rows[0].yearly[2026], 0);
  assert.equal(rows[1].available, false);
  assert.equal(rows[1].yearly[2026], null);
});

function annualSnapshot() {
  return {
    schemaVersion: 1,
    yearBasis: 'publication_year',
    records: [base],
    countRecords: ['绘画', '小说'].map((workType, i) => ({
      ...base,
      year: 2019,
      workType,
      rating: '全部分级',
      workCount: i ? 0 : 37,
      likes: null,
      views: null,
      bookmarks: null,
      comments: null,
      sourceUrls: ['https://www.pixiv.net/tags/干员/artworks?scd=2019-01-01&ecd=2019-12-31'],
    })),
    metadata: {
      kind: 'pixiv_completed_operators',
      generatedAt: base.observedAt,
      operatorIds: ['operator'],
      workCount: 1,
      countOperatorIds: ['operator'],
      countMethod: 'chinese_base_tag_year_total',
      countYearBasis: 'pixiv_jst_search_year',
      countYears: [2019],
      countGeneratedAt: base.observedAt,
    },
  };
}

test('中文本体年度原生数量保留真实零，按年合并绘画和小说且不覆盖互动', () => {
  const data = validatePixivSummary(annualSnapshot());
  assert.equal(data.records[0].views, 10);
  assert.equal(data.countRecords![1].workCount, 0);
  const row = rankOperators(
    [operator],
    data.countRecords!,
    'pixiv',
    'workCount',
    [2019],
    EMPTY_FILTERS,
    '',
  )[0];
  assert.equal(row.total, 37);
  assert.equal(
    rankOperators([operator], data.countRecords!, 'pixiv', 'views', [2019], EMPTY_FILTERS, '')[0]
      .available,
    false,
  );
});

test('年度数量拒绝不完整覆盖、虚构分级、互动指标和全局去重总数', () => {
  const snapshot = annualSnapshot();
  assert.throws(() =>
    validatePixivSummary({ ...snapshot, countRecords: snapshot.countRecords.slice(0, 1) }),
  );
  assert.throws(() =>
    validatePixivSummary({
      ...snapshot,
      countRecords: snapshot.countRecords.map((r) => ({ ...r, rating: '全年龄' })),
    }),
  );
  assert.throws(() =>
    validatePixivSummary({
      ...snapshot,
      countRecords: snapshot.countRecords.map((r) => ({ ...r, views: 0 })),
    }),
  );
  assert.throws(() =>
    validatePixivSummary({ ...snapshot, metadata: { ...snapshot.metadata, countWorkCount: 37 } }),
  );
  assert.throws(() =>
    validatePixivSummary({ ...snapshot, metadata: { ...snapshot.metadata, countYears: [2020] } }),
  );
});

test('切换年度作品数后忽略旧分级和细分类筛选，保留干员筛选及原偏好', () => {
  const old = { ...EMPTY_FILTERS, professions: ['狙击'], ratings: ['R-18'], workTypes: ['插画'] };
  const filters = effectivePixivFilters(old, true);
  const data = validatePixivSummary(annualSnapshot());
  assert.equal(
    rankOperators(
      [operator],
      filterPixivRecords(data.countRecords!, filters),
      'pixiv',
      'workCount',
      [2019],
      filters,
      '',
    )[0].total,
    37,
  );
  assert.deepEqual(old.ratings, ['R-18']);
  assert.equal(effectivePixivFilters(old, false), old);
  assert.deepEqual(effectivePixivFilters({ ...old, workTypes: ['绘画'] }, false).workTypes, []);
});
