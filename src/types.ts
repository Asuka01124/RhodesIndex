export type PlatformId =
  | 'pixiv'
  | 'bilibili'
  | 'weibo'
  | 'x'
  | 'youtube'
  | 'xiaohongshu'
  | 'douyin'
  | 'lofter'
  | 'tumblr'
  | 'bluesky';
export type Scope = 'all' | PlatformId;
export type Metric = 'likes' | 'views' | 'bookmarks' | 'comments';
export type ViewMode = 'bars' | 'heatmap';
export type Gender = '女' | '男' | '其他';

export interface Operator {
  id: string;
  name: string;
  englishName: string;
  japaneseName: string;
  profession: string;
  branch: string;
  rarity: number;
  factions: string[];
  gender: Gender;
  originalGender: string;
  releaseDate: string;
  avatar: string;
  sourceUrl: string;
}

export interface HeatRecord {
  operatorId: string;
  platform: PlatformId;
  year: number;
  likes: number | null;
  views: number | null;
  bookmarks?: number | null;
  comments?: number | null;
  workType?: string;
  rating?: string;
  sourceUrls: string[];
  observedAt: string;
  workCount?: number;
  metricCoverage?: { likes: number; views: number };
}

export interface HeatDataset {
  schemaVersion: 1;
  yearBasis: 'publication_year';
  records: HeatRecord[];
}

export type DataMode = 'collected' | 'demo' | 'imported';

export interface WorkObservation {
  id: string;
  platform: PlatformId;
  title: string;
  url: string;
  publishedAt: string;
  likes: number | null;
  views: number | null;
  tags: string[];
  operatorIds: string[];
  matchBasis: 'exact_tag' | 'metadata_tag';
  nativeMetrics: Record<string, number | null>;
  observedAt: string;
}

export interface CollectionCoverage {
  platform: PlatformId;
  operatorId: string;
  status: 'sampled' | 'no_results' | 'blocked' | 'failed' | 'exhausted';
  candidates: number;
  matched: number;
  checkedAt: string;
  note: string;
}

export interface LiveDataset extends HeatDataset {
  metadata: {
    kind: 'collected';
    generatedAt: string | null;
    coverage: 'partial';
    workCount: number;
    operatorCount: number;
    platformCount: number;
    methodology: string;
  };
  works: WorkObservation[];
  coverage: CollectionCoverage[];
}

export interface CollectionJob {
  id: string;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  completed: number;
  total: number;
  current: string;
  message: string;
  errors: string[];
  plan?: { platforms: PlatformId[]; operatorIds: string[]; limit: number };
  completedKeys?: string[];
  active?: string[];
}

export interface CollectorState {
  available: boolean;
  supportedPlatforms: PlatformId[];
  job: CollectionJob | null;
  loginWindows: PlatformId[];
  snapshot: { workCount: number; operatorCount: number; generatedAt: string | null };
}

export type RarityTier = 3 | 4 | 5 | 6;

export interface Filters {
  professions: string[];
  factions: string[];
  gender: '全部' | Gender;
  rarityTiers: RarityTier[];
  workTypes?: string[];
  ratings?: string[];
}

export interface RankedOperator {
  operator: Operator;
  total: number;
  available: boolean;
  yearly: Record<number, number | null>;
}

export interface BilibiliTagCount {
  operatorId: string;
  tag: string;
  nativeTag: string;
  tagId: number | null;
  workCount: number | null;
  status: string;
  observedAt: string | null;
  url: string | null;
  apiSourceUrl: string;
  missingReason: string | null;
  updateError?: string | null;
  countBasis?: 'exact_tag_intersection' | 'search_result_total';
  query?: string;
  searchTerms?: string[];
  lowerBound?: boolean;
  countedWindows?: number;
  pendingWindows?: number;
  requiredTagGroups?: string[][];
  complete?: boolean;
  searchExhausted?: boolean;
  coverageNote?: string;
  scannedRows?: number;
  rejectedRows?: number;
}

export interface BilibiliCountDataset {
  schemaVersion: 1;
  kind: 'tag_count';
  platform: 'bilibili';
  records: BilibiliTagCount[];
  metadata: {
    plannedTags: number;
    availableTags: number;
    missingTags: number;
    coverage: 'configured_tags' | 'partial';
    generatedAt: string | null;
    timeBasis: 'all_time_at_observation';
    methodology: string;
    countBasis?: 'exact_tag_intersection' | 'search_result_total';
  };
}

export interface NativeTagCount {
  display: string;
  exact: boolean;
  value: number | null;
  estimate: number | null;
  atLeast: number | null;
}

export interface LofterTagRecord {
  operatorId: string;
  tag: string;
  url: string | null;
  views: NativeTagCount | null;
  participation: NativeTagCount | null;
  status: string;
  observedAt: string | null;
  missingReason: string | null;
  updateError?: string | null;
}

export interface LofterTagDataset {
  schemaVersion: 1;
  kind: 'tag_summary';
  platform: 'lofter';
  records: LofterTagRecord[];
  metadata: BilibiliCountDataset['metadata'];
}

export interface TagSummaryRow extends BilibiliTagCount {
  displayValue?: string;
  approximate?: boolean;
  nativeViews?: NativeTagCount | null;
  nativeParticipation?: NativeTagCount | null;
  topicId?: string | null;
  sharedOperatorIds?: string[];
  nativeOriginalAuthors?: NativeTagCount | null;
  nativeDiscussions?: NativeTagCount | null;
  nativeReads?: NativeTagCount | null;
  nativePosts?: NativeTagCount | null;
  publishedAt?: string | null;
}

export interface DouyinTopicRecord {
  operatorId: string;
  operatorIds: string[];
  tag: string;
  topicId: string | null;
  playCount: number | null;
  nativeViewCount: number | null;
  status: string;
  observedAt: string | null;
  url: string;
  apiSourceUrl: string;
  missingReason: string | null;
  association: 'exact_topic_name_only_operator_identity_unverified';
}

export interface DouyinTopicDataset {
  schemaVersion: 1;
  kind: 'topic_summary';
  platform: 'douyin';
  records: DouyinTopicRecord[];
  metadata: BilibiliCountDataset['metadata'] & {
    plannedOperators: number;
    metric: 'native_view_count';
  };
}
