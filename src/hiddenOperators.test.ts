import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearHiddenOperators,
  isOperatorHidden,
  normalizeHiddenByPlatform,
  restoreHiddenOperator,
  toggleHiddenOperator,
} from './hiddenOperators.ts';

test('normalizeHiddenByPlatform 过滤无效输入并按平台去重', () => {
  assert.deepEqual(normalizeHiddenByPlatform(null), {});
  assert.deepEqual(normalizeHiddenByPlatform(['a']), {});
  assert.deepEqual(
    normalizeHiddenByPlatform({
      douyin: ['schwarz', 'chen', 'schwarz', '', 123],
      bilibili: [],
      invalid: 'str',
    }),
    {
      douyin: ['schwarz', 'chen'],
    },
  );
});

test('toggleHiddenOperator 与 restoreHiddenOperator 按平台独立管理并支持合并形态', () => {
  const initial = {};
  const step1 = toggleHiddenOperator(initial, 'douyin', 'schwarz');
  assert.equal(step1.hidden, true);
  assert.deepEqual(step1.next, { douyin: ['schwarz'] });

  const step2 = toggleHiddenOperator(step1.next, 'douyin', 'chen');
  assert.deepEqual(step2.next, { douyin: ['schwarz', 'chen'] });

  const step3 = toggleHiddenOperator(step2.next, 'bilibili', 'texas', ['texas', 'texas_alter']);
  assert.equal(step3.hidden, true);
  assert.deepEqual(step3.next, {
    douyin: ['schwarz', 'chen'],
    bilibili: ['texas'],
  });
  assert.equal(
    isOperatorHidden(new Set(step3.next.bilibili), 'texas_alter', ['texas', 'texas_alter']),
    true,
  );

  const unhideMerged = toggleHiddenOperator(step3.next, 'bilibili', 'texas_alter', [
    'texas',
    'texas_alter',
  ]);
  assert.equal(unhideMerged.hidden, false);
  assert.deepEqual(unhideMerged.next, { douyin: ['schwarz', 'chen'] });

  const restoredOne = restoreHiddenOperator(unhideMerged.next, 'douyin', 'schwarz');
  assert.deepEqual(restoredOne, { douyin: ['chen'] });

  const cleared = clearHiddenOperators(restoredOne, 'douyin');
  assert.deepEqual(cleared, {});
});
