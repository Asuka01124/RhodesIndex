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
export type Metric = 'likes' | 'views';
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

export interface Filters {
  professions: string[];
  factions: string[];
  gender: '全部' | Gender;
  minRarity: number;
}

export interface RankedOperator {
  operator: Operator;
  total: number;
  available: boolean;
  yearly: Record<number, number | null>;
}
