import type { DouyinTopicRecord, Operator } from './types';

// 同名话题无法确认角色归属；播放量达到10亿的通常已混入大量无关内容。
export const DOUYIN_HIDE_MIN_PLAY_COUNT = 1_000_000_000;

export function hideAmbiguousDouyinTopics(
  operators: Operator[],
  hide: boolean,
  records: readonly DouyinTopicRecord[] = [],
): Operator[] {
  if (!hide) return operators;
  const hidden = new Set<string>();
  for (const record of records) {
    if (record.playCount !== null && record.playCount >= DOUYIN_HIDE_MIN_PLAY_COUNT)
      record.operatorIds.forEach((id) => hidden.add(id));
  }
  return operators.filter((operator) => !hidden.has(operator.id));
}
