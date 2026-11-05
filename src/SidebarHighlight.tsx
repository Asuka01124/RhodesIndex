import { useCallback, useLayoutEffect, useRef } from 'react';

export function SidebarHighlight({
  selection,
  collapsed,
  orderKey,
  dragging,
}: {
  selection: string;
  collapsed: boolean;
  orderKey?: string;
  dragging?: boolean;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const previous = useRef<number[] | null>(null);

  const measure = useCallback((animate: boolean) => {
    const layer = layerRef.current;
    const sidebar = layer?.parentElement;
    const thumb = thumbRef.current;
    const active = sidebar?.querySelector<HTMLElement>('.nav-item.active');
    if (!sidebar || !layer || !thumb || !active) return;

    const bounds = sidebar.getBoundingClientRect();
    const target = active.getBoundingClientRect();
    const scroll = active.closest('.nav-scroll')?.getBoundingClientRect();
    const geometry = [
      target.left - bounds.left - sidebar.clientLeft,
      target.top - bounds.top - sidebar.clientTop,
      target.width,
      target.height,
      scroll ? Math.max(0, scroll.top - bounds.top) : 0,
      scroll ? Math.max(0, bounds.bottom - scroll.bottom) : 0,
    ];
    if (previous.current?.every((value, i) => Math.abs(value - geometry[i]) < 0.1)) return;

    layer.dataset.animate = String(animate && previous.current !== null);
    layer.style.clipPath = `inset(${geometry[4]}px 0 ${geometry[5]}px 0)`;
    thumb.style.width = `${geometry[2]}px`;
    thumb.style.height = `${geometry[3]}px`;
    thumb.style.transform = `translate3d(${geometry[0]}px, ${geometry[1]}px, 0)`;
    layer.dataset.ready = 'true';
    previous.current = geometry;
  }, []);

  useLayoutEffect(() => {
    measure(true);
  }, [measure, selection, collapsed]);

  useLayoutEffect(() => {
    if (!dragging) measure(false);
  }, [measure, orderKey, dragging]);

  useLayoutEffect(() => {
    const sidebar = layerRef.current?.parentElement;
    if (!sidebar) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measure(false));
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(sidebar);
    sidebar.querySelectorAll('.nav-scroll, nav, .nav-item, .sidebar-bottom').forEach((element) => {
      observer.observe(element);
    });
    sidebar.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      sidebar.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [measure]);

  return (
    <div
      ref={layerRef}
      className="sidebar-selection-layer"
      data-dragging={dragging ? 'true' : undefined}
      aria-hidden="true"
    >
      <div ref={thumbRef} className="sidebar-selection-thumb" />
    </div>
  );
}
