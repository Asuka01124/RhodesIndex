import type { HeatRecord, Operator, PlatformId } from './types';
import { PLATFORM_IDS, YEARS } from './domain';

export const YEAR_COLORS: Record<number, string> = {
  2019: '#c8c4b3',
  2020: '#b0baa1',
  2021: '#87a99e',
  2022: '#749ca9',
  2023: '#919db9',
  2024: '#ad9eb4',
  2025: '#c8aa89',
  2026: '#d38863',
};
export const PROFESSIONS = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
export const PLATFORMS: {
  id: PlatformId;
  name: string;
  description: string;
  login: string;
  icon: string;
  color: string;
}[] = [
  {
    id: 'pixiv',
    name: 'Pixiv',
    description: '插画与漫画',
    login: '公开标签页可浏览，完整采集待核验',
    icon: 'pixiv',
    color: '#0096fa',
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    description: '视频与二创',
    login: '部分公开作品可浏览，搜索采集待核验',
    icon: 'bilibili',
    color: '#df7998',
  },
  {
    id: 'weibo',
    name: '微博',
    description: '图文与话题',
    login: '公开单帖可浏览，搜索采集待核验',
    icon: 'sinaweibo',
    color: '#db6d54',
  },
  {
    id: 'x',
    name: 'X',
    description: '创作者动态',
    login: '搜索需要登录',
    icon: 'x',
    color: '#222222',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    description: '视频与短片',
    login: '公开标签页可浏览，完整采集待核验',
    icon: 'youtube',
    color: '#d76b65',
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    description: '图文与生活创作',
    login: '搜索需要登录',
    icon: 'xiaohongshu',
    color: '#df7483',
  },
  {
    id: 'douyin',
    name: '抖音',
    description: '短视频创作',
    login: '公开单帖可浏览，搜索采集待核验',
    icon: 'tiktok',
    color: '#333333',
  },
  {
    id: 'lofter',
    name: 'LOFTER',
    description: '同人图文',
    login: '角色标签页需要登录',
    icon: 'pen',
    color: '#6e978a',
  },
  {
    id: 'tumblr',
    name: 'Tumblr',
    description: '海外同人创作',
    login: '公开标签页可浏览，完整采集待核验',
    icon: 'tumblr',
    color: '#526c82',
  },
  {
    id: 'bluesky',
    name: 'Bluesky',
    description: '创作者动态',
    login: '搜索需要登录',
    icon: 'bluesky',
    color: '#659ad5',
  },
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// 仅用于演示布局与交互，任何数值均不代表真实平台热度。
export function createDemoRecords(operators: Operator[]): HeatRecord[] {
  const spotlights: Record<string, number> = {
    蕾缪安: 12,
    能天使: 8.4,
    缄默德克萨斯: 9.2,
    阿米娅: 7.1,
    凯尔希: 8,
    维什戴尔: 11,
    W: 6.8,
    斯卡蒂: 6.1,
    银灰: 6.7,
    令: 6.3,
    夕: 5.3,
    莫斯提马: 5.1,
    浊心斯卡蒂: 6.2,
    拉普兰德: 5.2,
    德克萨斯: 4.9,
    玛恩纳: 5.7,
  };
  const platformWeights = [1, 0.92, 0.83, 0.73, 0.6, 0.53, 0.48, 0.4, 0.26, 0.17];
  const records: HeatRecord[] = [];
  for (const operator of operators) {
    const seed = hash(operator.id);
    const weight = spotlights[operator.name] ?? (0.1 + (seed % 1000) / 700) * (operator.rarity / 6);
    for (const [p, platform] of PLATFORM_IDS.entries()) {
      for (const year of YEARS) {
        const debuted = Number(operator.releaseDate.slice(0, 4));
        const historicalInterest = year < debuted ? 0.12 : 1;
        const variation = 0.5 + (hash(`${operator.id}-${platform}-${year}`) % 1000) / 1300;
        const recent = 0.55 + (year - 2019) * 0.12;
        const likes = Math.round(
          weight * 18500 * platformWeights[p] * variation * recent * historicalInterest,
        );
        const views = likes * (12 + (hash(`${operator.id}-${year}-${platform}-views`) % 35));
        records.push({
          operatorId: operator.id,
          platform,
          year,
          likes,
          views,
          sourceUrls: [],
          observedAt: '2026-11-01T00:00:00+08:00',
        });
      }
    }
  }
  return records;
}

export function platformSearch(platform: PlatformId, operator: Operator): string {
  const zh = encodeURIComponent(operator.name);
  const english = encodeURIComponent(operator.englishName || operator.name);
  const tag = encodeURIComponent(`#${operator.name}`);
  switch (platform) {
    case 'pixiv':
      return `https://www.pixiv.net/tags/${zh}/artworks`;
    case 'bilibili':
      return `https://search.bilibili.com/all?keyword=${zh}`;
    case 'weibo':
      return `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${operator.name}#`)}`;
    case 'x':
      return `https://x.com/search?q=${tag}&f=live`;
    case 'youtube':
      return `https://www.youtube.com/hashtag/${zh}`;
    case 'xiaohongshu':
      return `https://www.xiaohongshu.com/search_result?keyword=${zh}`;
    case 'douyin':
      return `https://www.douyin.com/search/${zh}`;
    case 'lofter':
      return `https://www.lofter.com/tag/${zh}`;
    case 'tumblr':
      return `https://www.tumblr.com/tagged/${english}`;
    case 'bluesky':
      return `https://bsky.app/search?q=${encodeURIComponent(`#${operator.englishName || operator.name}`)}`;
  }
}
