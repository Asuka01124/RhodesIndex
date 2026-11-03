import { matchesOperator } from './domain.ts';
import type { BilibiliCountDataset, BilibiliTagCount, Filters, Operator } from './types.ts';

export function validateTagCounts(input: unknown): BilibiliCountDataset {
  const data = input as BilibiliCountDataset;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.kind !== 'tag_count' ||
    data.platform !== 'bilibili' ||
    data.metadata?.countBasis !== 'search_result_total' ||
    !Array.isArray(data.records) ||
    data.metadata?.timeBasis !== 'all_time_at_observation'
  ) {
    throw new Error('B站作品数量数据格式无效。');
  }
  const seen = new Set<string>();
  for (const row of data.records) {
    if (
      !row ||
      typeof row.operatorId !== 'string' ||
      seen.has(row.operatorId) ||
      typeof row.tag !== 'string' ||
      row.countBasis !== 'search_result_total' ||
      !Array.isArray(row.searchTerms) ||
      row.searchTerms.length < 2 ||
      row.searchTerms.some((term) => typeof term !== 'string' || !term.trim()) ||
      row.searchTerms[0] !== row.tag ||
      row.searchTerms[1] !== '明日方舟' ||
      row.query !== row.searchTerms.join(' ') ||
      (row.workCount !== null && (!Number.isSafeInteger(row.workCount) || row.workCount < 0))
    ) {
      throw new Error('B站数量记录重复或数值无效。');
    }
    seen.add(row.operatorId);
    for (const link of [row.url, row.apiSourceUrl]) {
      if (!link) continue;
      const url = new URL(link);
      if (
        url.protocol !== 'https:' ||
        !['www.bilibili.com', 'api.bilibili.com', 'search.bilibili.com'].includes(url.hostname)
      ) {
        throw new Error('B站数量来源链接无效。');
      }
    }
    if (
      row.workCount !== null &&
      (!row.observedAt || !Number.isFinite(Date.parse(row.observedAt)))
    ) {
      throw new Error('B站数量缺少有效采集时间。');
    }
  }
  return data;
}

export function rankTagCounts<T extends BilibiliTagCount>(
  operators: Operator[],
  records: T[],
  filters: Filters,
  query: string,
  sort: 'asc' | 'desc' = 'desc',
  favorites?: Set<string>,
) {
  const index = new Map(records.map((row) => [row.operatorId, row]));
  return operators
    .filter((o) => matchesOperator(o, filters, query) && (!favorites || favorites.has(o.id)))
    .map((operator) => ({ operator, record: index.get(operator.id) ?? null }))
    .sort((a, b) => {
      const av = a.record?.workCount ?? null,
        bv = b.record?.workCount ?? null;
      if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
      return (
        (sort === 'desc' ? (bv ?? 0) - (av ?? 0) : (av ?? 0) - (bv ?? 0)) ||
        a.operator.name.localeCompare(b.operator.name, 'zh-CN')
      );
    });
}
