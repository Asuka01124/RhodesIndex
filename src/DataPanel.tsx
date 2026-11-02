import { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Database,
  FileJson,
  Info,
  Upload,
} from 'lucide-react';
import type { DataMode, HeatDataset, Operator } from './types';
import { validateDataset } from './domain';
import { downloadFile, Modal } from './ui';
import { CollectionPanel } from './CollectionPanel';
import type { CollectionActions } from './CollectionPanel';

export function DataPanel({
  operators,
  imported,
  activeMode,
  onUseDemo,
  onImport,
  onUseImported,
  onClose,
  collection,
  filteredIds,
  onUseCollected,
  initialTab = 'about',
}: {
  operators: Operator[];
  imported: HeatDataset | null;
  activeMode: DataMode;
  onUseDemo: () => void;
  onImport: (data: HeatDataset) => void;
  onUseImported: () => void;
  onClose: () => void;
  collection: CollectionActions;
  filteredIds: string[];
  onUseCollected: () => void;
  initialTab?: 'about' | 'import' | 'platforms';
}) {
  const [tab, setTab] = useState<'about' | 'import' | 'platforms'>(initialTab);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  async function handleFile(file?: File) {
    if (!file) return;
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请先汇总为年度数据再导入。');
      const parsed: unknown = JSON.parse(await file.text());
      const data = validateDataset(parsed, operators);
      onImport(data);
      setSuccess(
        `已导入 ${data.records.length.toLocaleString('zh-CN')} 条记录，并切换到导入数据。`,
      );
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? 'JSON 格式有误，请检查引号、逗号及括号。'
          : e instanceof Error
            ? e.message
            : '导入失败，请检查文件。',
      );
    } finally {
      setBusy(false);
    }
  }
  function template() {
    downloadFile(
      '罗德指数-年度热度导入模板.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          yearBasis: 'publication_year',
          records: [
            {
              operatorId: 'char_4193_lemuen',
              platform: 'pixiv',
              year: 2026,
              likes: null,
              views: null,
              sourceUrls: ['https://www.pixiv.net/tags/%E8%95%BE%E7%BC%AA%E5%AE%89'],
              observedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    );
  }
  return (
    <Modal title="数据与来源" onClose={onClose}>
      <div className="modal-tabs" role="tablist" aria-label="数据管理">
        {[
          { id: 'about', label: '统计口径' },
          { id: 'import', label: '导入数据' },
          { id: 'platforms', label: '平台接入' },
        ].map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id as typeof tab)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'about' && (
        <div className="modal-content">
          <div className="data-notice">
            <Info size={19} aria-hidden="true" />
            <div>
              <h3>
                {activeMode === 'collected' ? '真实采集，明确覆盖范围。' : '数据模式彼此独立。'}
              </h3>
              <p>
                {activeMode === 'collected'
                  ? '当前只累计已采集并核验原生标签的公开作品。不包含未采集作品，不代表平台全站总量；每件作品保留指标、发布时间和统计时间。'
                  : '434 位干员信息与头像来自 PRTS。演示数据与真实采集、用户导入严格分开，不会自动填补缺失指标。'}
              </p>
            </div>
          </div>
          <div className="mode-card">
            <div>
              <span className="eyebrow">当前数据模式</span>
              <h3>
                {activeMode === 'demo'
                  ? '演示数据'
                  : activeMode === 'collected'
                    ? '真实采集样本 · 部分覆盖'
                    : '用户导入数据'}
              </h3>
              <p>
                {activeMode === 'demo'
                  ? '仅用于体验界面，不代表实际热度。'
                  : activeMode === 'collected'
                    ? `已核验 ${collection.live.metadata.workCount} 件作品，关联 ${collection.live.metadata.operatorCount} 位干员。`
                    : '仅统计导入文件中的数据，不混入其他模式的数值。'}
              </p>
            </div>
            <span className="status-pill">
              <Check size={12} aria-hidden="true" />
              正在使用
            </span>
          </div>
          {activeMode !== 'demo' ? (
            <button className="outline-button full-width" onClick={onUseDemo}>
              切换回演示数据
            </button>
          ) : (
            imported && (
              <button className="outline-button full-width" onClick={onUseImported}>
                使用已导入的 {imported.records.length} 条记录
              </button>
            )
          )}
          {activeMode !== 'collected' && (
            <button className="outline-button full-width" onClick={onUseCollected}>
              切换到真实采集数据
            </button>
          )}
          {activeMode === 'collected' && (
            <button className="outline-button full-width" onClick={() => setTab('platforms')}>
              管理采集、查看覆盖范围
            </button>
          )}
          <dl className="method-list">
            <div>
              <dt>如何理解年份？</dt>
              <dd>
                按作品发布时间分组。某年颜色块代表该年发布的作品，在统计时累计获得的互动量，
                <b>不代表该年新增的互动</b>。
              </dd>
            </div>
            <div>
              <dt>点赞与观看量</dt>
              <dd>
                点赞包含平台原生点赞或爱心，不把收藏、转发或综合热度混算。观看量使用原生播放或浏览次数；未提供的指标保留为空。
              </dd>
            </div>
            <div>
              <dt>跨平台汇总</dt>
              <dd>
                同一平台的同一作品对同一干员只计一次；同时关联多位干员的作品会分别计入对应干员。榜单合计不做跨干员或人群去重，也不做平台间权重校准。
              </dd>
            </div>
            <div>
              <dt>档案范围</dt>
              <dd>
                采集于 2026 年 10 月 31
                日，包含异格与升变形态。性别原文为“女士”归为女；断罪、未知等保留在“其他／未知”。
              </dd>
            </div>
          </dl>
          <div className="source-links">
            <a href="https://prts.wiki/w/干员一览" target="_blank" rel="noreferrer">
              PRTS 干员档案
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            <a href="https://kuro.framer.website/" target="_blank" rel="noreferrer">
              设计参考：Kuro
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
      {tab === 'import' && (
        <div className="modal-content">
          <h3 className="section-title">让每个数字，都有来源。</h3>
          <p className="muted import-copy">
            导入按「干员 × 平台 × 年份」汇总的 JSON。文件保存在当前浏览器本机，不上传到服务器。
          </p>
          <label className={`upload-zone ${busy ? 'busy' : ''}`}>
            <Upload size={28} strokeWidth={1.3} aria-hidden="true" />
            <strong>{busy ? '正在校验数据…' : '选择年度数据文件'}</strong>
            <span>JSON 格式 · 最大 2 MB</span>
            <input
              type="file"
              accept=".json,application/json"
              aria-label="选择年度热度 JSON 文件"
              disabled={busy}
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {error && (
            <p className="form-message error" role="alert">
              {error}
            </p>
          )}
          {success && (
            <p className="form-message success" role="status">
              {success}
            </p>
          )}
          <button className="outline-button full-width" onClick={template}>
            <ArrowDownToLine size={16} aria-hidden="true" />
            下载导入模板
          </button>
          <div className="import-help">
            <FileJson size={19} aria-hidden="true" />
            <p>
              模板中的 <code>likes</code> 和 <code>views</code> 默认为 <code>null</code>
              ，请填入采集值；无数据时继续留空。每条记录需要来源链接和统计时间，同一组合不能重复。
            </p>
          </div>
          <button
            className="text-button"
            onClick={() =>
              downloadFile(
                '罗德指数-干员ID对照.json',
                JSON.stringify(
                  operators.map((o) => ({ id: o.id, name: o.name, profession: o.profession })),
                  null,
                  2,
                ),
              )
            }
          >
            <Database size={14} aria-hidden="true" />
            下载干员 ID 对照表
          </button>
        </div>
      )}
      {tab === 'platforms' && (
        <div className="modal-content">
          <CollectionPanel
            collection={collection}
            operators={operators}
            filteredIds={filteredIds}
            onUseCollected={onUseCollected}
          />
        </div>
      )}
    </Modal>
  );
}
