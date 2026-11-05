import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { compactNumber } from './domain';
import { YEAR_COLORS } from './data';
import { buildEntries, squarify } from './treemap';
import type { TreemapEntry } from './treemap';
import type { Operator, RankedOperator } from './types';

const GAP = 3;

interface Tip {
  x: number;
  y: number;
  entry: TreemapEntry;
}

function heatFill(ratio: number) {
  const pct = Math.round(12 + ratio * 82);
  return {
    bg: `color-mix(in srgb, #0071e3 ${pct}%, #eef4fc)`,
    fg: ratio > 0.52 ? '#ffffff' : '#1d1d1f',
    sub: ratio > 0.52 ? 'rgb(255 255 255 / 82%)' : '#6e6e73',
  };
}

export function TreemapHeatmap({
  rows,
  years,
  metricLabel,
  onSelect,
}: {
  rows: RankedOperator[];
  years: number[];
  metricLabel: string;
  onSelect: (operator: Operator) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h =
        w < 560
          ? Math.max(620, Math.round(w * 1.9))
          : Math.min(720, Math.max(480, Math.round(w * 0.56)));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sortedYears = useMemo(() => [...years].sort((a, b) => a - b), [years]);
  const entries = useMemo(() => buildEntries(rows), [rows]);
  const total = useMemo(() => entries.reduce((s, e) => s + e.value, 0), [entries]);
  const maxValue = useMemo(() => Math.max(1, ...entries.map((e) => e.value)), [entries]);

  const tiles = useMemo(
    () => (size.w && size.h ? squarify(entries, 0, 0, size.w, size.h) : []),
    [entries, size],
  );

  const [tip, setTip] = useState<Tip | null>(null);
  const moveTip = (event: MouseEvent, entry: TreemapEntry) => {
    const width = 236;
    const pad = 14;
    let x = event.clientX + pad;
    if (x + width > window.innerWidth) x = event.clientX - width - pad;
    const y = Math.min(event.clientY + pad, window.innerHeight - 210);
    setTip({ x: Math.max(8, x), y: Math.max(8, y), entry });
  };

  return (
    <div className="treemap-view">
      <div
        ref={mapRef}
        className="treemap-map"
        style={{ height: size.h || undefined }}
        onMouseLeave={() => setTip(null)}
      >
        {tiles.map((t) => {
          const entry = t.item;
          const op = entry.row.operator;
          const w = Math.max(0, t.w - GAP);
          const h = Math.max(0, t.h - GAP);
          const ratio = Math.sqrt(entry.value / maxValue);
          const color = heatFill(ratio);
          const fs = Math.max(11, Math.min(22, Math.sqrt(w * h) / 6.8));
          const avatar = Math.min(48, Math.round(fs * 2.15));
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
                  '--tile-sub': color.sub,
                } as CSSProperties
              }
              aria-label={`${op.name}，累计 ${entry.value.toLocaleString('zh-CN')} 次${metricLabel}`}
              onMouseEnter={(event) => moveTip(event, entry)}
              onMouseMove={(event) => moveTip(event, entry)}
              onClick={() => onSelect(op)}
            >
              {w > 92 && h > 88 ? (
                <>
                  <img src={op.avatar} width={avatar} height={avatar} alt="" loading="lazy" />
                  <span className="tile-name" style={{ fontSize: fs }}>
                    {op.name}
                  </span>
                  <span className="tile-value" style={{ fontSize: Math.max(11, fs * 0.74) }}>
                    {compactNumber(entry.value)}
                  </span>
                </>
              ) : w > 48 && h > 32 ? (
                <>
                  <span className="tile-name" style={{ fontSize: Math.min(fs, 14) }}>
                    {op.name}
                  </span>
                  <span className="tile-value" style={{ fontSize: 11 }}>
                    {compactNumber(entry.value)}
                  </span>
                </>
              ) : w > 26 && h > 16 ? (
                <span className="tile-name" style={{ fontSize: 10 }}>
                  {op.name.slice(0, Math.max(1, Math.floor(w / 11)))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {tip && (
        <TreemapTooltip tip={tip} years={sortedYears} total={total} metricLabel={metricLabel} />
      )}
    </div>
  );
}

function TreemapTooltip({
  tip,
  years,
  total,
  metricLabel,
}: {
  tip: Tip;
  years: number[];
  total: number;
  metricLabel: string;
}) {
  const { entry } = tip;
  const op = entry.row.operator;
  const values = years.map((year) => entry.row.yearly[year] ?? null);
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const share = total > 0 ? ((entry.value / total) * 100).toFixed(1) : '0.0';
  return (
    <div className="treemap-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
      <div className="treemap-tip-head">
        <img src={op.avatar} alt="" />
        <div>
          <strong>
            #{entry.rank} {op.name}
          </strong>
          <span>
            {op.profession} · {op.factions[0] ?? '罗德岛'}
          </span>
        </div>
      </div>
      <dl>
        <div>
          <dt>累计{metricLabel}</dt>
          <dd>{compactNumber(entry.value)}</dd>
        </div>
        <div>
          <dt>占比</dt>
          <dd>{share}%</dd>
        </div>
      </dl>
      {years.length > 1 && (
        <div className="treemap-tip-bars">
          {years.map((year, i) => {
            const v = values[i];
            return (
              <div key={year}>
                <i
                  className={v === null ? 'missing' : ''}
                  style={{
                    height: v === null ? '100%' : `${Math.max(4, (v / max) * 100)}%`,
                    background: v === null ? undefined : YEAR_COLORS[year],
                  }}
                />
                <span>{String(year).slice(2)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
