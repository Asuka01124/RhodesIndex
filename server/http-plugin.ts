import type { Plugin } from 'vite';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { aggregateWorks } from './aggregate';
import { atomicJson } from './storage';
import type { CollectionJob, PlatformId, Operator } from '../src/types';

const SUPPORTED: PlatformId[] = ['pixiv', 'xiaohongshu', 'youtube', 'bluesky', 'tumblr'];
export function localCollectorPlugin(): Plugin {
  return {
    name: 'rhodes-http-data',
    configureServer(server) {
      const root = server.config.root;
      const local = path.join(root, '.local');
      const jobFile = path.join(local, 'http-job.json');
      const read = (filename: string, fallback: any) => {
        try {
          return JSON.parse(readFileSync(filename, 'utf8'));
        } catch {
          return fallback;
        }
      };
      const snapshot = () => {
        const live = read(path.join(local, 'http-live.json'), null);
        if (live) return live;
        const raw = read(path.join(local, 'observations.json'), { works: [], coverage: [] });
        return aggregateWorks(raw.works, raw.coverage);
      };
      const state = () => {
        const data = snapshot();
        return {
          available: true,
          supportedPlatforms: SUPPORTED,
          job: read(jobFile, null),
          loginWindows: [],
          snapshot: {
            workCount: data.metadata.workCount,
            operatorCount: data.metadata.operatorCount,
            generatedAt: data.metadata.generatedAt,
          },
        };
      };
      let child: ReturnType<typeof spawn> | null = null;
      const stop = async () => {
        await atomicJson(path.join(local, 'http-control.json'), { stop: true });
        return state();
      };
      const operators = read(path.join(root, 'public/data/operators.json'), []) as Operator[];
      server.httpServer?.once('close', () => {
        if (child) void stop();
      });
      server.middlewares.use(async (req, res, next) => {
        const route = req.url?.split('?')[0];
        if (route != '/data/live-heat.json' && !route?.startsWith('/api/')) return next();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const send = (code: number, value: unknown) => {
          res.statusCode = code;
          res.end(JSON.stringify(value));
        };
        const host = req.headers.host ?? '';
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
          return send(403, { error: '采集服务仅供本机使用。' });
        if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${host}`)
          return send(403, { error: '不接受其他网站发起的采集请求。' });
        try {
          if (req.method === 'GET' && route === '/api/bilibili/tag-counts') {
            const counts = read(path.join(local, 'bilibili/tag-counts.json'), null);
            return counts ? send(200, counts) : send(404, { error: '尚未导出B站标签数量。' });
          }
          if (req.method === 'GET' && route === '/api/lofter/tag-counts') {
            const counts = read(path.join(local, 'lofter/tag-counts.json'), null);
            return counts ? send(200, counts) : send(404, { error: '尚未导出LOFTER标签统计。' });
          }
          if (req.method === 'GET' && route === '/api/douyin/tag-counts') {
            const counts = read(path.join(local, 'douyin/tag-counts.json'), null);
            return counts ? send(200, counts) : send(404, { error: '尚未导出抖音话题统计。' });
          }
          if (req.method === 'GET' && route === '/api/xiaohongshu/tag-counts') {
            const counts = read(path.join(local, 'xiaohongshu/topic-counts.json'), null);
            return counts ? send(200, counts) : send(404, { error: '尚未采集小红书话题统计。' });
          }
          if (
            req.method === 'GET' &&
            (route === '/api/live-data' || route === '/data/live-heat.json')
          )
            return send(200, snapshot());
          if (req.method === 'GET' && route === '/api/collection/status') return send(200, state());
          if (req.method !== 'POST') return send(405, { error: '请求方法不受支持。' });
          let body = '';
          for await (const part of req) {
            body += part.toString();
            if (body.length > 32768) return send(413, { error: '请求过大。' });
          }
          const input = body ? JSON.parse(body) : {};
          if (route === '/api/collection/stop') return send(200, await stop());
          if (route === '/api/collection/login')
            return send(400, {
              error:
                '采集器不启动浏览器。请在本机终端运行 python scripts/tag_collect.py session --platform ' +
                (SUPPORTED.includes(input.platform) ? input.platform : 'xiaohongshu') +
                '，隐藏输入 Cookie 并加密保存。',
            });
          if (route !== '/api/collection/start') return send(404, { error: '没有这个本地接口。' });
          if (child || state().job?.state === 'running')
            throw new Error('已有纯 HTTP 采集任务在运行，请先停止。');
          const previous = read(jobFile, null) as CollectionJob | null;
          const plan = input.resume ? previous?.plan : input;
          if (!plan) throw new Error('没有可恢复的 HTTP 采集计划。');
          const platforms = Array.isArray(plan.platforms) ? plan.platforms : SUPPORTED;
          const ids = Array.isArray(plan.operatorIds)
            ? plan.operatorIds
            : operators.map((o) => o.id);
          if (
            !platforms.length ||
            platforms.some((p: PlatformId) => !SUPPORTED.includes(p)) ||
            !ids.length ||
            ids.some((id: string) => !operators.some((o) => o.id === id))
          )
            throw new Error('平台或干员范围无效。');
          await atomicJson(path.join(local, 'http-control.json'), { stop: false });
          const job = {
            id: randomUUID(),
            state: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            completed: 0,
            total: platforms.length * ids.length,
            current: '正在启动纯 HTTP Session 脚本',
            message: '不限制作品数量，逐页读取到接口结束',
            errors: [],
            plan: { platforms, operatorIds: ids, limit: 0 },
          };
          await atomicJson(jobFile, job);
          const args = [
            '-u',
            path.join(root, 'scripts/tag_collect.py'),
            'collect',
            '--platforms',
            platforms.join(','),
            '--ids',
            ids.join(','),
          ];
          if (input.resume) args.push('--resume');
          child = spawn(process.env.RHODES_PYTHON || 'python', args, {
            cwd: root,
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          child.once('error', async () => {
            child = null;
            await atomicJson(jobFile, {
              ...job,
              state: 'failed',
              finishedAt: new Date().toISOString(),
              current: '',
              message: 'Python 脚本未能启动，请检查本机 Python 与依赖。',
            });
          });
          child.once('exit', async (code) => {
            child = null;
            const latest = read(jobFile, job);
            if (latest.state === 'running')
              await atomicJson(jobFile, {
                ...latest,
                state: 'failed',
                finishedAt: new Date().toISOString(),
                current: '',
                message: `HTTP 脚本已退出（${code}），已保存的断点和作品保留。`,
              });
          });
          return send(202, state());
        } catch (error) {
          return send(400, { error: error instanceof Error ? error.message : '本地服务错误。' });
        }
      });
    },
  };
}
