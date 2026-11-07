import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicUrl, snapshotUrls } from './publicUrls.ts';

test('Pages 子目录同时用于数据和头像，外部来源链接保持原样', () => {
  assert.equal(publicUrl('/avatars/a.png', '/RhodesIndex/'), '/RhodesIndex/avatars/a.png');
  assert.equal(
    publicUrl('data/operators.json', '/RhodesIndex/'),
    '/RhodesIndex/data/operators.json',
  );
  assert.equal(publicUrl('/avatars/a.png', '/'), '/avatars/a.png');
  assert.equal(publicUrl('https://prts.wiki/a', '/RhodesIndex/'), 'https://prts.wiki/a');
});
test('公开站只请求静态快照，本地开发才连接本机 API', () => {
  assert.deepEqual(snapshotUrls('skland', false, '/RhodesIndex/'), [
    '/RhodesIndex/data/skland-tag-counts.json',
  ]);
  assert.deepEqual(snapshotUrls('pixiv', true, '/'), [
    '/api/pixiv/tag-counts',
    '/data/pixiv-tag-counts.json',
  ]);
});
