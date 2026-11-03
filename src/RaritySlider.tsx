import type { CSSProperties } from 'react';
import type { RarityTier } from './types';

const TIERS: readonly { value: RarityTier; label: string }[] = [
  { value: 3, label: '≤3星' },
  { value: 4, label: '4星' },
  { value: 5, label: '5星' },
  { value: 6, label: '6星' },
];

export function RaritySlider({
  value,
  onChange,
}: {
  value: readonly RarityTier[];
  onChange: (value: RarityTier[]) => void;
}) {
  const toggle = (tier: RarityTier) => {
    if (value.includes(tier)) {
      if (value.length === 1) return;
      onChange(value.filter((current) => current !== tier));
      return;
    }
    onChange([...value, tier].sort((a, b) => a - b));
  };
  return (
    <div
      className="segmented rarity-segmented rarity-segmented-multi"
      role="group"
      aria-label="星级（可多选）"
      style={{ '--segments': TIERS.length } as CSSProperties}
    >
      {TIERS.map((tier) => {
        const selected = value.includes(tier.value);
        return (
          <button
            key={tier.value}
            type="button"
            aria-pressed={selected}
            className={selected ? 'selected' : ''}
            onClick={() => toggle(tier.value)}
          >
            <span className="rarity-pill">{tier.label}</span>
          </button>
        );
      })}
    </div>
  );
}
