import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { compactNumber } from './domain';
import { YEAR_COLORS } from './data';
import { buildEntries, squarify } from './treemap';
import type { TreemapEntry } from './treemap';
import type { Operator, RankedOperator } from './types';

const GAP = 4;

interface Tip {
  x: number;
  y: number;
  entry: TreemapEntry;
}

function heatFill(ratio: number) {
  const pct = Math.round(14 + ratio * 80);
  return {
    bg: `color-mix(in srgb, #0071e3 ${pct}%, #eef4fc)`,
    fg: ratio > 0.52 ? '#ffffff' : '#1d1d1f',
    sub: ratio > 0.52 ? 'rgb(255 255 255 / 84%)' : '#6e6e73',
  };
}

function containerHeight(width: number, count: number) {
  const mobile = width < 560;
  if (count <= 1) return mobile ? 220 : 260;
  if (count <= 3) return mobile ? 260 : 300;
  if (count <= 6) return mobile ? 360 : 380;
  if (count <= 12) return mobile ? 460 : 460;
  if (count <= 20) return mobile ? 560 : 540;
  return mobile
    ? Math.max(620, Math.round(width * 1.75))
    : Math.min(680, Math.max(520, Math.round(width * 0.54)));
}

export function TreemapHeatmap({
  rows,
  entries: customEntries,
  years,
  metricLabel,
  onSelect,
}: {
  rows?: RankedOperator[];
  entries?: TreemapEntry[];
  years?: number[];
  metricLabel: string;
  onSelect: (operator: Operator) => void;
}) {
  const sortedYears = useMemo(() => (years ? [...years].sort((a, b) => a - b) : []), [years]);
  const entries = useMemo(() => customEntries ?? buildEntries(rows ?? []), [customEntries, rows]);
  const count = entries.length;

  const mapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const height = width ? containerHeight(width, count) : 360;
  const total = useMemo(() => entries.reduce((s, e) => s + e.value, 0), [entries]);
  const maxValue = useMemo(() => Math.max(1, ...entries.map((e) => e.value)), [entries]);

  const tiles = useMemo(
    () => (width && height ? squarify(entries, 0, 0, width, height) : []),
    [entries, width, height],
  );

  const [tip, setTip] = useState<Tip | null>(null);
  const moveTip = (event: MouseEvent, entry: TreemapEntry) => {
    const tipW = 236;
    const pad = 14;
    let x = event.clientX + pad;
    if (x + tipW > window.innerWidth) x = event.clientX - tipW - pad;
    const y = Math.min(event.clientY + pad, window.innerHeight - 210);
    setTip({ x: Math.max(8, x), y: Math.max(8, y), entry });
  };

  return (
    <div className="treemap-view">
      <div
        ref={mapRef}
        className="treemap-map"
        style={{ height }}
        onMouseLeave={() => setTip(null)}
      >
        {tiles.map((t) => {
          const entry = t.item;
          const op = entry.operator;
          const w = Math.max(0, t.w - GAP);
          const h = Math.max(0, t.h - GAP);
          const ratio = Math.sqrt(entry.value / maxValue);
          const color = heatFill(ratio);
          const minSide = Math.min(w, h);
          const fs = Math.max(11, Math.min(20, Math.round(minSide * 0.13)));
          const avatar = Math.max(28, Math.min(64, Math.round(minSide * 0.34)));
          const labelValue = entry.displayValue ?? compactNumber(entry.value);
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
              aria-label={`${op.name}，${metricLabel} ${entry.displayValue ?? entry.value.toLocaleString('zh-CN')}`}
              onMouseEnter={(event) => moveTip(event, entry)}
              onMouseMove={(event) => moveTip(event, entry)}
              onClick={() => onSelect(op)}
            >
              {w >= 68 && h >= 68 ? (
                <>
                  <img src={op.avatar} width={avatar} height={avatar} alt="" loading="lazy" />
                  <span className="tile-name" style={{ fontSize: fs }}>
                    {op.name}
                  </span>
                  <span
                    className="tile-value"
                    style={{ fontSize: Math.max(11, Math.round(fs * 0.78)) }}
                  >
                    {labelValue}
                  </span>
                </>
              ) : w >= 46 && h >= 32 ? (
                <>
                  <span className="tile-name" style={{ fontSize: Math.min(fs, 14) }}>
                    {op.name}
                  </span>
                  <span className="tile-value" style={{ fontSize: 11 }}>
                    {labelValue}
                  </span>
                </>
              ) : w >= 24 && h >= 16 ? (
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
  const op = entry.operator;
  const yearly = entry.yearly;
  const values = yearly ? years.map((year) => yearly[year] ?? null) : [];
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const share = total > 0 ? ((entry.value / total) * 100).toFixed(1) : '0.0';
  const labelValue = entry.displayValue ?? compactNumber(entry.value);
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
          <dt>{yearly ? `累计${metricLabel}` : metricLabel}</dt>
          <dd>{labelValue}</dd>
        </div>
        <div>
          <dt>占比</dt>
          <dd>{share}%</dd>
        </div>
      </dl>
      {yearly && years.length > 1 && (
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
