import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotResource } from './snapshotResource.ts';

test('预加载和页面同时读取时共享请求，取消订阅后仍能使用数据', async () => {
  let requests = 0;
  let resolve!: (value: number) => void;
  const resource = createSnapshotResource(() => {
    requests++;
    return new Promise<number>((done) => {
      resolve = done;
    });
  });
  const preloaded = resource.refresh();
  assert.equal(resource.refresh(), preloaded);
  const unsubscribe = resource.subscribe(() => assert.fail('已取消的订阅不应收到更新'));
  unsubscribe();
  await Promise.resolve();
  resolve(42);
  await preloaded;

  assert.deepEqual(resource.getSnapshot(), { data: 42, loading: false, error: '' });
  await resource.refresh(5000);
  assert.equal(requests, 1);
});

test('刷新失败时保留已有快照，下次成功时更新数据并清除错误', async () => {
  const responses = [1, new Error('快照不可读'), 2];
  const resource = createSnapshotResource(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  await resource.refresh();
  const refreshing = resource.refresh();
  assert.deepEqual(resource.getSnapshot(), { data: 1, loading: false, error: '' });
  await refreshing;
  assert.deepEqual(resource.getSnapshot(), { data: 1, loading: false, error: '快照不可读' });
  await resource.refresh();
  assert.deepEqual(resource.getSnapshot(), { data: 2, loading: false, error: '' });
});
