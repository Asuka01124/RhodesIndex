import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPixivRecords, validatePixivSummary } from './pixiv.ts';
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
