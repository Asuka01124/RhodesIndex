import type { WeiboTopicRecord } from './weiboCounts.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeTagCount } from './types.ts';
import { validateWeiboCounts, weiboDisplayRows } from './weiboCounts.ts';

const exact = (value: number): NativeTagCount => ({
  display: String(value),
  exact: true,
  value,
  estimate: null,
  atLeast: null,
});
const approximate = (display: string, estimate: number | null, atLeast: number | null = null) => ({
  display,
  exact: false,
  value: null,
  estimate,
  atLeast,
});

function topic(
  id: string,
  tag: string,
  metrics: {
    originalAuthors?: NativeTagCount | null;
    discussions?: NativeTagCount | null;
    reads?: NativeTagCount | null;
  },
) {
  const originalAuthors = metrics.originalAuthors ?? null;
  return {
    platform: 'weibo' as const,
    kind: 'topic_summary' as const,
    tag,
    sourceUrl: `https://m.s.weibo.com/topic/detail?q=${encodeURIComponent(`#${tag}#`)}`,
    observedAt: '2026-11-04T00:00:00Z',
    publishedAt: null,
    timeBasis: 'all_time_at_observation' as const,
    nativeMetrics: {
      originalAuthors,
      discussions: metrics.discussions ?? null,
      reads: metrics.reads ?? null,
    },
    status: originalAuthors ? 'ok' : 'unavailable',
    missingReason: originalAuthors ? null : '话题页未提供原创人数。',
    operatorIds: [id],
    scope: tag.startsWith('明日方舟')
      ? ('arknights_prefixed_topic' as const)
      : ('bare_character_topic' as const),
  };
}

function snapshot(records: WeiboTopicRecord[]) {
  return {
    metadata: {
      platform: 'weibo' as const,
      primaryMetric: 'originalAuthors' as const,
      totalTags: records.length,
      readableTags: records.filter((row) => row.nativeMetrics.originalAuthors).length,
    },
    records,
  };
}

test('微博保留精确值、约数、下限和缺失，并支持切换指标', () => {
  const data = validateWeiboCounts(
    snapshot([
      topic('one', '明日方舟阿米娅', {
        originalAuthors: exact(414),
        discussions: approximate('2.4万', 24000),
        reads: approximate('100+', null, 100),
      }),
      topic('two', '明日方舟爱丽丝', { originalAuthors: exact(0) }),
      topic('missing', '明日方舟黍', {}),
    ]),
  );
  const authors = weiboDisplayRows(data);
  assert.equal(authors[0].workCount, 414);
  assert.equal(authors[0].displayValue, '414');
  assert.equal(authors[0].approximate, false);
  assert.equal(authors[1].workCount, 0);
  assert.equal(authors[2].workCount, null);
  assert.equal(authors[2].missingReason, '话题页未提供原创人数。');

  const discussions = weiboDisplayRows(data, 'discussions');
  assert.equal(discussions[0].workCount, 24000);
  assert.equal(discussions[0].displayValue, '2.4万');
  assert.equal(discussions[0].approximate, true);

  const reads = weiboDisplayRows(data, 'reads');
  assert.equal(reads[0].workCount, 100);
  assert.equal(reads[0].displayValue, '100');
  assert.equal(reads[0].lowerBound, true);
});

test('阿米娅各形态共用一条话题统计，只落到主形态', () => {
  const shared = topic('char_002_amiya', '阿米娅', { originalAuthors: exact(414) });
  shared.operatorIds = ['char_002_amiya', 'char_1001_amiya2', 'char_1037_amiya3'];
  const rows = weiboDisplayRows(validateWeiboCounts(snapshot([shared])));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operatorId, 'char_002_amiya');
  assert.equal(rows[0].nativeTag, '阿米娅');
  assert.deepEqual(rows[0].sharedOperatorIds, shared.operatorIds);
});

test('微博拒绝重复干员、重复话题和错误的覆盖范围', () => {
  const base = topic('one', '明日方舟阿米娅', { originalAuthors: exact(1) });
  assert.throws(() =>
    validateWeiboCounts(
      snapshot([
        base,
        {
          ...topic('two', '明日方舟爱丽丝', { originalAuthors: exact(2) }),
          operatorIds: ['one', 'two'],
        },
      ]),
    ),
  );
  assert.throws(() => validateWeiboCounts(snapshot([base, base])));
  const invalid = snapshot([base]);
  invalid.metadata.readableTags = 0;
  assert.throws(() => validateWeiboCounts(invalid));
});

test('微博拒绝错误来源、无效计数和缺失采集时间', () => {
  const base = topic('one', '明日方舟阿米娅', { originalAuthors: exact(1) });
  assert.throws(() =>
    validateWeiboCounts(snapshot([{ ...base, sourceUrl: 'https://other.example/topic/detail' }])),
  );
  assert.throws(() =>
    validateWeiboCounts(
      snapshot([
        topic('one', '明日方舟阿米娅', {
          originalAuthors: { ...exact(1), value: null, estimate: null },
        }),
      ]),
    ),
  );
  assert.throws(() => validateWeiboCounts(snapshot([{ ...base, observedAt: 'not-a-date' }])));
});

test('微博更新到最新一条有效采集时间', () => {
  const early = topic('one', '明日方舟阿米娅', { originalAuthors: exact(1) });
  const late = {
    ...topic('two', '明日方舟爱丽丝', { originalAuthors: exact(2) }),
    observedAt: '2026-11-05T00:00:00Z',
  };
  const data = validateWeiboCounts(snapshot([early, late]));
  assert.equal(data.metadata.generatedAt, '2026-11-05T00:00:00Z');
});

test('微博可显示同一批次中已取得和待采集的话题', () => {
  const pending = {
    ...topic('pending', '黍', {}),
    sourceUrl: undefined,
    timeBasis: undefined,
    status: 'pending',
    observedAt: null,
    missingReason: null,
  };
  const ready = topic('ready', '明日方舟爱丽丝', { originalAuthors: exact(5) });
  const rows = weiboDisplayRows(validateWeiboCounts(snapshot([ready, pending])));
  assert.equal(rows[0].workCount, 5);
  assert.equal(rows[1].workCount, null);
  assert.equal(rows[1].url, null);
});
