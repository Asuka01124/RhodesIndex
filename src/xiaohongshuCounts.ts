import { compactNumber } from './domain.ts';
import type { TagSummaryRow } from './types.ts';

const TOPIC_URL = 'https://www.xiaohongshu.com/page/topics/';
const TOPIC_SOURCE = 'https://edith.xiaohongshu.com/web_api/sns/v1/search/topic';
export const XIAOHONGSHU_METHOD = '榜单按角色话题的总浏览量排序。';

interface TopicRecord {
  tag: string;
  operatorIds: string[];
  scope: 'bare_character_topic' | 'arknights_prefixed_topic';
  topicId: string | null;
  url: string | null;
  sourceEndpoint?: string;
  nativeMetrics: { view_num: number | null };
  status: string;
  missingReason: string | null;
  observedAt: string | null;
}

interface TopicSnapshot {
  metadata: {
    platform: 'xiaohongshu';
    metric: 'view_num';
    totalTags: number;
    readableTags: number;
    totalOperators: number;
  };
  records: TopicRecord[];
}

export function validateXiaohongshuCounts(input: unknown) {
  const snapshot = input as TopicSnapshot;
  const metadata = snapshot?.metadata;
  if (
    metadata?.platform !== 'xiaohongshu' ||
    metadata.metric !== 'view_num' ||
    !Array.isArray(snapshot.records)
  )
    throw new Error('小红书话题快照格式无效。');

  const owners = new Set<string>();
  const topics = new Set<string>();
  const tags = new Set<string>();
  let availableTags = 0;
  let generatedAt: string | null = null;
  for (const row of snapshot.records) {
    const count = row?.nativeMetrics?.view_num;
    if (
      typeof row?.tag !== 'string' ||
      !row.tag.trim() ||
      tags.has(row.tag) ||
      (row.scope !== 'bare_character_topic' &&
        (row.scope !== 'arknights_prefixed_topic' || !/^明日方舟.+$/u.test(row.tag))) ||
      !Array.isArray(row.operatorIds) ||
      !row.operatorIds.length ||
      new Set(row.operatorIds).size !== row.operatorIds.length ||
      row.operatorIds.some((id) => typeof id !== 'string' || !id || owners.has(id)) ||
      (row.sourceEndpoint !== undefined && row.sourceEndpoint !== TOPIC_SOURCE) ||
      (row.topicId === null
        ? row.url !== null
        : typeof row.topicId !== 'string' ||
          !/^[0-9a-f]{24}$/.test(row.topicId) ||
          row.url !== TOPIC_URL + row.topicId ||
          topics.has(row.topicId)) ||
      (count !== null &&
        (typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          row.status !== 'ok' ||
          !row.topicId ||
          row.sourceEndpoint !== TOPIC_SOURCE ||
          !row.observedAt ||
          !Number.isFinite(Date.parse(row.observedAt))))
    )
      throw new Error('小红书话题记录的口径、计数或来源无效。');
    tags.add(row.tag);
    row.operatorIds.forEach((id) => owners.add(id));
    if (row.topicId) topics.add(row.topicId);
    if (count !== null) {
      availableTags++;
      if (row.observedAt && (!generatedAt || Date.parse(row.observedAt) > Date.parse(generatedAt)))
        generatedAt = row.observedAt;
    }
  }
  if (
    metadata.totalTags !== tags.size ||
    metadata.readableTags !== availableTags ||
    metadata.totalOperators !== owners.size
  )
    throw new Error('小红书话题覆盖范围与快照不一致。');
  return {
    records: snapshot.records,
    metadata: { availableTags, plannedTags: metadata.totalTags, generatedAt },
  };
}

export function xiaohongshuDisplayRows(
  data: ReturnType<typeof validateXiaohongshuCounts> | null,
): TagSummaryRow[] {
  return (data?.records ?? []).map((row) => {
    const views = row.nativeMetrics.view_num;
    return {
      operatorId: row.operatorIds.includes('char_002_amiya')
        ? 'char_002_amiya'
        : row.operatorIds[0],
      tag: row.tag,
      nativeTag: row.tag,
      tagId: null,
      workCount: views,
      displayValue: views === null ? undefined : compactNumber(views),
      topicId: row.topicId,
      sharedOperatorIds: row.operatorIds,
      status: row.status,
      observedAt: row.observedAt,
      url: row.url,
      apiSourceUrl: row.sourceEndpoint ?? '',
      missingReason: row.missingReason,
      complete: views !== null,
      coverageNote: '所选角色话题的累计浏览量',
    };
  });
}
