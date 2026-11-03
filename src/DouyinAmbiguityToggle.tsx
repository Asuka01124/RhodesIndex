import { useEffect, useId, useRef, useState } from 'react';

export function DouyinAmbiguityToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = useId();
  const controlRef = useRef<HTMLSpanElement>(null);
  const [showDescription, setShowDescription] = useState(false);
  useEffect(() => {
    if (!showDescription) return;
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowDescription(false);
        event.stopPropagation();
      }
    };
    const dismissOutside = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) setShowDescription(false);
    };
    window.addEventListener('keydown', dismissWithEscape, true);
    window.addEventListener('pointerdown', dismissOutside);
    return () => {
      window.removeEventListener('keydown', dismissWithEscape, true);
      window.removeEventListener('pointerdown', dismissOutside);
    };
  }, [showDescription]);
  return (
    <span
      ref={controlRef}
      className="douyin-ambiguity-control"
      onMouseEnter={() => setShowDescription(true)}
      onMouseLeave={() => setShowDescription(false)}
      onFocus={() => setShowDescription(true)}
      onBlur={() => setShowDescription(false)}
    >
      <button
        type="button"
        role="switch"
        aria-label="隐藏同名"
        aria-checked={checked}
        aria-describedby={descriptionId}
        className="collaboration-toggle"
        onClick={() => {
          setShowDescription(true);
          onChange(!checked);
        }}
      >
        <span>隐藏同名</span>
        <span className="collaboration-switch" aria-hidden="true">
          <span />
        </span>
      </button>
      <span
        id={descriptionId}
        role="tooltip"
        className="douyin-ambiguity-tooltip"
        hidden={!showDescription}
      >
        隐藏播放量 10 亿及以上的同名话题结果，减少无关内容对排行的干扰。关闭后可查看全部数据。
      </span>
    </span>
  );
}
