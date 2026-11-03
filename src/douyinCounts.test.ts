import assert from 'node:assert/strict';
import { test } from 'node:test';
import { douyinDisplayRows, douyinRoster, validateDouyinCounts } from './douyinCounts.ts';
import type { DouyinTopicDataset, DouyinTopicRecord, Operator } from './types.ts';
import { DOUYIN_AMBIGUOUS_OPERATOR_IDS, hideAmbiguousDouyinTopics } from './douyinAmbiguity.ts';

const row = (id: string, count: number | null): DouyinTopicRecord => ({
  operatorId: id,
  operatorIds: [id],
  tag: id,
  topicId: count === null ? null : '123',
  playCount: count,
  nativeViewCount: count,
  status: count === null ? 'failed' : 'completed',
  observedAt: count === null ? null : '2026-11-03T00:00:00Z',
  url: 'https://creator.douyin.com/aweme/v1/search/challengesug/?keyword=example',
  apiSourceUrl: 'https://creator.douyin.com/aweme/v1/search/challengesug/?keyword=example',
  missingReason: count === null ? '未取得' : null,
  association: 'exact_topic_name_only_operator_identity_unverified',
});
const dataset = (records: DouyinTopicRecord[]): DouyinTopicDataset => ({
  schemaVersion: 1,
  kind: 'topic_summary',
  platform: 'douyin',
  records,
  metadata: {
    plannedTags: records.length,
    plannedOperators: records.reduce((sum, r) => sum + r.operatorIds.length, 0),
    availableTags: records.filter((r) => r.playCount !== null).length,
    missingTags: records.filter((r) => r.playCount === null).length,
    coverage: 'partial',
    generatedAt: null,
    timeBasis: 'all_time_at_observation',
    metric: 'native_view_count',
    methodology: '话题累计播放量',
  },
});

test('抖音保留原生零和缺失；列表缩写不改变完整统计值', () => {
  const data = validateDouyinCounts(dataset([row('one', 1334711186), row('missing', null)]));
  const rows = douyinDisplayRows(data);
  assert.equal(rows[0].workCount, 1334711186);
  assert.equal(rows[0].displayValue, '13.35亿');
  assert.equal(rows[1].workCount, null);
  assert.equal(douyinDisplayRows(validateDouyinCounts(dataset([row('zero', 0)])))[0].workCount, 0);
});

test('阿米娅职业形态只保留一个排行条目；共享统计不相加', () => {
  const primary = {
    ...row('char_002_amiya', 17),
    operatorIds: ['char_002_amiya', 'char_1001_amiya2', 'char_1037_amiya3'],
  };
  const data = validateDouyinCounts(dataset([primary]));
  assert.equal(douyinDisplayRows(data)[0].workCount, 17);
  const roster = primary.operatorIds.map((id) => ({ id })) as Operator[];
  assert.deepEqual(
    douyinRoster(roster).map((operator) => operator.id),
    ['char_002_amiya'],
  );
});

test('抖音拒绝重复人物、重复话题、原生数值不一致和错误覆盖范围', () => {
  assert.throws(() =>
    validateDouyinCounts(
      dataset([row('one', 1), { ...row('two', 2), operatorIds: ['one', 'two'] }]),
    ),
  );
  assert.throws(() => validateDouyinCounts(dataset([row('one', 1), row('two', 2)])));
  assert.throws(() => validateDouyinCounts(dataset([{ ...row('one', 1), nativeViewCount: 2 }])));
  const invalid = dataset([row('one', 1)]);
  invalid.metadata.availableTags = 2;
  assert.throws(() => validateDouyinCounts(invalid));
});

test('抖音拒绝无来源时间、非法计数和不可信来源', () => {
  assert.throws(() => validateDouyinCounts(dataset([{ ...row('one', 1), observedAt: null }])));
  assert.throws(() => validateDouyinCounts(dataset([row('one', -1)])));
  assert.throws(() =>
    validateDouyinCounts(dataset([{ ...row('one', 1), url: 'javascript:alert(1)' }])),
  );
  assert.throws(() =>
    validateDouyinCounts(dataset([{ ...row('one', 1), apiSourceUrl: 'https://other.example/' }])),
  );
});

test('同名隐藏名单固定为29项，筛选或重排不误删其他角色，关闭后可恢复', () => {
  assert.equal(DOUYIN_AMBIGUOUS_OPERATOR_IDS.size, 29);
  const roster = [
    { id: 'char_4125_rdoc' }, // 原第1名医生
    { id: 'char_4058_pepe' }, // 原第30名佩佩
    { id: 'char_002_amiya' },
  ] as Operator[];
  assert.deepEqual(
    hideAmbiguousDouyinTopics(roster, true).map((operator) => operator.id),
    ['char_4058_pepe', 'char_002_amiya'],
  );
  assert.deepEqual(
    hideAmbiguousDouyinTopics([...roster].reverse(), true).map((operator) => operator.id),
    ['char_002_amiya', 'char_4058_pepe'],
  );
  assert.equal(hideAmbiguousDouyinTopics(roster, false).length, 3);
  assert.equal(roster.length, 3);
});
