import { useEffect, useState } from 'react';
import type { BilibiliCountDataset } from './types';
import { validateTagCounts } from './tagCounts';
import type { LofterTagDataset } from './types';
import { validateLofterCounts } from './lofterCounts';
import type { DouyinTopicDataset } from './types';
import { validateDouyinCounts } from './douyinCounts';

function useTagSnapshot<T>(
  platform: 'bilibili' | 'lofter' | 'douyin',
  validate: (value: unknown) => T,
  enabled: boolean,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        let next: T | null = null;
        for (const url of [`/api/${platform}/tag-counts`, `/data/${platform}-tag-counts.json`]) {
          try {
            const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('暂时无法读取');
            next = validate(await response.json());
            break;
          } catch {
            if (controller.signal.aborted) return;
          }
        }
        if (!next)
          throw new Error(
            `暂时无法读取${platform === 'lofter' ? 'LOFTER标签统计' : platform === 'douyin' ? '抖音话题播放量' : 'B站搜索结果数'}，请检查本地采集快照。`,
          );
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '数量读取失败');
      } finally {
        busy = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [platform, validate, enabled]);
  return { data, loading, error };
}

export function useTagCounts(enabled = true) {
  return useTagSnapshot<BilibiliCountDataset>('bilibili', validateTagCounts, enabled);
}

export function useLofterTagCounts(enabled = true) {
  return useTagSnapshot<LofterTagDataset>('lofter', validateLofterCounts, enabled);
}

export function useDouyinTopicCounts(enabled = true) {
  return useTagSnapshot<DouyinTopicDataset>('douyin', validateDouyinCounts, enabled);
}
