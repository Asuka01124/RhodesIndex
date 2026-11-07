import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SNAPSHOTS: Record<string, string> = {
  pixiv: 'pixiv/tag-counts.json',
  bilibili: 'bilibili/tag-counts.json',
  lofter: 'lofter/tag-counts.json',
  douyin: 'douyin/tag-counts.json',
  xiaohongshu: 'xiaohongshu/topic-counts.json',
  weibo: 'weibo/topic-counts.json',
  skland: 'skland/topic-counts.json',
};

// 仅供本机开发读取汇总；采集、登录和原始作品数据不经过网站服务。
export function localCollectorPlugin(): Plugin {
  return {
    name: 'rhodes-local-snapshots',
    configureServer(server) {
      const local = path.join(server.config.root, '.local');
      server.middlewares.use((req, res, next) => {
        const route = (req.url ?? '').split('?')[0];
        if (!route.startsWith('/api/')) return next();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const send = (status: number, body: string) => {
          res.statusCode = status;
          res.end(body);
        };
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) {
          return send(403, JSON.stringify({ error: '仅供本机访问。' }));
        }
        const platform = route.match(/^\/api\/([a-z]+)\/tag-counts$/)?.[1];
        if (!platform || !SNAPSHOTS[platform]) {
          return send(404, JSON.stringify({ error: '没有这个统计接口。' }));
        }
        if (req.method !== 'GET') {
          return send(405, JSON.stringify({ error: '统计接口只支持读取。' }));
        }
        try {
          send(200, readFileSync(path.join(local, SNAPSHOTS[platform]), 'utf8'));
        } catch {
          send(404, JSON.stringify({ error: '尚未生成该平台的汇总快照。' }));
        }
      });
    },
  };
}
