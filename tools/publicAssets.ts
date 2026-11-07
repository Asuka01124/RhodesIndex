import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { PUBLIC_PLATFORMS, publicDataset } from './publicData.ts';

export function publicAssetFiles(roster: { avatar: string }[]): string[] {
  const avatars = roster.map((operator) => {
    if (!/^\/avatars\/[a-zA-Z0-9_-]+\.(png|webp|jpg|svg)$/.test(operator.avatar)) {
      throw new Error('头像必须来自项目静态头像目录。');
    }
    return operator.avatar.slice(1);
  });
  return [
    'favicon.svg',
    'data/operators.json',
    ...PUBLIC_PLATFORMS.map((platform) => 'data/' + platform + '-tag-counts.json'),
    ...new Set(avatars),
  ];
}

// Vite 不复制整个 public，避免将本机旧快照和原始作品打包发布。
export function publicAssetsPlugin(): Plugin {
  let root: string, output: string;
  return {
    name: 'rhodes-public-assets',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      output = config.build.outDir;
    },
    closeBundle() {
      const source = join(root, 'public');
      const roster = JSON.parse(readFileSync(join(source, 'data/operators.json'), 'utf8'));
      for (const file of publicAssetFiles(roster)) {
        const target = join(root, output, file);
        mkdirSync(dirname(target), { recursive: true });
        const platform = PUBLIC_PLATFORMS.find((p) => file === 'data/' + p + '-tag-counts.json');
        if (platform) {
          const data = publicDataset(
            platform,
            JSON.parse(readFileSync(join(source, file), 'utf8')),
          );
          writeFileSync(target, JSON.stringify(data));
        } else copyFileSync(join(source, file), target);
      }
      writeFileSync(join(root, output, '.nojekyll'), '');
    },
  };
}
