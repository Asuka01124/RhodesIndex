import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, RotateCcw, Search, X } from 'lucide-react';
import type { Filters, Operator } from './types';
import { EMPTY_FILTERS, matchesOperator, YEARS } from './domain';
import { PROFESSIONS } from './data';
import { Segmented } from './ui';
import { collaborationRoster } from './collaborations';

export function FilterPanel({
  filters,
  years,
  operators,
  onApply,
  onClose,
  showYears = true,
  includeCollaborations = true,
}: {
  filters: Filters;
  years: number[];
  operators: Operator[];
  onApply: (filters: Filters, years: number[]) => void;
  onClose: () => void;
  showYears?: boolean;
  includeCollaborations?: boolean;
}) {
  const [draft, setDraft] = useState<Filters>({ ...filters });
  const [first, setFirst] = useState(years.length ? Math.min(...years) : 2019);
  const [last, setLast] = useState(years.length ? Math.max(...years) : 2026);
  const [factionSearch, setFactionSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const factions = useMemo(
    () =>
      [...new Set(operators.flatMap((o) => o.factions))].sort((a, b) =>
        a.localeCompare(b, 'zh-CN'),
      ),
    [operators],
  );
  const count = collaborationRoster(operators, includeCollaborations).filter((operator) =>
    matchesOperator(operator, draft),
  ).length;
  const toggle = (key: 'professions' | 'factions', value: string) =>
    setDraft((previous) => ({
      ...previous,
      [key]: previous[key].includes(value)
        ? previous[key].filter((v) => v !== value)
        : [...previous[key], value],
    }));
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handlePointer = (event: PointerEvent) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !(event.target as HTMLElement).closest('[data-filter-trigger], [data-collaboration-toggle]')
      )
        onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="filter-panel"
      role="dialog"
      aria-label="筛选干员"
      id="operator-filters"
    >
      <div className="filter-heading">
        <div>
          <h2>找到你关心的干员</h2>
          <p>选择条件，缩小热爱的范围。</p>
        </div>
        <button className="icon-button" aria-label="关闭筛选" onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="filter-body">
        <fieldset>
          <legend>
            干员职业 <small>可多选</small>
          </legend>
          <div className="filter-chips">
            <button
              className={!draft.professions.length ? 'active' : ''}
              aria-pressed={!draft.professions.length}
              onClick={() => setDraft({ ...draft, professions: [] })}
            >
              全部职业
            </button>
            {PROFESSIONS.map((p) => (
              <button
                key={p}
                aria-pressed={draft.professions.includes(p)}
                className={draft.professions.includes(p) ? 'active' : ''}
                onClick={() => toggle('professions', p)}
              >
                {p}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>
            所属阵营 <small>可多选</small>
          </legend>
          <label className="faction-search">
            <Search size={14} aria-hidden="true" />
            <input
              aria-label="搜索阵营"
              placeholder="搜索阵营，例如：拉特兰"
              value={factionSearch}
              onChange={(e) => setFactionSearch(e.target.value)}
            />
          </label>
          <div className="filter-chips faction-chips">
            <button
              className={!draft.factions.length ? 'active' : ''}
              aria-pressed={!draft.factions.length}
              onClick={() => setDraft({ ...draft, factions: [] })}
            >
              全部阵营
            </button>
            {factions
              .filter((f) => f.includes(factionSearch))
              .map((f) => (
                <button
                  key={f}
                  className={draft.factions.includes(f) ? 'active' : ''}
                  aria-pressed={draft.factions.includes(f)}
                  onClick={() => toggle('factions', f)}
                >
                  {f}
                </button>
              ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>干员性别</legend>
          <Segmented
            label="干员性别"
            value={draft.gender}
            options={(['全部', '女', '男', '其他'] as const).map((value) => ({
              value,
              label: value === '其他' ? '其他／未知' : value,
            }))}
            onChange={(gender) => setDraft({ ...draft, gender })}
          />
        </fieldset>
        <fieldset>
          <legend>
            最低星级 <strong>{draft.minRarity} 星</strong>
          </legend>
          <input
            className="range"
            aria-label="最低星级"
            type="range"
            min={1}
            max={6}
            step={1}
            value={draft.minRarity}
            onChange={(e) => setDraft({ ...draft, minRarity: Number(e.target.value) })}
          />
          <div className="range-labels">
            <span>1 星 · 不限</span>
            <span>6 星</span>
          </div>
        </fieldset>
        {showYears && (
          <fieldset>
            <legend>
              统计年份{' '}
              <strong>
                {first} — {last}
              </strong>
            </legend>
            <div className="year-ranges">
              <label>
                起始
                <input
                  aria-label="起始年份"
                  className="range"
                  type="range"
                  min={2019}
                  max={2026}
                  value={first}
                  onChange={(e) => setFirst(Math.min(Number(e.target.value), last))}
                />
                <span>{first}</span>
              </label>
              <label>
                结束
                <input
                  aria-label="结束年份"
                  className="range"
                  type="range"
                  min={2019}
                  max={2026}
                  value={last}
                  onChange={(e) => setLast(Math.max(Number(e.target.value), first))}
                />
                <span>{last}</span>
              </label>
            </div>
          </fieldset>
        )}
      </div>
      <div className="filter-footer">
        <button
          className="text-button"
          onClick={() => {
            setDraft({ ...EMPTY_FILTERS });
            setFirst(2019);
            setLast(2026);
            setFactionSearch('');
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          重置
        </button>
        <button
          className="primary-button"
          onClick={() =>
            onApply(
              draft,
              YEARS.filter((year) => year >= first && year <= last),
            )
          }
        >
          查看 {count} 位干员
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
