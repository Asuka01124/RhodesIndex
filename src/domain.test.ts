import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactNumber,
  csvEscape,
  EMPTY_FILTERS,
  matchesOperator,
  rankOperators,
  validateDataset,
} from './domain.ts';
import type { HeatDataset, HeatRecord, Operator } from './types.ts';

const operator: Operator = {
  id: 'char_4193_lemuen',
  name: '蕾缪安',
  englishName: 'Lemuen',
  japaneseName: 'レミュアン',
  profession: '狙击',
  branch: '神射手',
  rarity: 6,
  factions: ['拉特兰', '罗德岛'],
  gender: '女',
  originalGender: '女',
  releaseDate: '2025-05-01',
  avatar: '/avatar.png',
  sourceUrl: 'https://prts.wiki/w/蕾缪安',
};
const other: Operator = {
  ...operator,
  id: 'other',
  name: '银灰',
  profession: '近卫',
  factions: ['谢拉格'],
  gender: '男',
};
const record: HeatRecord = {
  operatorId: operator.id,
  platform: 'pixiv',
  year: 2025,
  likes: 100,
  views: null,
  sourceUrls: ['https://www.pixiv.net/artworks/151263798'],
  observedAt: '2026-11-01T00:00:00+08:00',
};
const dataset: HeatDataset = { schemaVersion: 1, yearBasis: 'publication_year', records: [record] };

test('只统计选定平台、年份和指标，年度分量之和等于合计', () => {
  const rows = [
    record,
    { ...record, year: 2026, likes: 35 },
    { ...record, platform: 'bilibili' as const, likes: 50 },
    { ...record, year: 2024, likes: 999 },
  ];
  const all = rankOperators([operator], rows, 'all', 'likes', [2025, 2026], EMPTY_FILTERS, '')[0];
  assert.equal(all.total, 185);
  assert.equal(all.yearly[2025], 150);
  assert.equal(all.yearly[2026], 35);
  const pixiv = rankOperators([operator], rows, 'pixiv', 'likes', [2026], EMPTY_FILTERS, '')[0];
  assert.equal(pixiv.total, 35);
});

test('未提供观看量保留 null，不作为零参与排名', () => {
  const records = [record, { ...record, operatorId: 'other', views: 0 }];
  const rows = rankOperators([operator, other], records, 'all', 'views', [2025], EMPTY_FILTERS, '');
  assert.equal(rows[0].operator.id, 'other');
  assert.equal(rows[0].available, true);
  assert.equal(rows[0].total, 0);
  assert.equal(rows[1].available, false);
  assert.equal(rows[1].yearly[2025], null);
});

test('职业与阵营组内或关系，组间和性别取交集', () => {
  assert.equal(
    matchesOperator(operator, {
      ...EMPTY_FILTERS,
      professions: ['狙击', '医疗'],
      factions: ['罗德岛'],
      gender: '女',
    }),
    true,
  );
  assert.equal(matchesOperator(operator, { ...EMPTY_FILTERS, professions: ['医疗'] }), false);
  assert.equal(matchesOperator(operator, { ...EMPTY_FILTERS, gender: '男' }), false);
  assert.equal(matchesOperator(operator, { ...EMPTY_FILTERS, factions: ['谢拉格'] }), false);
});

test('支持中英日名称检索，最低星级和关注过滤', () => {
  assert.equal(matchesOperator(operator, EMPTY_FILTERS, '  LEMUEN '), true);
  assert.equal(matchesOperator(operator, EMPTY_FILTERS, 'レミュアン'), true);
  assert.equal(
    matchesOperator({ ...operator, rarity: 5 }, { ...EMPTY_FILTERS, minRarity: 6 }),
    false,
  );
  assert.equal(
    rankOperators(
      [operator, other],
      [record],
      'all',
      'likes',
      [2025],
      EMPTY_FILTERS,
      '',
      'desc',
      new Set(['other']),
    ).length,
    1,
  );
});

test('导入验证接受合法数据和真实零值', () => {
  assert.deepEqual(validateDataset(dataset, [operator]), dataset);
  assert.equal(
    validateDataset({ ...dataset, records: [{ ...record, likes: 0 }] }, [operator]).records[0]
      .likes,
    0,
  );
});

test('导入拒绝重复组合，避免重复统计', () => {
  assert.throws(
    () => validateDataset({ ...dataset, records: [record, record] }, [operator]),
    /重复/,
  );
});

test('导入拒绝负数、小数、无效年份和未知干员', () => {
  assert.throws(
    () => validateDataset({ ...dataset, records: [{ ...record, likes: -1 }] }, [operator]),
    /likes/,
  );
  assert.throws(
    () => validateDataset({ ...dataset, records: [{ ...record, views: 1.2 }] }, [operator]),
    /views/,
  );
  assert.throws(
    () => validateDataset({ ...dataset, records: [{ ...record, year: 2030 }] }, [operator]),
    /年份/,
  );
  assert.throws(() => validateDataset(dataset, []), /干员 ID/);
});

test('导入需要来源及统计时间，不允许可执行链接', () => {
  assert.throws(
    () =>
      validateDataset(
        { ...dataset, records: [{ ...record, sourceUrls: ['javascript:alert(1)'] }] },
        [operator],
      ),
    /HTTP/,
  );
  assert.throws(
    () =>
      validateDataset({ ...dataset, records: [{ ...record, observedAt: '不是时间' }] }, [operator]),
    /统计时间/,
  );
  assert.throws(
    () => validateDataset({ ...dataset, records: [{ ...record, sourceUrls: [] }] }, [operator]),
    /来源链接/,
  );
});

test('数值格式化处理万、亿、零值，CSV 保留引号并防止公式注入', () => {
  assert.equal(compactNumber(0), '0');
  assert.equal(compactNumber(11000), '1.1万');
  assert.equal(compactNumber(120000000), '1.2亿');
  assert.equal(csvEscape('=1+2'), '"\'=1+2"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape(null), '""');
});
