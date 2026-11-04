import type { NativeTagCount, TagSummaryRow } from './types.ts';

const PREFIXED_TOPIC_PATTERN = /^明日方舟.+$/u;
const SOURCE_HOST = 'm.s.weibo.com';

export const WEIBO_METRICS = [
  { value: 'originalAuthors', label: '原创' },
  { value: 'discussions', label: '讨论' },
  { value: 'reads', label: '阅读' },
] as const;

export type WeiboMetric = (typeof WEIBO_METRICS)[number]['value'];

export const WEIBO_METRIC_LABELS: Record<WeiboMetric, string> = {
  originalAuthors: '原创人数',
  discussions: '讨论次数',
  reads: '阅读次数',
};

export const WEIBO_METHOD =
  '微博和小红书使用同一套话题规则。多数角色用本名，容易撞名的角色加「明日方舟」。';

export interface WeiboTopicRecord {
  platform: 'weibo';
  kind: 'topic_summary';
  tag: string;
  sourceUrl?: string;
  observedAt: string | null;
  publishedAt: string | null;
  timeBasis?: 'all_time_at_observation';
  nativeMetrics: {
    originalAuthors: NativeTagCount | null;
    discussions: NativeTagCount | null;
    reads: NativeTagCount | null;
  };
  status: string;
  missingReason: string | null;
  operatorIds: string[];
  scope: 'arknights_prefixed_topic' | 'bare_character_topic';
}

interface WeiboSnapshot {
  metadata: {
    platform: 'weibo';
    primaryMetric: 'originalAuthors';
    totalTags: number;
    readableTags: number;
  };
  records: WeiboTopicRecord[];
}

function checkNative(value: NativeTagCount | null | undefined, label: string) {
  if (value === null) return;
  if (
    !value ||
    typeof value.display !== 'string' ||
    !value.display.trim() ||
    typeof value.exact !== 'boolean'
  )
    throw new Error(`微博${label}的显示值无效。`);
  for (const number of [value.value, value.estimate, value.atLeast]) {
    if (number !== null && (!Number.isSafeInteger(number) || number < 0))
      throw new Error(`微博${label}不是可保存的非负整数。`);
  }
  if (value.exact) {
    if (value.value === null || value.estimate !== null || value.atLeast !== null)
      throw new Error(`微博${label}的精确值不完整。`);
  } else if (value.value !== null || (value.estimate === null && value.atLeast === null)) {
    throw new Error(`微博${label}的约数缺少估值。`);
  }
}

function checkSource(tag: string, link: string) {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error('微博话题来源链接无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== SOURCE_HOST ||
    url.pathname !== '/topic/detail' ||
    url.searchParams.get('q') !== `#${tag}#`
  )
    throw new Error('微博话题来源与话题名不一致。');
}

export function validateWeiboCounts(input: unknown) {
  const snapshot = input as WeiboSnapshot;
  const metadata = snapshot?.metadata;
  if (
    metadata?.platform !== 'weibo' ||
    metadata.primaryMetric !== 'originalAuthors' ||
    !Array.isArray(snapshot.records)
  )
    throw new Error('微博话题快照格式无效。');

  const tags = new Set<string>();
  const owners = new Set<string>();
  let availableTags = 0;
  let generatedAt: string | null = null;
  for (const row of snapshot.records) {
    if (
      !row ||
      row.platform !== 'weibo' ||
      row.kind !== 'topic_summary' ||
      typeof row.tag !== 'string' ||
      !row.tag.trim() ||
      row.tag !== row.tag.trim() ||
      row.tag.includes('#') ||
      tags.has(row.tag) ||
      (row.scope !== 'bare_character_topic' &&
        (row.scope !== 'arknights_prefixed_topic' || !PREFIXED_TOPIC_PATTERN.test(row.tag))) ||
      !Array.isArray(row.operatorIds) ||
      !row.operatorIds.length ||
      new Set(row.operatorIds).size !== row.operatorIds.length ||
      row.operatorIds.some((id) => typeof id !== 'string' || !id || owners.has(id)) ||
      !row.nativeMetrics ||
      typeof row.nativeMetrics !== 'object' ||
      (row.missingReason !== null && typeof row.missingReason !== 'string') ||
      (row.observedAt !== null && !Number.isFinite(Date.parse(row.observedAt)))
    )
      throw new Error('微博话题记录重复或覆盖范围无效。');
    const awaitingData = ['pending', 'failed', 'blocked', 'cancelled'].includes(row.status);
    if (awaitingData) {
      if (
        row.sourceUrl !== undefined ||
        row.observedAt !== null ||
        Object.values(row.nativeMetrics).some((count) => count !== null)
      )
        throw new Error('微博未取得的话题不能携带统计数值。');
    } else {
      if (row.timeBasis !== 'all_time_at_observation' || !row.sourceUrl)
        throw new Error('微博话题缺少统计口径或来源。');
      checkSource(row.tag, row.sourceUrl);
    }
    checkNative(row.nativeMetrics.originalAuthors, '原创人数');
    checkNative(row.nativeMetrics.discussions, '讨论次数');
    checkNative(row.nativeMetrics.reads, '阅读次数');

    const authors = row.nativeMetrics.originalAuthors;
    if (authors === null) {
      if (!awaitingData && (row.status !== 'unavailable' || !row.missingReason))
        throw new Error('微博缺失统计必须标明不可用原因。');
    } else {
      if (!['ok', 'partial'].includes(row.status)) throw new Error('微博可读统计的状态无效。');
      if (!row.observedAt || !Number.isFinite(Date.parse(row.observedAt)))
        throw new Error('微博可读统计缺少有效采集时间。');
      availableTags++;
    }
    if (row.observedAt && (!generatedAt || Date.parse(row.observedAt) > Date.parse(generatedAt)))
      generatedAt = row.observedAt;
    tags.add(row.tag);
    row.operatorIds.forEach((id) => owners.add(id));
  }
  if (
    metadata.totalTags !== tags.size ||
    metadata.readableTags !== availableTags ||
    snapshot.records.length !== tags.size
  )
    throw new Error('微博话题覆盖范围与快照不一致。');
  return {
    records: snapshot.records,
    metadata: { availableTags, plannedTags: metadata.totalTags, generatedAt },
  };
}

export function weiboMetricValue(count: NativeTagCount | null): number | null {
  if (!count) return null;
  return count.exact ? count.value : (count.estimate ?? count.atLeast);
}

export function weiboDisplayRows(
  data: ReturnType<typeof validateWeiboCounts> | null,
  metric: WeiboMetric = 'originalAuthors',
): TagSummaryRow[] {
  return (data?.records ?? []).map((row) => {
    const count = row.nativeMetrics[metric];
    const value = weiboMetricValue(count);
    return {
      operatorId: row.operatorIds.includes('char_002_amiya')
        ? 'char_002_amiya'
        : row.operatorIds[0],
      tag: row.tag,
      nativeTag: row.tag,
      tagId: null,
      workCount: value,
      displayValue: count
        ? count.atLeast !== null
          ? count.display.replace(/\+$/, '')
          : count.display
        : undefined,
      approximate: count ? !count.exact : undefined,
      lowerBound: count ? count.atLeast !== null : undefined,
      topicId: null,
      sharedOperatorIds: row.operatorIds,
      status: row.status,
      observedAt: row.observedAt,
      url: row.sourceUrl ?? null,
      apiSourceUrl: '',
      missingReason: row.missingReason,
      complete: value !== null,
      coverageNote: '所选角色话题的原生统计，仅适合比较相对热度。',
      nativeOriginalAuthors: row.nativeMetrics.originalAuthors,
      nativeDiscussions: row.nativeMetrics.discussions,
      nativeReads: row.nativeMetrics.reads,
    };
  });
}
