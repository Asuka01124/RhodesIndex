import { useState } from 'react';
import { ArrowDownToLine, ExternalLink, Info, Play, RefreshCw, Square } from 'lucide-react';
import type { CollectorState, LiveDataset, Operator, PlatformId } from './types';
import { PLATFORMS } from './data';
import { BrandIcon, downloadFile } from './ui';

export interface CollectionActions {
  live: LiveDataset;
  state: CollectorState | null;
  error: string;
  loading: boolean;
  refresh: () => Promise<void>;
  start: (platforms: PlatformId[], operatorIds: string[], limit: number) => Promise<CollectorState>;
  stop: () => Promise<CollectorState>;
  resume: () => Promise<CollectorState>;
  login: (platform: PlatformId) => Promise<CollectorState>;
}

export function CollectionPanel({
  collection,
  operators,
  filteredIds,
  onUseCollected,
}: {
  collection: CollectionActions;
  operators: Operator[];
  filteredIds: string[];
  onUseCollected: () => void;
}) {
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all');
  const [selection, setSelection] = useState<'starter' | 'filtered' | 'all'>('all');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const running = collection.state?.job?.state === 'running';
  const supported = collection.state?.supportedPlatforms ?? ['pixiv', 'bilibili'];
  const defaultNames = ['蕾缪安', '能天使', '阿米娅', '凯尔希', '银灰', '斯卡蒂'];
  const selectedIds =
    selection === 'all'
      ? operators.map((o) => o.id)
      : selection === 'filtered'
        ? filteredIds
        : operators.filter((o) => defaultNames.includes(o.name)).map((o) => o.id);
  async function invoke(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  const date = collection.live.metadata.generatedAt
    ? new Date(collection.live.metadata.generatedAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      })
    : '尚未采集';
  const job = collection.state?.job;
  return (
    <div className="collection-panel">
      <div className="data-notice">
        <Info size={18} aria-hidden="true" />
        <div>
          <h3>按角色标签全量翻页。</h3>
          <p>
            纯 HTTP Session
            读取全部分页，不设作品数量上限。保存每件作品的原生指标；接口受限、提前截断和详情缺失会单独记录，不算作已取完。
          </p>
        </div>
      </div>
      <div className="collection-summary">
        <div>
          <strong>{collection.live.metadata.workCount}</strong>
          <span>件去重作品</span>
        </div>
        <div>
          <strong>{collection.live.metadata.operatorCount}</strong>
          <span>位关联干员</span>
        </div>
        <div>
          <strong>{collection.live.metadata.platformCount}</strong>
          <span>个平台</span>
        </div>
      </div>
      <p className="collection-updated">最近统计：{date}（北京时间）</p>
      <div className="collector-controls">
        <label>
          采集平台
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as PlatformId | 'all')}
            disabled={running || busy}
          >
            <option value="all">全部已接入平台（并行采集）</option>
            {PLATFORMS.filter((p) => supported.includes(p.id)).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          干员范围
          <select
            value={selection}
            onChange={(e) => setSelection(e.target.value as typeof selection)}
            disabled={running || busy}
          >
            <option value="starter">先采集 6 位常用干员</option>
            <option value="filtered">当前筛选的 {filteredIds.length} 位</option>
            <option value="all">全部 {operators.length} 位干员</option>
          </select>
        </label>
        <p className="collection-updated">
          作品范围：角色标签的全部可访问分页，自动保存断点与去重结果。
        </p>
      </div>
      <div className="collection-buttons">
        <button
          className="primary-button"
          disabled={busy || running || !collection.state?.available || !selectedIds.length}
          onClick={() => {
            void invoke(async () => {
              await collection.start(
                platform === 'all' ? (supported as PlatformId[]) : [platform],
                selectedIds,
                0,
              );
              onUseCollected();
            }, '采集已开始，数据会自动更新到图表。');
          }}
        >
          <Play size={14} aria-hidden="true" />
          {running ? '采集中…' : `开始采集 ${selectedIds.length} 位`}
        </button>
        {running ? (
          <button
            className="outline-button"
            onClick={() => {
              void invoke(collection.stop, '正在停止，已采集的数据会保留。');
            }}
          >
            <Square size={12} aria-hidden="true" />
            停止采集
          </button>
        ) : (
          <button
            className="outline-button"
            disabled={busy || !collection.state?.available || platform === 'all'}
            onClick={() => {
              setMessage(
                `脚本会复用本机已授权的 Cookie。补充会话请在本机终端执行 python scripts/tag_collect.py session --platform ${platform}，输入会隐藏并加密保存。`,
              );
              setFailed(false);
            }}
          >
            <ExternalLink size={14} aria-hidden="true" />
            会话配置说明
          </button>
        )}
        {!running && job?.plan && (job.completedKeys?.length ?? 0) < job.total && (
          <button
            className="outline-button"
            disabled={busy}
            onClick={() =>
              void invoke(collection.resume, '已恢复分页断点，已完成的标签不会重复采集。')
            }
          >
            继续上次采集
          </button>
        )}
        <button
          className="icon-button"
          aria-label="刷新已采集快照"
          onClick={() => {
            void collection.refresh();
          }}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      {message && (
        <p
          className={`form-message ${failed ? 'error' : 'success'}`}
          role={failed ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
      {collection.error && <p className="form-message error">{collection.error}</p>}
      {job && (
        <div className="collection-job">
          <div>
            <strong>
              {job.state === 'running'
                ? '本轮采集进度'
                : job.state === 'completed'
                  ? '配置的标签分页已取完'
                  : job.state === 'cancelled'
                    ? '本轮已停止'
                    : '采集未完成'}
            </strong>
            <span>
              {job.completed} / {job.total}
            </span>
          </div>
          <progress value={job.completed} max={Math.max(1, job.total)} />
          <p>{job.current || job.message}</p>
          {job.errors.length > 0 && (
            <details>
              <summary>{job.errors.length} 条读取限制或失败记录</summary>
              <ul>
                {job.errors.slice(-10).map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="collection-buttons">
        <button className="outline-button" onClick={onUseCollected}>
          在图表中查看真实样本
        </button>
        <button
          className="outline-button"
          disabled={!collection.live.records.length}
          onClick={() =>
            downloadFile('罗德指数-真实采集样本.json', JSON.stringify(collection.live, null, 2))
          }
        >
          <ArrowDownToLine size={14} aria-hidden="true" />
          导出真实数据与来源
        </button>
      </div>
      <div className="platform-statuses">
        {PLATFORMS.map((p) => {
          const rows = collection.live.coverage.filter((row) => row.platform === p.id);
          const count = collection.live.works.filter((work) => work.platform === p.id).length;
          const blocked = rows.some((row) => row.status === 'blocked');
          const exhausted = rows.filter((row) => row.status === 'exhausted').length;
          return (
            <div key={p.id} className="platform-status">
              <span className="platform-status-icon">
                <BrandIcon name={p.icon} />
              </span>
              <div>
                <strong>{p.name}</strong>
                <p>
                  {count
                    ? `已保存 ${count} 件作品；${exhausted} 组标签已取完${blocked ? '；存在会话或接口限制' : ''}`
                    : blocked
                      ? rows.find((row) => row.status === 'blocked')?.note
                      : supported.includes(p.id)
                        ? '已接入采集器，尚无成功核验的样本'
                        : p.login}
                </p>
              </div>
              <span className="pending-label">
                {count
                  ? '真实样本'
                  : blocked
                    ? '需要处理'
                    : supported.includes(p.id)
                      ? '待采集'
                      : '待接入'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
