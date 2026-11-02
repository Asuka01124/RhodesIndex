import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateWorks, exactCount, exactOperatorMatch } from './aggregate.ts';
import type { WorkObservation } from '../src/types.ts';

test('组合角色标签必须精确匹配，不能把角色名的子串计入', () => {
  const operator = { name: '能天使', englishName: 'Exusiai', japaneseName: 'エクシア' };
  assert.equal(exactOperatorMatch(['明日方舟能天使'], '', operator), true);
  assert.equal(exactOperatorMatch(['エクシア(アークナイツ)'], '', operator), true);
  assert.equal(exactOperatorMatch(['明日方舟', '能天使姐姐'], '', operator), false);
  assert.equal(
    exactOperatorMatch(['(アークナイツ)'], '', {
      name: '测试角色',
      englishName: '',
      japaneseName: '',
    }),
    false,
  );
});

const work: WorkObservation = {
  id: 'sample',
  platform: 'pixiv',
  title: '明日方舟角色插画',
  url: 'https://www.pixiv.net/artworks/1',
  publishedAt: '2025-05-01T00:00:00Z',
  likes: 12,
  views: 100,
  tags: ['明日方舟', '蕾缪安'],
  operatorIds: ['lemuen'],
  matchBasis: 'exact_tag',
  nativeMetrics: { likeCount: 12, bookmarkCount: 30 },
  observedAt: '2026-11-01T00:00:00Z',
};

test('刷新同一作品取最新快照，不重复叠加点赞或观看量', () => {
  const latest = { ...work, likes: 15, views: 120, observedAt: '2026-11-01T01:00:00Z' };
  const data = aggregateWorks([latest, work, latest]);
  assert.equal(data.metadata.workCount, 1);
  assert.equal(data.records[0].likes, 15);
  assert.equal(data.records[0].views, 120);
  assert.equal(data.records[0].workCount, 1);
});

test('同平台作品对同干员去重，跨干员关联分别保留', () => {
  const data = aggregateWorks([work, { ...work, operatorIds: ['lemuen', 'exusiai'] }]);
  assert.equal(data.metadata.workCount, 1);
  assert.equal(data.metadata.operatorCount, 2);
  assert.equal(data.records.length, 2);
  assert.deepEqual(
    data.records.map((row) => row.likes),
    [12, 12],
  );
});

test('发布时间按北京时间跨年，采集时间不作为发布年份', () => {
  const data = aggregateWorks([{ ...work, publishedAt: '2024-12-31T17:00:00Z' }]);
  assert.equal(data.records[0].year, 2025);
});

test('空值不当作零，真实零值计入指标覆盖，收藏不计入点赞', () => {
  const missing = aggregateWorks([{ ...work, likes: null, views: 0 }]).records[0];
  assert.equal(missing.likes, null);
  assert.equal(missing.views, 0);
  assert.deepEqual(missing.metricCoverage, { likes: 0, views: 1 });
  assert.equal(aggregateWorks([work]).records[0].likes, 12);
});

test('标题命中不等同于原生标签，短名字需明日方舟语境', () => {
  const operator = { name: '蕾缪安', englishName: 'Lemuen', japaneseName: 'レミュアン' };
  assert.equal(exactOperatorMatch(['明日方舟'], '蕾缪安绘画', operator), false);
  assert.equal(exactOperatorMatch(['明日方舟', 'Lemuen'], '插画', operator), true);
  assert.equal(
    exactOperatorMatch(['W'], '普通字母练习', { name: 'W', englishName: 'W', japaneseName: 'W' }),
    false,
  );
});

test('未实测指标、缩写数值和非法计数不能伪装成精确数字', () => {
  assert.equal(exactCount(undefined), null);
  assert.equal(exactCount('1.2万'), null);
  assert.equal(exactCount(-1), null);
  assert.equal(exactCount('315'), 315);
  assert.equal(exactCount(0), 0);
});

test('阿米娅不同职业形态不借同一个外文名混算', () => {
  assert.equal(
    exactOperatorMatch(['明日方舟', '阿米娅', 'Amiya'], '插画', {
      name: '阿米娅(医疗)',
      englishName: 'Amiya',
      japaneseName: 'アーミヤ',
    }),
    false,
  );
  assert.equal(
    exactOperatorMatch(['明日方舟', '阿米娅(医疗)'], '插画', {
      name: '阿米娅(医疗)',
      englishName: 'Amiya',
      japaneseName: 'アーミヤ',
    }),
    true,
  );
});
