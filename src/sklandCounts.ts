import type { NativeTagCount, Operator, TagSummaryRow } from './types.ts';

export const SKLAND_METRICS = [
  { value: 'viewNum', label: '浏览' },
  { value: 'publishNum', label: '发帖' },
] as const;

export type SklandMetric = (typeof SKLAND_METRICS)[number]['value'];
export const SKLAND_METRIC_LABELS: Record<SklandMetric, string> = {
  viewNum: '话题浏览量',
  publishNum: '话题发帖数',
};
export const SKLAND_SEARCH_EXAMPLE =
  'https://www.skland.com/search?gameId=999&keyword=%E6%9C%9B&cate=3';

const FIELDS = ['viewNum', 'publishNum', 'discussionNum'] as const;
type Counts = Record<(typeof FIELDS)[number], number | null>;
const topicUrl = (id: number) => `https://www.skland.com/tag?id=${id}`;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

interface SklandRow {
  operatorId: string;
  operatorName: string;
  status: 'ok' | 'partial' | 'unavailable' | 'unmatched' | 'blocked' | 'failed' | 'pending';
  topicId: number | null;
  topicName: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  observedAt: string | null;
  nativeMetrics: Counts;
  missingReason: string | null;
}

interface SklandSnapshot {
  metadata: {
    platform: 'skland';
    schemaVersion: 1;
    timeBasis: 'all_time_at_observation';
    totalOperators: number;
    matchedOperators: number;
    available: Record<(typeof FIELDS)[number], number>;
    generatedAt: string;
  };
  records: SklandRow[];
}

export function validateSklandCounts(input: unknown): SklandSnapshot {
  const snapshot = input as SklandSnapshot;
  const metadata = snapshot?.metadata;
  if (
    metadata?.platform !== 'skland' ||
    metadata.schemaVersion !== 1 ||
    metadata.timeBasis !== 'all_time_at_observation' ||
    !isDate(metadata.generatedAt) ||
    !Array.isArray(snapshot.records) ||
    metadata.totalOperators !== snapshot.records.length
  )
    throw new Error('森空岛话题快照格式无效。');

  const operators = new Set<string>();
  const available = { viewNum: 0, publishNum: 0, discussionNum: 0 };
  let matched = 0;
  for (const row of snapshot.records) {
    if (
      typeof row?.operatorId !== 'string' ||
      !row.operatorId.trim() ||
      operators.has(row.operatorId) ||
      typeof row.operatorName !== 'string' ||
      !row.operatorName.trim() ||
      !row.nativeMetrics ||
      FIELDS.some((key) => {
        const value = row.nativeMetrics[key];
        return value !== null && (!Number.isSafeInteger(value) || value < 0);
      })
    )
      throw new Error('森空岛话题的干员标识或原生数值无效。');

    const count = FIELDS.filter((key) => row.nativeMetrics[key] !== null).length;
    if (row.topicId !== null) {
      const status = count === FIELDS.length ? 'ok' : count ? 'partial' : 'unavailable';
      if (
        !Number.isSafeInteger(row.topicId) ||
        row.topicId < 1 ||
        typeof row.topicName !== 'string' ||
        !row.topicName.trim() ||
        row.sourceUrl !== topicUrl(row.topicId) ||
        !isDate(row.observedAt) ||
        (row.publishedAt !== null && !isDate(row.publishedAt)) ||
        row.status !== status
      )
        throw new Error('森空岛话题缺少有效的来源、采集时间或采集状态。');
      matched++;
    } else if (
      count ||
      row.sourceUrl !== null ||
      row.topicName !== null ||
      row.publishedAt !== null ||
      row.observedAt !== null ||
      !['unmatched', 'blocked', 'failed', 'pending'].includes(row.status)
    ) {
      throw new Error('森空岛未匹配档案包含无来源的统计。');
    }
    if (
      row.status === 'ok'
        ? row.missingReason !== null
        : typeof row.missingReason !== 'string' || !row.missingReason.trim()
    )
      throw new Error('森空岛缺失统计需记录原因。');
    for (const key of FIELDS) if (row.nativeMetrics[key] !== null) available[key]++;
    operators.add(row.operatorId);
  }
  if (
    metadata.matchedOperators !== matched ||
    FIELDS.some((key) => metadata.available?.[key] !== available[key])
  )
    throw new Error('森空岛话题覆盖范围与记录不一致。');
  return snapshot;
}

function exact(value: number | null): NativeTagCount | null {
  return value === null
    ? null
    : { value, display: value.toLocaleString('zh-CN'), exact: true, estimate: null, atLeast: null };
}

export function sklandDisplayRows(
  data: SklandSnapshot | null,
  metric: SklandMetric,
): TagSummaryRow[] {
  const records = data?.records ?? [];
  const owners = new Map<number, string[]>();
  for (const { topicId, operatorId } of records) {
    if (topicId !== null) {
      const group = owners.get(topicId);
      if (group) group.push(operatorId);
      else owners.set(topicId, [operatorId]);
    }
  }
  return records.map((row) => {
    const count = row.nativeMetrics[metric];
    return {
      operatorId: row.operatorId,
      tag: row.topicName ?? row.operatorName,
      nativeTag: row.topicName ?? '',
      tagId: null,
      topicId: row.topicId?.toString() ?? null,
      sharedOperatorIds: row.topicId === null ? undefined : owners.get(row.topicId),
      status: row.status,
      workCount: count,
      displayValue: count?.toLocaleString('zh-CN'),
      observedAt: row.observedAt,
      publishedAt: row.publishedAt,
      nativeReads: exact(row.nativeMetrics.viewNum),
      nativePosts: exact(row.nativeMetrics.publishNum),
      nativeDiscussions: exact(row.nativeMetrics.discussionNum),
      url: row.sourceUrl,
      apiSourceUrl:
        row.topicId === null ? '' : `https://zonai.skland.com/web/v1/tag?id=${row.topicId}`,
      missingReason: row.missingReason,
      complete: count !== null,
      coverageNote: '森空岛话题的原生累计统计。',
    };
  });
}

export function sklandRoster(operators: Operator[], data: SklandSnapshot | null) {
  if (!data) return operators;
  const representatives = new Map<number, SklandRow>();
  for (const row of data.records) {
    if (row.topicId === null) continue;
    if (!representatives.has(row.topicId) || row.operatorName === row.topicName)
      representatives.set(row.topicId, row);
  }
  const shared = new Set(
    data.records
      .filter((row) => row.topicId !== null && representatives.get(row.topicId) !== row)
      .map((row) => row.operatorId),
  );
  return operators.filter((operator) => !shared.has(operator.id));
}
