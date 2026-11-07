import type { PlatformId } from './types';

export const YEAR_COLORS: Record<number, string> = {
  2019: '#c7c7cc',
  2020: '#66d4cf',
  2021: '#6ac4dc',
  2022: '#4a9eff',
  2023: '#7d7aff',
  2024: '#c38ff0',
  2025: '#ff8fab',
  2026: '#ff9f45',
};
export const PROFESSIONS = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
export const PLATFORMS: {
  id: PlatformId;
  name: string;
  icon: string;
}[] = [
  {
    id: 'pixiv',
    name: 'Pixiv',
    icon: 'pixiv',
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    icon: 'bilibili',
  },
  {
    id: 'weibo',
    name: '微博',
    icon: 'sinaweibo',
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    icon: 'xiaohongshu',
  },
  {
    id: 'douyin',
    name: '抖音',
    icon: 'tiktok',
  },
  {
    id: 'lofter',
    name: 'LOFTER',
    icon: 'pen',
  },
];
