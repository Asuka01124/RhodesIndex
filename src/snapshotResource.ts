export function createSnapshotResource<T>(load: () => Promise<T>) {
  let snapshot: { data: T | null; loading: boolean; error: string } = {
    data: null,
    loading: true,
    error: '',
  };
  let pending: Promise<void> | null = null;
  let checkedAt = -Infinity;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh(minAgeMs = 0) {
      if (pending) return pending;
      if (Date.now() - checkedAt < minAgeMs) return Promise.resolve();
      pending = Promise.resolve()
        .then(load)
        .then(
          (data) => {
            snapshot = { data, loading: false, error: '' };
          },
          (reason: unknown) => {
            snapshot = {
              ...snapshot,
              loading: false,
              error: reason instanceof Error ? reason.message : '数量读取失败',
            };
          },
        )
        .finally(() => {
          pending = null;
          checkedAt = Date.now();
          listeners.forEach((listener) => listener());
        });
      return pending;
    },
  };
}
