import type {
  Filters,
  HeatDataset,
  HeatRecord,
  Metric,
  Operator,
  RankedOperator,
  RarityTier,
  Scope,
} from './types.ts';

export const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
export const PLATFORM_IDS = [
  'pixiv',
  'bilibili',
  'weibo',
  'x',
  'youtube',
  'xiaohongshu',
  'douyin',
  'lofter',
  'tumblr',
  'bluesky',
] as const;
export const EMPTY_FILTERS: Filters = {
  professions: [],
  factions: [],
  gender: '全部',
  rarityTiers: [],
};
export const DEFAULT_FILTERS: Filters = { ...EMPTY_FILTERS, rarityTiers: [6] };

export function matchesRarityTier(rarity: number, tier: RarityTier): boolean {
  return tier === 3 ? rarity <= 3 : rarity === tier;
}

export function matchesOperator(operator: Operator, filters: Filters, query = ''): boolean {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
  const searchText = [
    operator.name,
    operator.englishName,
    operator.japaneseName,
    operator.profession,
    operator.branch,
    ...operator.factions,
  ]
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase();
  return (
    (!normalized || searchText.includes(normalized)) &&
    (!filters.professions.length || filters.professions.includes(operator.profession)) &&
    (!filters.factions.length || operator.factions.some((f) => filters.factions.includes(f))) &&
    (filters.gender === '全部' || operator.gender === filters.gender) &&
    (!filters.rarityTiers.length ||
      filters.rarityTiers.some((tier) => matchesRarityTier(operator.rarity, tier)))
  );
}

export function rankOperators(
  operators: Operator[],
  records: HeatRecord[],
  scope: Scope,
  metric: Metric,
  years: number[],
  filters: Filters,
  query: string,
  sort: 'desc' | 'asc' = 'desc',
  favorites?: Set<string>,
): RankedOperator[] {
  const filtered = operators.filter(
    (o) => matchesOperator(o, filters, query) && (!favorites || favorites.has(o.id)),
  );
  const index = new Map<string, RankedOperator>(
    filtered.map((operator) => [
      operator.id,
      {
        operator,
        total: 0,
        available: false,
        yearly: Object.fromEntries(years.map((y) => [y, null])),
      },
    ]),
  );
  const yearSet = new Set(years);
  for (const record of records) {
    if ((scope !== 'all' && record.platform !== scope) || !yearSet.has(record.year)) continue;
    const value = record[metric];
    const row = index.get(record.operatorId);
    if (!row || value === null) continue;
    row.available = true;
    row.total += value;
    row.yearly[record.year] = (row.yearly[record.year] ?? 0) + value;
  }
  return [...index.values()].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return (
      (sort === 'desc' ? b.total - a.total : a.total - b.total) ||
      a.operator.name.localeCompare(b.operator.name, 'zh-CN')
    );
  });
}

export function compactNumber(value: number): string {
  if (value >= 100_000_000)
    return `${(value / 100_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return Math.round(value).toLocaleString('zh-CN');
}

export function filterCount(filters: Filters): number {
  return filters.professions.length + filters.factions.length + Number(filters.gender !== '全部');
}

export function validateDataset(input: unknown, operators: Operator[]): HeatDataset {
  if (typeof input !== 'object' || input === null) throw new Error('文件应为 JSON 对象。');
  const object = input as Record<string, unknown>;
  if (object.schemaVersion !== 1 || object.yearBasis !== 'publication_year')
    throw new Error('请使用版本 1 的导入模板，年份口径应为 publication_year。');
  if (!Array.isArray(object.records) || !object.records.length || object.records.length > 50000)
    throw new Error('records 需要包含 1–50,000 条年度记录。');
  const ids = new Set(operators.map((o) => o.id));
  const seen = new Set<string>();
  const records: HeatRecord[] = [];
  for (const [i, unknownRecord] of object.records.entries()) {
    const error = (message: string): never => {
      throw new Error(`第 ${i + 1} 条：${message}`);
    };
    if (typeof unknownRecord !== 'object' || unknownRecord === null) error('记录格式无效。');
    const row = unknownRecord as Record<string, unknown>;
    if (typeof row.operatorId !== 'string' || !ids.has(row.operatorId))
      error('干员 ID 不在已收录档案中。');
    if (
      typeof row.platform !== 'string' ||
      !(PLATFORM_IDS as readonly string[]).includes(row.platform)
    )
      error('平台 ID 不受支持。');
    if (typeof row.year !== 'number' || !YEARS.includes(row.year))
      error('年份应为 2019–2026 之间的整数。');
    for (const metric of ['likes', 'views']) {
      const value = row[metric];
      if (
        value !== null &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      )
        error(`${metric} 应为非负安全整数，未提供时使用 null。`);
    }
    if (typeof row.observedAt !== 'string' || !Number.isFinite(Date.parse(row.observedAt)))
      error('observedAt 应为有效的统计时间。');
    if (
      !Array.isArray(row.sourceUrls) ||
      !row.sourceUrls.length ||
      row.sourceUrls.some((url) => {
        if (typeof url !== 'string') return true;
        try {
          return !['https:', 'http:'].includes(new URL(url).protocol);
        } catch {
          return true;
        }
      })
    )
      error('sourceUrls 应包含至少一个有效的 HTTP(S) 来源链接。');
    const key = `${row.operatorId}|${row.platform}|${row.year}`;
    if (seen.has(key)) error('同一干员、平台和年份重复，请先汇总后导入。');
    seen.add(key);
    records.push({
      operatorId: row.operatorId as string,
      platform: row.platform as HeatRecord['platform'],
      year: row.year as number,
      likes: row.likes as number | null,
      views: row.views as number | null,
      sourceUrls: row.sourceUrls as string[],
      observedAt: row.observedAt as string,
    });
  }
  return { schemaVersion: 1, yearBasis: 'publication_year', records };
}

export function csvEscape(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
