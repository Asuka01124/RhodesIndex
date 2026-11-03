import { compactNumber } from './domain.ts';
import type { DouyinTopicDataset, Operator, TagSummaryRow } from './types.ts';

export function validateDouyinCounts(input: unknown): DouyinTopicDataset {
  const data = input as DouyinTopicDataset;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.kind !== 'topic_summary' ||
    data.platform !== 'douyin' ||
    data.metadata?.metric !== 'native_view_count' ||
    data.metadata?.timeBasis !== 'all_time_at_observation' ||
    !Array.isArray(data.records)
  )
    throw new Error('抖音话题统计格式无效。');
  const owners = new Set<string>();
  const topics = new Set<string>();
  for (const row of data.records) {
    if (
      !row ||
      typeof row.operatorId !== 'string' ||
      !Array.isArray(row.operatorIds) ||
      !row.operatorIds.includes(row.operatorId) ||
      !row.operatorIds.length ||
      row.operatorIds.some((id) => typeof id !== 'string' || owners.has(id)) ||
      new Set(row.operatorIds).size !== row.operatorIds.length ||
      typeof row.tag !== 'string' ||
      !row.tag.trim() ||
      row.association !== 'exact_topic_name_only_operator_identity_unverified' ||
      (row.playCount !== null &&
        (!Number.isSafeInteger(row.playCount) ||
          row.playCount < 0 ||
          row.nativeViewCount !== row.playCount ||
          !row.topicId ||
          !/^[1-9][0-9]*$/.test(row.topicId) ||
          !row.observedAt ||
          !Number.isFinite(Date.parse(row.observedAt))))
    )
      throw new Error('抖音话题记录重复、原生计数无效或缺少来源时间。');
    row.operatorIds.forEach((id) => owners.add(id));
    if (row.topicId) {
      if (topics.has(row.topicId)) throw new Error('同一抖音话题不能重复加入排行。');
      topics.add(row.topicId);
    }
    for (const link of [row.url, row.apiSourceUrl]) {
      const url = new URL(link);
      if (
        url.protocol !== 'https:' ||
        !['creator.douyin.com', 'www.douyin.com'].includes(url.hostname)
      )
        throw new Error('抖音话题来源链接无效。');
    }
  }
  const available = data.records.filter((row) => row.playCount !== null).length;
  if (
    data.metadata.plannedTags !== data.records.length ||
    data.metadata.availableTags !== available ||
    data.metadata.missingTags !== data.records.length - available
  )
    throw new Error('抖音话题覆盖范围与记录不一致。');
  return data;
}

export function douyinDisplayRows(data: DouyinTopicDataset | null): TagSummaryRow[] {
  return (data?.records ?? []).map((row) => ({
    operatorId: row.operatorId,
    tag: row.tag,
    nativeTag: row.tag,
    tagId: null,
    workCount: row.playCount,
    displayValue: row.playCount === null ? undefined : compactNumber(row.playCount),
    topicId: row.topicId,
    sharedOperatorIds: row.operatorIds,
    status: row.status,
    observedAt: row.observedAt,
    url: row.url,
    apiSourceUrl: row.apiSourceUrl,
    missingReason: row.missingReason,
    complete: row.playCount !== null,
    coverageNote: '同名话题的累计播放量；角色归属尚待核实，不代表角色专属热度或作品数量。',
  }));
}

export function douyinRoster(operators: Operator[]): Operator[] {
  return operators.filter(
    (operator) => !['char_1001_amiya2', 'char_1037_amiya3'].includes(operator.id),
  );
}
