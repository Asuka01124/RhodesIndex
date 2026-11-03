import type { LofterTagDataset, NativeTagCount, TagSummaryRow } from './types.ts';

function validCount(count: NativeTagCount | null): boolean {
  if (count === null) return true;
  if (!count || typeof count.display !== 'string' || typeof count.exact !== 'boolean') return false;
  if (
    ![count.value, count.estimate, count.atLeast].every(
      (n) => n === null || (Number.isSafeInteger(n) && n >= 0),
    )
  )
    return false;
  return count.exact
    ? count.value !== null && count.estimate === null
    : count.value === null && count.estimate !== null;
}

export function validateLofterCounts(input: unknown): LofterTagDataset {
  const data = input as LofterTagDataset;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.platform !== 'lofter' ||
    data.kind !== 'tag_summary' ||
    !Array.isArray(data.records) ||
    data.metadata?.timeBasis !== 'all_time_at_observation'
  )
    throw new Error('LOFTER标签统计格式无效。');
  const ids = new Set<string>();
  for (const row of data.records) {
    if (
      !row ||
      typeof row.operatorId !== 'string' ||
      ids.has(row.operatorId) ||
      typeof row.tag !== 'string' ||
      !validCount(row.views) ||
      !validCount(row.participation)
    )
      throw new Error('LOFTER标签记录重复或统计值无效。');
    ids.add(row.operatorId);
    if (row.url) {
      const url = new URL(row.url);
      if (url.protocol !== 'https:' || url.hostname !== 'www.lofter.com')
        throw new Error('LOFTER来源链接无效。');
    }
    if (
      (row.views || row.participation) &&
      (!row.observedAt || !Number.isFinite(Date.parse(row.observedAt)))
    )
      throw new Error('LOFTER统计缺少有效采集时间。');
  }
  return data;
}

export function lofterDisplayRows(
  data: LofterTagDataset | null,
  metric: 'participation' | 'views',
): TagSummaryRow[] {
  return (data?.records ?? []).map((row) => {
    const count = row[metric];
    return {
      operatorId: row.operatorId,
      tag: row.tag,
      nativeTag: row.tag,
      tagId: null,
      workCount: count?.value ?? count?.estimate ?? null,
      displayValue: count?.display,
      approximate: !!count && !count.exact,
      status: row.status,
      observedAt: row.observedAt,
      url: row.url,
      apiSourceUrl: row.url ?? '',
      missingReason: row.missingReason,
      updateError: row.updateError,
      nativeViews: row.views,
      nativeParticipation: row.participation,
    };
  });
}
