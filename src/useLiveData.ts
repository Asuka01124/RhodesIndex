import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollectorState, LiveDataset, PlatformId } from './types';

const EMPTY: LiveDataset = {
  schemaVersion: 1,
  yearBasis: 'publication_year',
  records: [],
  works: [],
  coverage: [],
  metadata: {
    kind: 'collected',
    generatedAt: null,
    coverage: 'partial',
    workCount: 0,
    operatorCount: 0,
    platformCount: 0,
    methodology: '尚未采集真实作品。',
  },
};

export function useLiveData(enabled = true) {
  const [live, setLive] = useState<LiveDataset>(EMPTY);
  const [state, setState] = useState<CollectorState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestRef = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch('/api/live-data', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
        throw new Error('本地采集服务未启动');
      const data = (await response.json()) as LiveDataset;
      if (data.metadata?.kind !== 'collected' || !Array.isArray(data.records))
        throw new Error('真实数据快照格式无效');
      setLive(data);
      const status = await fetch('/api/collection/status', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (status.ok) setState((await status.json()) as CollectorState);
      setError('');
    } catch {
      if (controller.signal.aborted) return;
      try {
        const response = await fetch('/data/live-heat.json', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('missing');
        const data = (await response.json()) as LiveDataset;
        if (data.metadata?.kind !== 'collected') throw new Error('invalid');
        setLive(data);
        setError('当前仅能读取本地快照，采集服务未运行。');
      } catch {
        setError('尚未取得真实数据。请使用本地开发服务，在“数据与来源”中开始采集。');
      }
      setState(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => {
      clearInterval(timer);
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [refresh, enabled]);
  const command = useCallback(async (action: 'start' | 'stop' | 'login', body: unknown = {}) => {
    const response = await fetch(`/api/collection/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '本地采集请求失败');
    setState(result as CollectorState);
    return result as CollectorState;
  }, []);
  return {
    live,
    state,
    error,
    loading,
    refresh,
    start: (platforms: PlatformId[], operatorIds: string[], limit: number) =>
      command('start', { platforms, operatorIds, limit }),
    stop: () => command('stop'),
    resume: () => command('start', { resume: true }),
    login: (platform: PlatformId) => command('login', { platform }),
  };
}
