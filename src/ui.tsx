import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { PenLine, Trees, X } from 'lucide-react';
import {
  siPixiv,
  siBilibili,
  siSinaweibo,
  siX,
  siYoutube,
  siXiaohongshu,
  siTiktok,
  siTumblr,
  siBluesky,
} from 'simple-icons';

const brands = {
  pixiv: siPixiv,
  bilibili: siBilibili,
  weibo: siSinaweibo,
  sinaweibo: siSinaweibo,
  x: siX,
  youtube: siYoutube,
  xiaohongshu: siXiaohongshu,
  tiktok: siTiktok,
  tumblr: siTumblr,
  bluesky: siBluesky,
};

export function RankingNotice() {
  return <span className="summary-tag">同名话题仍影响排名，请自行甄别</span>;
}

export function BrandIcon({ name, size = 18 }: { name: string; size?: number }) {
  if (name === 'skland') return <Trees size={size} strokeWidth={1.6} aria-hidden="true" />;
  const brand = brands[name as keyof typeof brands];
  if (!brand) return <PenLine size={size} strokeWidth={1.6} aria-hidden="true" />;
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d={brand.path} />
    </svg>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <div
      className={`segmented ${className}`}
      role="radiogroup"
      aria-label={label}
      style={
        {
          '--segments': options.length,
          '--selected': index,
        } as CSSProperties
      }
    >
      <span className="segment-thumb" aria-hidden="true" />
      {options.map((option, i) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          className={value === option.value ? 'selected' : ''}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (
              ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)
            ) {
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? options.length - 1
                    : (i +
                        (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) +
                        options.length) %
                      options.length;
              onChange(options[next].value);
              (
                event.currentTarget.parentElement?.querySelectorAll('button')[
                  next
                ] as HTMLButtonElement
              )?.focus();
            }
          }}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  drawer = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? 'dialog drawer' : 'dialog'}
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function downloadFile(
  filename: string,
  content: string,
  type = 'application/json;charset=utf-8',
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
