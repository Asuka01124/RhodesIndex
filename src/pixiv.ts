import type { Filters, HeatRecord, Metric } from './types.ts';

export const PIXIV_METRICS: { value: Metric; label: string }[] = [
  { value: 'views', label: '浏览' },
  { value: 'likes', label: '点赞' },
  { value: 'bookmarks', label: '收藏' },
  { value: 'comments', label: '评论' },
];
export const PIXIV_WORK_TYPES = ['插画', '漫画', '动图', '小说', '未标注'];
export const PIXIV_RATINGS = ['全年龄', 'R-18', 'R-18G', '未标注'];

export interface PixivSummary {
  schemaVersion: 1;
  yearBasis: 'publication_year';
  records: HeatRecord[];
  metadata: {
    kind: 'pixiv_completed_operators';
    generatedAt: string;
    operatorIds: string[];
    workCount: number;
  };
}

export function filterPixivRecords(records: HeatRecord[], filters: Filters): HeatRecord[] {
  return records.filter(
    (record) =>
      (!filters.workTypes?.length || filters.workTypes.includes(record.workType ?? '未标注')) &&
      (!filters.ratings?.length || filters.ratings.includes(record.rating ?? '未标注')),
  );
}

export function validatePixivSummary(value: unknown): PixivSummary {
  const data = value as PixivSummary | null;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.yearBasis !== 'publication_year' ||
    data.metadata?.kind !== 'pixiv_completed_operators' ||
    !Array.isArray(data.records) ||
    !Array.isArray(data.metadata.operatorIds) ||
    data.metadata.operatorIds.some((id) => typeof id !== 'string') ||
    !Number.isSafeInteger(data.metadata.workCount) ||
    data.metadata.workCount < 0 ||
    !Number.isFinite(Date.parse(data.metadata.generatedAt))
  ) {
    throw new Error('Pixiv 已完成干员快照格式无效。');
  }
  const completed = new Set(data.metadata.operatorIds);
  const keys = new Set<string>();
  for (const record of data.records) {
    if (
      !record ||
      record.platform !== 'pixiv' ||
      !completed.has(record.operatorId) ||
      !Number.isInteger(record.year) ||
      !PIXIV_WORK_TYPES.includes(record.workType ?? '') ||
      !PIXIV_RATINGS.includes(record.rating ?? '') ||
      !Array.isArray(record.sourceUrls) ||
      !record.sourceUrls.length ||
      record.sourceUrls.some(
        (url) => typeof url !== 'string' || !url.startsWith('https://www.pixiv.net/'),
      ) ||
      !Number.isFinite(Date.parse(record.observedAt)) ||
      PIXIV_METRICS.some(
        ({ value: metric }) =>
          record[metric] !== null &&
          (!Number.isSafeInteger(record[metric]) || Number(record[metric]) < 0),
      )
    ) {
      throw new Error('Pixiv 统计记录格式无效。');
    }
    const key = JSON.stringify([record.operatorId, record.year, record.workType, record.rating]);
    if (keys.has(key)) throw new Error('Pixiv 统计分组重复。');
    keys.add(key);
  }
  return data;
}
