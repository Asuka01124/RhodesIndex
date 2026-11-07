import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripPrivateFields } from './publicData.ts';
import { publicAssetFiles } from './publicAssets.ts';

test('公开导出丢弃原始作品、运行批次和任意私人字段，保留原生整数与缺失值', () => {
  const input = {
    metadata: { platform: 'bilibili', runId: 'local-run', plannedTags: 1 },
    works: [{ raw: true }],
    cookie: Symbol('private'),
    records: [
      {
        operatorId: 'a',
        tag: '甲',
        workCount: 123,
        observedAt: '2026-11-07T00:00:00Z',
        components: [{ tag: '甲', workCount: 123, privateSetting: true }],
        privateSetting: true,
      },
    ],
  };
  const output = stripPrivateFields('bilibili', input);
  assert.equal(output.records[0].workCount, 123);
  assert.equal(output.records[0].components[0].workCount, 123);
  assert.equal(output.works, undefined);
  assert.equal(output.cookie, undefined);
  assert.equal(output.metadata.runId, undefined);
  assert.equal(output.records[0].privateSetting, undefined);
  assert.equal(output.records[0].components[0].privateSetting, undefined);
  assert.equal(
    stripPrivateFields('pixiv', { metadata: {}, records: [{ views: null, likes: 0 }] }).records[0]
      .views,
    null,
  );
});
test('发布文件仅允许榜单汇总、名册、头像与图标，不能带入旧原始快照', () => {
  const files = publicAssetFiles([{ avatar: '/avatars/char_002_amiya.png' }]);
  assert.ok(files.includes('data/skland-tag-counts.json'));
  assert.ok(files.includes('avatars/char_002_amiya.png'));
  assert.ok(!files.includes('data/live-heat.json'));
  assert.ok(!files.some((file) => file.includes('.local') || file.includes('sqlite')));
  assert.throws(() => publicAssetFiles([{ avatar: '/avatars/../../private' }]));
});
