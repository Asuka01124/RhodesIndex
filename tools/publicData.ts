import { validateTagCounts } from '../src/tagCounts.ts';
import { validatePixivSummary } from '../src/pixiv.ts';
import { validateDouyinCounts } from '../src/douyinCounts.ts';
import { validateLofterCounts } from '../src/lofterCounts.ts';
import { validateWeiboCounts } from '../src/weiboCounts.ts';
import { validateXiaohongshuCounts } from '../src/xiaohongshuCounts.ts';
import { validateSklandCounts } from '../src/sklandCounts.ts';

export const PUBLIC_PLATFORMS = [
  'pixiv',
  'bilibili',
  'lofter',
  'douyin',
  'weibo',
  'xiaohongshu',
  'skland',
] as const;
export type PublicPlatform = (typeof PUBLIC_PLATFORMS)[number];
type ObjectData = Record<string, any>;
const META = [
  'platform',
  'schemaVersion',
  'kind',
  'generatedAt',
  'operatorIds',
  'workCount',
  'unknownYearCounts',
  'countOperatorIds',
  'countMethod',
  'countYearBasis',
  'countYears',
  'countGeneratedAt',
  'plannedTags',
  'availableTags',
  'missingTags',
  'plannedCharacters',
  'availableCharacters',
  'coverage',
  'timeBasis',
  'countBasis',
  'rule',
  'methodology',
  'plannedOperators',
  'metric',
  'primaryMetric',
  'totalTags',
  'readableTags',
  'totalOperators',
  'matchedOperators',
  'available',
];
const ROW = [
  'operatorId',
  'operatorIds',
  'operatorName',
  'sharedOperatorIds',
  'platform',
  'kind',
  'tag',
  'nativeTag',
  'tagId',
  'topicId',
  'topicName',
  'workCount',
  'playCount',
  'nativeViewCount',
  'status',
  'countBasis',
  'rule',
  'query',
  'searchTerms',
  'complete',
  'lowerBound',
  'observedAt',
  'publishedAt',
  'url',
  'apiSourceUrl',
  'sourceUrl',
  'sourceEndpoint',
  'timeBasis',
  'scope',
  'association',
  'coverageNote',
  'year',
  'workType',
  'rating',
  'likes',
  'views',
  'bookmarks',
  'comments',
  'sourceUrls',
];
const NATIVE_COUNT = ['display', 'exact', 'value', 'estimate', 'atLeast'];
const pick = (value: ObjectData, fields: readonly string[]) =>
  Object.fromEntries(
    fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
  );
const nativeCount = (value: unknown) =>
  value === null ? null : pick(value as ObjectData, NATIVE_COUNT);

export function stripPrivateFields(platform: PublicPlatform, input: ObjectData): ObjectData {
  if (!PUBLIC_PLATFORMS.includes(platform) || !Array.isArray(input.records)) {
    throw new Error('只接受已支持平台的汇总数据。');
  }
  const record = (value: ObjectData): ObjectData => {
    const result = pick(value, ROW);
    if (value.components) result.components = value.components.map(record);
    if (value.participation !== undefined) result.participation = nativeCount(value.participation);
    if (platform === 'lofter' && value.views !== undefined) result.views = nativeCount(value.views);
    if (value.nativeMetrics && platform === 'weibo') {
      result.nativeMetrics = Object.fromEntries(
        ['originalAuthors', 'discussions', 'reads'].map((key) => [
          key,
          nativeCount(value.nativeMetrics[key]),
        ]),
      );
    } else if (value.nativeMetrics && platform === 'xiaohongshu') {
      result.nativeMetrics = pick(value.nativeMetrics, ['view_num']);
    } else if (value.nativeMetrics && platform === 'skland') {
      result.nativeMetrics = pick(value.nativeMetrics, ['viewNum', 'publishNum', 'discussionNum']);
    }
    if (value.metricCoverage)
      result.metricCoverage = pick(value.metricCoverage, [
        'likes',
        'views',
        'bookmarks',
        'comments',
      ]);
    if (value.missingReason !== undefined)
      result.missingReason = value.missingReason ? '对应统计尚未取得。' : null;
    if (value.updateError !== undefined)
      result.updateError = value.updateError ? '最近刷新失败，保留此前统计。' : null;
    return result;
  };
  const output: ObjectData = {
    ...pick(input, ['schemaVersion', 'kind', 'platform', 'yearBasis']),
    metadata: pick(input.metadata, META),
    records: input.records.map(record),
  };
  if (input.countRecords) output.countRecords = input.countRecords.map(record);
  return output;
}

export function publicDataset(platform: PublicPlatform, input: ObjectData): ObjectData {
  const output = stripPrivateFields(platform, input);
  const validators = {
    pixiv: validatePixivSummary,
    bilibili: validateTagCounts,
    lofter: validateLofterCounts,
    douyin: validateDouyinCounts,
    weibo: validateWeiboCounts,
    xiaohongshu: validateXiaohongshuCounts,
    skland: validateSklandCounts,
  };
  validators[platform](output);
  const text = JSON.stringify(output);
  if (
    /-----BEGIN .*PRIVATE KEY-----|(?:SESSDATA|access_token|refresh_token)=|(?:[A-Z]:\\\\Users\\\\)/i.test(
      text,
    )
  ) {
    throw new Error('汇总中含不适合公开的会话或本机路径。');
  }
  return output;
}
