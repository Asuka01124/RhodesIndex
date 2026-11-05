import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { compactNumber } from './domain';
import { YEAR_COLORS } from './data';
import { Segmented } from './ui';
import { buildEntries, groupEntries, squarify } from './treemap';
import type { TreemapEntry, YearChange } from './treemap';
import type { Operator, RankedOperator } from './types';

type ColorMode = 'change' | 'peak';
type Convention = 'cn' | 'us';

const NEUTRAL = '#e8e8ed';
const NEW_BG = '#d6e8ff';
const UP_CN = '#ff3b30';
const DOWN_CN = '#30b158';
const GAP = 2;
const GROUP_HEAD = 20;
const SCALE_STEPS = [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6];

function readLocal<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function changeColor(change: YearChange, convention: Convention) {
  if (change.kind === 'new') return { bg: NEW_BG, fg: '#0058b0' };
  if (change.kind === 'na') return { bg: NEUTRAL, fg: '#6e6e73' };
  if (Math.abs(change.value) < 0.02) return { bg: NEUTRAL, fg: '#3a3a3c' };
  const up = convention === 'cn' ? UP_CN : DOWN_CN;
  const down = convention === 'cn' ? DOWN_CN : UP_CN;
  const t = Math.min(1, Math.abs(change.value) / 0.6);
  const pct = Math.round((0.18 + t * 0.82) * 100);
  return {
    bg: `color-mix(in srgb, ${change.value > 0 ? up : down} ${pct}%, ${NEUTRAL})`,
    fg: t > 0.55 ? '#fff' : '#1d1d1f',
  };
}

function changeLabel(change: YearChange) {
  if (change.kind === 'pct')
    return `${change.value >= 0 ? '+' : ''}${(change.value * 100).toFixed(1)}%`;
  if (change.kind === 'new') return 'NEW';
  return '—';
}

interface Tip {
  x: number;
  y: number;
  entry: TreemapEntry;
}

export function TreemapHeatmap({
  rows,
  years,
  metricLabel,
  missingCount,
  onSelect,
}: {
  rows: RankedOperator[];
  years: number[];
  metricLabel: string;
  missingCount: number;
  onSelect: (operator: Operator) => void;
}) {
  const [colorMode, setColorMode] = useState<ColorMode>(() =>
    readLocal('rhodes-treemap-color', ['change', 'peak'], 'change'),
  );
  const [grouped, setGrouped] = useState<'prof' | 'none'>(() =>
    readLocal('rhodes-treemap-group', ['prof', 'none'], 'prof'),
  );
  const [convention, setConvention] = useState<Convention>(() =>
    readLocal('rhodes-treemap-convention', ['cn', 'us'], 'cn'),
  );
  useEffect(() => {
    try {
      localStorage.setItem('rhodes-treemap-color', colorMode);
      localStorage.setItem('rhodes-treemap-group', grouped);
      localStorage.setItem('rhodes-treemap-convention', convention);
    } catch {
      /* storage unavailable */
    }
  }, [colorMode, grouped, convention]);

  const mapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = w < 560 ? Math.max(720, w * 2.3) : Math.min(760, Math.max(520, w * 0.56));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sortedYears = useMemo(() => [...years].sort((a, b) => a - b), [years]);
  const entries = useMemo(() => buildEntries(rows, sortedYears), [rows, sortedYears]);
  const total = entries.reduce((s, e) => s + e.value, 0);
  const comparable = entries.filter((e) => e.change.kind === 'pct');
  const ups = comparable.filter((e) => e.change.kind === 'pct' && e.change.value > 0.02).length;
  const downs = comparable.filter((e) => e.change.kind === 'pct' && e.change.value < -0.02).length;
  const best = comparable.reduce<TreemapEntry | null>(
    (acc, e) =>
      e.change.kind === 'pct' &&
      (!acc || (acc.change.kind === 'pct' && e.change.value > acc.change.value))
        ? e
        : acc,
    null,
  );
  const lastYear = sortedYears[sortedYears.length - 1];
  const prevYear = sortedYears[sortedYears.length - 2];
  const partialYear = lastYear === new Date().getFullYear();

  const layout = useMemo(() => {
    if (!size.w || !size.h) return [];
    const groups = groupEntries(entries, grouped === 'prof');
    return squarify(groups, 0, 0, size.w, size.h).map((g) => {
      const showHead = grouped === 'prof' && g.h > 64 && g.w > 56;
      const ix = g.x + GAP;
      const iy = g.y + GAP + (showHead ? GROUP_HEAD : 0);
      const iw = g.w - GAP * 2;
      const ih = g.h - GAP * 2 - (showHead ? GROUP_HEAD : 0);
      return { group: g, showHead, tiles: squarify(g.item.entries, ix, iy, iw, ih) };
    });
  }, [entries, grouped, size]);

  const [tip, setTip] = useState<Tip | null>(null);
  const moveTip = (event: MouseEvent, entry: TreemapEntry) => {
    const width = 260;
    const pad = 14;
    let x = event.clientX + pad;
    if (x + width > window.innerWidth) x = event.clientX - width - pad;
    const y = Math.min(event.clientY + pad, window.innerHeight - 250);
    setTip({ x: Math.max(8, x), y: Math.max(8, y), entry });
  };

  const colorFor = (entry: TreemapEntry) =>
    colorMode === 'peak'
      ? { bg: entry.peakYear ? YEAR_COLORS[entry.peakYear] : NEUTRAL, fg: '#fff' }
      : changeColor(entry.change, convention);

  return (
    <div className="treemap-view">
      <div className="treemap-toolbar">
        <p className="treemap-subtitle">
          合并 {sortedYears.length === 1 ? sortedYears[0] : `${sortedYears[0]}–${lastYear}`} 共{' '}
          {sortedYears.length} 个年份 · 面积 = 累计{metricLabel} · 颜色 ={' '}
          {colorMode === 'peak'
            ? `${metricLabel}最高的年份`
            : prevYear
              ? `${lastYear} 较 ${prevYear} 变化`
              : '需选择至少两个年份'}
        </p>
        <div className="treemap-controls">
          <Segmented
            label="热力图着色"
            value={colorMode}
            onChange={setColorMode}
            options={[
              { value: 'change', label: '同比变化' },
              { value: 'peak', label: '峰值年份' },
            ]}
          />
          <Segmented
            label="热力图分组"
            value={grouped}
            onChange={setGrouped}
            options={[
              { value: 'prof', label: '按职业' },
              { value: 'none', label: '不分组' },
            ]}
          />
          {colorMode === 'change' && (
            <Segmented
              label="涨跌配色"
              value={convention}
              onChange={setConvention}
              options={[
                { value: 'cn', label: '红涨' },
                { value: 'us', label: '绿涨' },
              ]}
            />
          )}
        </div>
      </div>

      <div className="treemap-stats">
        <div>
          <span>累计{metricLabel}</span>
          <strong>{compactNumber(total)}</strong>
        </div>
        <div>
          <span>有数据干员</span>
          <strong>
            {entries.length}
            <small>{missingCount ? `另 ${missingCount} 位未提供` : '名'}</small>
          </strong>
        </div>
        <div>
          <span>上涨 / 下跌</span>
          <strong>{prevYear ? `${ups} / ${downs}` : '—'}</strong>
        </div>
        <div>
          <span>最大涨幅</span>
          <strong>
            {best ? changeLabel(best.change) : '—'}
            {best && <small>{best.row.operator.name}</small>}
          </strong>
        </div>
      </div>

      <div
        ref={mapRef}
        className="treemap-map"
        style={{ height: size.h || undefined }}
        onMouseLeave={() => setTip(null)}
      >
        {layout.map(({ group, showHead, tiles }) => (
          <div key={group.item.key || 'all'}>
            {showHead && (
              <div
                className="treemap-group-label"
                style={{ left: group.x + GAP + 2, top: group.y + GAP, width: group.w - GAP * 2 }}
              >
                {group.item.key}
                <span>
                  {compactNumber(group.item.value)} ·{' '}
                  {((group.item.value / total) * 100).toFixed(1)}%
                </span>
              </div>
            )}
            {tiles.map((t) => {
              const entry = t.item;
              const op = entry.row.operator;
              const w = Math.max(0, t.w - GAP);
              const h = Math.max(0, t.h - GAP);
              const color = colorFor(entry);
              const fs = Math.max(10, Math.min(22, Math.sqrt(w * h) / 7));
              const sub =
                colorMode === 'peak'
                  ? entry.peakYear
                    ? `${entry.peakYear} 峰值`
                    : '—'
                  : changeLabel(entry.change);
              const avatar = Math.min(48, fs * 2.2);
              return (
                <button
                  key={op.id}
                  className="treemap-tile"
                  style={
                    {
                      left: t.x + GAP / 2,
                      top: t.y + GAP / 2,
                      width: w,
                      height: h,
                      background: color.bg,
                      color: color.fg,
                    } as CSSProperties
                  }
                  aria-label={`${op.name}，累计 ${entry.value.toLocaleString('zh-CN')} 次${metricLabel}，${colorMode === 'peak' ? sub : `同比 ${sub}`}`}
                  onMouseEnter={(event) => moveTip(event, entry)}
                  onMouseMove={(event) => moveTip(event, entry)}
                  onClick={() => onSelect(op)}
                >
                  {w > 96 && h > 92 ? (
                    <>
                      <img src={op.avatar} width={avatar} height={avatar} alt="" loading="lazy" />
                      <span className="tile-name" style={{ fontSize: fs }}>
                        {op.name}
                      </span>
                      <span className="tile-change" style={{ fontSize: fs * 0.72 }}>
                        {sub}
                      </span>
                      <span className="tile-total">{compactNumber(entry.value)}</span>
                    </>
                  ) : w > 52 && h > 34 ? (
                    <>
                      <span className="tile-name" style={{ fontSize: Math.min(fs, 14) }}>
                        {op.name}
                      </span>
                      <span className="tile-change" style={{ fontSize: Math.min(fs, 14) * 0.8 }}>
                        {sub}
                      </span>
                    </>
                  ) : w > 28 && h > 16 ? (
                    <span className="tile-name" style={{ fontSize: 10 }}>
                      {op.name.slice(0, Math.max(1, Math.floor(w / 11)))}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="treemap-legend">
        {colorMode === 'peak' ? (
          <div className="treemap-scale">
            <span>峰值年份</span>
            <div>
              {sortedYears.map((year) => (
                <i key={year} style={{ background: YEAR_COLORS[year], color: '#fff' }}>
                  {String(year).slice(2)}
                </i>
              ))}
            </div>
          </div>
        ) : (
          <div className="treemap-scale">
            <div>
              {SCALE_STEPS.map((v) => {
                const c = changeColor({ kind: 'pct', value: v, from: 0, to: 0 }, convention);
                return (
                  <i key={v} style={{ background: c.bg, color: c.fg }}>
                    {v > 0 ? '+' : ''}
                    {Math.round(v * 100)}%
                  </i>
                );
              })}
            </div>
            <i className="treemap-new-swatch" style={{ background: NEW_BG }} />
            <span>上一年无数据</span>
          </div>
        )}
        <span className="treemap-note">
          {partialYear && colorMode === 'change' && prevYear
            ? `${lastYear} 年仅含截至采集时的作品，同比偏低属正常。`
            : '点击方块查看干员详情。'}
        </span>
      </div>

      {tip && <TreemapTooltip tip={tip} years={sortedYears} metricLabel={metricLabel} />}
    </div>
  );
}

function TreemapTooltip({
  tip,
  years,
  metricLabel,
}: {
  tip: Tip;
  years: number[];
  metricLabel: string;
}) {
  const { entry } = tip;
  const op = entry.row.operator;
  const values = years.map((year) => entry.row.yearly[year] ?? null);
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  return (
    <div className="treemap-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
      <div className="treemap-tip-head">
        <img src={op.avatar} alt="" />
        <div>
          <strong>{op.name}</strong>
          <span>
            {'★'.repeat(op.rarity)} · {op.profession}
          </span>
        </div>
      </div>
      <dl>
        <div>
          <dt>累计{metricLabel}</dt>
          <dd>{compactNumber(entry.value)}</dd>
        </div>
        <div>
          <dt>同比变化</dt>
          <dd>{entry.change.kind === 'new' ? '上一年无数据' : changeLabel(entry.change)}</dd>
        </div>
        <div>
          <dt>峰值年份</dt>
          <dd>{entry.peakYear ?? '—'}</dd>
        </div>
      </dl>
      <div className="treemap-tip-bars">
        {years.map((year, i) => {
          const v = values[i];
          return (
            <div key={year}>
              <i
                className={v === null ? 'missing' : year === entry.peakYear ? 'peak' : ''}
                style={{ height: v === null ? '100%' : `${Math.max(3, (v / max) * 100)}%` }}
              />
              <span>{String(year).slice(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
