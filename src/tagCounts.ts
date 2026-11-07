import { matchesOperator } from './domain.ts';
import type { BilibiliCountDataset, BilibiliTagCount, Filters, Operator } from './types.ts';

export function validateTagCounts(input: unknown): BilibiliCountDataset {
  const data = input as BilibiliCountDataset;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.kind !== 'tag_count' ||
    data.platform !== 'bilibili' ||
    data.metadata?.countBasis !== 'native_tag_use_sum' ||
    data.metadata?.timeBasis !== 'all_time_at_observation' ||
    !Array.isArray(data.records)
  ) {
    throw new Error('B站单 TAG 统计格式无效，旧搜索数据不能混用。');
  }
  const owners = new Set<string>();
  const tags = new Set<string>();
  let availableTags = 0;
  const validCount = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const checkLink = (link: string | null | undefined) => {
    if (!link) return;
    const url = new URL(link);
    if (
      url.protocol !== 'https:' ||
      !['www.bilibili.com', 'api.bilibili.com'].includes(url.hostname)
    ) {
      throw new Error('B站数量来源链接无效。');
    }
  };
  for (const row of data.records) {
    if (
      !row ||
      typeof row.operatorId !== 'string' ||
      typeof row.tag !== 'string' ||
      row.countBasis !== 'native_tag_use_sum' ||
      !Array.isArray(row.sharedOperatorIds) ||
      !row.sharedOperatorIds.includes(row.operatorId) ||
      new Set(row.sharedOperatorIds).size !== row.sharedOperatorIds.length ||
      row.sharedOperatorIds.some((id) => typeof id !== 'string' || owners.has(id)) ||
      !Array.isArray(row.components) ||
      !row.components.length
    ) {
      throw new Error('B站合并角色记录或形态归属无效。');
    }
    row.sharedOperatorIds.forEach((id) => owners.add(id));
    const values: number[] = [];
    for (const part of row.components) {
      if (
        !part ||
        typeof part.tag !== 'string' ||
        !part.tag.trim() ||
        tags.has(part.tag) ||
        (part.workCount !== null &&
          (!validCount(part.workCount) ||
            !validCount(part.tagId) ||
            !part.observedAt ||
            !Number.isFinite(Date.parse(part.observedAt))))
      ) {
        throw new Error('B站单 TAG 重复、数值或来源时间无效。');
      }
      tags.add(part.tag);
      checkLink(part.url);
      checkLink(part.apiSourceUrl);
      if (part.workCount !== null) {
        values.push(part.workCount);
        availableTags++;
      }
    }
    const expected = values.length ? values.reduce((a, b) => a + b, 0) : null;
    const complete = values.length === row.components.length;
    if (
      row.workCount !== expected ||
      (expected !== null && !validCount(expected)) ||
      row.complete !== complete ||
      row.lowerBound !== (values.length > 0 && !complete) ||
      (expected !== null && (!row.observedAt || !Number.isFinite(Date.parse(row.observedAt))))
    ) {
      throw new Error('B站角色合计与各形态 TAG 小计不一致。');
    }
    checkLink(row.url);
    checkLink(row.apiSourceUrl);
  }
  if (
    data.metadata.plannedTags !== tags.size ||
    data.metadata.availableTags !== availableTags ||
    data.metadata.missingTags !== tags.size - availableTags
  ) {
    throw new Error('B站采集覆盖范围与单 TAG 记录不一致。');
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
  const mergedMembers = new Set(
    records
      .filter((row) => row.countBasis === 'native_tag_use_sum')
      .flatMap((row) => row.sharedOperatorIds?.filter((id) => id !== row.operatorId) ?? []),
  );
  const operatorIndex = new Map(operators.map((o) => [o.id, o]));
  return operators
    .filter((o) => !mergedMembers.has(o.id))
    .filter((o) => {
      const row = index.get(o.id);
      const members =
        row?.countBasis === 'native_tag_use_sum'
          ? (row.sharedOperatorIds ?? [o.id])
              .map((id) => operatorIndex.get(id))
              .filter((v): v is Operator => !!v)
          : [o];
      return (
        members.some((member) => matchesOperator(member, filters, query)) &&
        (!favorites || members.some((member) => favorites.has(member.id)))
      );
    })
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
