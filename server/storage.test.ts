import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from './storage.ts';

async function fixture(run: (filename: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rhodes-write-test-'));
  try {
    await run(path.join(directory, 'snapshot.json'));
  } finally {
    for (const name of await readdir(directory)) await unlink(path.join(directory, name));
    await rmdir(directory);
  }
}

test('Windows 短暂占用会重试，最终保存完整的新快照', async () => {
  await fixture(async (filename) => {
    await writeFile(filename, '{"version":1}');
    let attempts = 0;
    await atomicJson(filename, { version: 2 }, async (temporary, destination) => {
      if (++attempts < 3) throw Object.assign(new Error('temporary file lock'), { code: 'EPERM' });
      return rename(temporary, destination);
    });
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { version: 2 });
    assert.deepEqual(await readdir(path.dirname(filename)), ['snapshot.json']);
  });
});

test('持续占用时保留原快照，不留下半写入文件', async () => {
  await fixture(async (filename) => {
    await writeFile(filename, '{"version":1}');
    await assert.rejects(
      atomicJson(filename, { version: 2 }, async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }),
    );
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { version: 1 });
    assert.deepEqual(await readdir(path.dirname(filename)), ['snapshot.json']);
  });
});
