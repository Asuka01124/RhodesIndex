import { useMemo, useState } from 'react';
import { ChevronDown, EyeOff, X } from 'lucide-react';
import type { Operator } from './types';

const COLLAPSE_LIMIT = 8;

export function HiddenOperatorsBar({
  hiddenIds,
  operators,
  onRestore,
  onRestoreAll,
}: {
  hiddenIds: readonly string[];
  operators: readonly Operator[];
  onRestore: (id: string) => void;
  onRestoreAll: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const hiddenOperators = useMemo(() => {
    if (!hiddenIds.length || !operators.length) return [];
    const index = new Map(operators.map((op) => [op.id, op]));
    return hiddenIds.map((id) => index.get(id)).filter((op): op is Operator => Boolean(op));
  }, [hiddenIds, operators]);

  if (!hiddenOperators.length) return null;

  const isCollapsible = hiddenOperators.length > COLLAPSE_LIMIT;
  const isExpanded = isCollapsible && expanded;
  const visibleOperators = isExpanded ? hiddenOperators : hiddenOperators.slice(0, COLLAPSE_LIMIT);

  return (
    <div className="hidden-operators-bar" role="region" aria-label="已隐藏干员">
      <span className="hidden-operators-label">
        <EyeOff size={13} aria-hidden="true" />
        已隐藏 {hiddenOperators.length} 位：
      </span>
      <div className="hidden-operators-chips">
        {visibleOperators.map((op) => (
          <button
            key={op.id}
            type="button"
            className="hidden-operator-chip"
            onClick={() => onRestore(op.id)}
            title={`恢复显示 ${op.name}`}
            aria-label={`恢复显示${op.name}`}
          >
            <img src={op.avatar} alt="" width={18} height={18} loading="lazy" />
            <span>{op.name}</span>
            <X size={11} aria-hidden="true" />
          </button>
        ))}
        {isCollapsible && (
          <button
            type="button"
            className={`hidden-operators-expand ${isExpanded ? 'expanded' : ''}`}
            aria-expanded={isExpanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{isExpanded ? '收起' : `展开全部 ${hiddenOperators.length} 位`}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="clear-filters hidden-operators-restore-all"
          onClick={onRestoreAll}
        >
          全部恢复
        </button>
      </div>
    </div>
  );
}
