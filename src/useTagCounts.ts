import { useEffect, useSyncExternalStore } from 'react';
import { validateTagCounts } from './tagCounts';
import { validateLofterCounts } from './lofterCounts';
import { validateDouyinCounts } from './douyinCounts';
import { validateXiaohongshuCounts } from './xiaohongshuCounts';
import { validateWeiboCounts } from './weiboCounts';
import { validateSklandCounts } from './sklandCounts';
import { createSnapshotResource } from './snapshotResource';
import { validatePixivSummary } from './pixiv';

const REFRESH_INTERVAL = 5000;

const SNAPSHOT_LABELS = {
  pixiv: 'Pixiv作品统计',
  bilibili: 'B站搜索结果数',
  lofter: 'LOFTER标签统计',
  douyin: '抖音话题播放量',
  xiaohongshu: '小红书话题浏览量',
  weibo: '微博话题原创人数',
};

function makeTagResource<T>(
  platform: keyof typeof SNAPSHOT_LABELS,
  validate: (value: unknown) => T,
) {
  return createSnapshotResource(async () => {
    for (const url of [`/api/${platform}/tag-counts`, `/data/${platform}-tag-counts.json`]) {
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) return validate(await response.json());
      } catch {
        // 本地接口不可用时尝试静态快照。
      }
    }
    throw new Error(`暂时无法读取${SNAPSHOT_LABELS[platform]}，请检查本地采集快照。`);
  });
}

const tagResources = {
  pixiv: makeTagResource('pixiv', validatePixivSummary),
  bilibili: makeTagResource('bilibili', validateTagCounts),
  lofter: makeTagResource('lofter', validateLofterCounts),
  douyin: makeTagResource('douyin', validateDouyinCounts),
  xiaohongshu: makeTagResource('xiaohongshu', validateXiaohongshuCounts),
  weibo: makeTagResource('weibo', validateWeiboCounts),
};

const sklandResource = createSnapshotResource(async () => {
  const response = await fetch('/api/skland/tag-counts', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('暂时无法读取森空岛的本地话题快照。');
  return validateSklandCounts(await response.json());
});

const subscribeDisabled = () => () => {};

function useTagSnapshot<T>(
  resource: ReturnType<typeof createSnapshotResource<T>>,
  enabled: boolean,
) {
  const snapshot = useSyncExternalStore(
    enabled ? resource.subscribe : subscribeDisabled,
    resource.getSnapshot,
  );
  useEffect(() => {
    if (!enabled) return;
    void resource.refresh(REFRESH_INTERVAL);
    const timer = window.setInterval(() => void resource.refresh(), REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [resource, enabled]);
  return snapshot;
}

export function preloadTagSnapshots() {
  const preload = () => {
    for (const resource of Object.values(tagResources)) void resource.refresh(REFRESH_INTERVAL);
  };
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(preload, { timeout: 1500 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(preload, 250);
  return () => window.clearTimeout(handle);
}

export function useTagCounts(enabled = true) {
  return useTagSnapshot(tagResources.bilibili, enabled);
}

export function useLofterTagCounts(enabled = true) {
  return useTagSnapshot(tagResources.lofter, enabled);
}

export function useDouyinTopicCounts(enabled = true) {
  return useTagSnapshot(tagResources.douyin, enabled);
}

export function useXiaohongshuTopicCounts(enabled = true) {
  return useTagSnapshot(tagResources.xiaohongshu, enabled);
}

export function useWeiboTagCounts(enabled = true) {
  return useTagSnapshot(tagResources.weibo, enabled);
}

export function useSklandTagCounts(enabled = true) {
  return useTagSnapshot(sklandResource, enabled);
}

export function usePixivSummary(enabled = true) {
  return useTagSnapshot(tagResources.pixiv, enabled);
}
