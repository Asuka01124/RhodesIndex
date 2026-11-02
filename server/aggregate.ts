import type { CollectionCoverage, HeatRecord, LiveDataset, WorkObservation } from '../src/types.ts';

export function aggregateWorks(
  input: WorkObservation[],
  coverage: CollectionCoverage[] = [],
): LiveDataset {
  const unique = new Map<string, WorkObservation>();
  for (const work of input) {
    const key = `${work.platform}:${work.id}`;
    const old = unique.get(key);
    const newest = !old || Date.parse(work.observedAt) >= Date.parse(old.observedAt) ? work : old;
    unique.set(key, {
      ...newest,
      operatorIds: [...new Set([...(old?.operatorIds ?? []), ...work.operatorIds])],
    });
  }
  const works = [...unique.values()];
  const records = new Map<string, HeatRecord>();
  for (const work of works) {
    const year = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(
        new Date(work.publishedAt),
      ),
    );
    for (const operatorId of new Set(work.operatorIds)) {
      const key = `${operatorId}|${work.platform}|${year}`;
      const row = records.get(key) ?? {
        operatorId,
        platform: work.platform,
        year,
        likes: null,
        views: null,
        sourceUrls: [],
        observedAt: work.observedAt,
        workCount: 0,
        metricCoverage: { likes: 0, views: 0 },
      };
      for (const metric of ['likes', 'views'] as const) {
        if (work[metric] !== null) {
          row[metric] = (row[metric] ?? 0) + work[metric];
          row.metricCoverage![metric]++;
        }
      }
      row.workCount!++;
      row.sourceUrls.push(work.url);
      if (Date.parse(work.observedAt) > Date.parse(row.observedAt))
        row.observedAt = work.observedAt;
      records.set(key, row);
    }
  }
  const latest = works.length
    ? new Date(Math.max(...works.map((w) => Date.parse(w.observedAt)))).toISOString()
    : null;
  return {
    schemaVersion: 1,
    yearBasis: 'publication_year',
    records: [...records.values()],
    works,
    coverage,
    metadata: {
      kind: 'collected',
      generatedAt: latest,
      coverage: 'partial',
      workCount: works.length,
      operatorCount: new Set(works.flatMap((w) => w.operatorIds)).size,
      platformCount: new Set(works.map((w) => w.platform)).size,
      methodology:
        '公开作品真实指标快照，仅覆盖已采集样本；按作品发布时间（北京时间）归年。同一平台作品对同一干员去重，跨干员关联可能重复，不代表全站总量或年度新增互动。',
    },
  };
}

export function exactOperatorMatch(
  tags: string[],
  title: string,
  operator: { name: string; englishName: string; japaneseName: string },
): boolean {
  const normalize = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  const native = new Set(tags.map(normalize));
  const specificForm = /[（(](近卫|医疗)[）)]/.test(operator.name);
  const names = (
    specificForm ? [operator.name] : [operator.name, operator.englishName, operator.japaneseName]
  ).filter(Boolean);
  const aliases = names
    .flatMap((name) => [
      name,
      `${name}(明日方舟)`,
      `${name}(アークナイツ)`,
      `${name}(Arknights)`,
      `明日方舟${name}`,
      `${name}明日方舟`,
    ])
    .map(normalize);
  const franchise =
    [...native].some((tag) => /明日方舟|アークナイツ|arknights/i.test(tag)) ||
    /明日方舟|アークナイツ|arknights/i.test(title);
  // W、Ash 等通用名字必须有作品语境；所有关联均要求角色原生标签命中。
  return franchise && aliases.some((alias) => native.has(alias));
}

export function exactCount(value: unknown): number | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
