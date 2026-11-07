import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PUBLIC_PLATFORMS, publicDataset } from './publicData.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'public/data');
mkdirSync(output, { recursive: true });
for (const platform of PUBLIC_PLATFORMS) {
  const filename = platform + '-tag-counts.json';
  const localName = ['weibo', 'xiaohongshu', 'skland'].includes(platform)
    ? 'topic-counts.json'
    : 'tag-counts.json';
  const local = join(root, '.local', platform, localName);
  const source = existsSync(local) ? local : join(output, filename);
  const data = publicDataset(platform, JSON.parse(readFileSync(source, 'utf8')));
  writeFileSync(join(output, filename), JSON.stringify(data));
  console.log(platform + ': ' + data.records.length + ' 条汇总');
}
