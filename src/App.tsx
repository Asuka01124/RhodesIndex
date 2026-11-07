import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Database,
  Eye,
  EyeOff,
  Grid2X2,
  Heart,
  Info,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';
import type {
  Filters,
  HeatRecord,
  Metric,
  Operator,
  RankedOperator,
  PlatformId,
  ViewMode,
} from './types';
import {
  compactNumber,
  DEFAULT_FILTERS,
  EMPTY_FILTERS,
  filterCount,
  rankOperators,
  YEARS,
} from './domain';
import { PLATFORMS, YEAR_COLORS } from './data';
import { BrandIcon, Modal, RankingNotice, Segmented } from './ui';
import { FilterPanel } from './Filters';
import { preloadTagSnapshots, usePixivSummary } from './useTagCounts';
import { effectivePixivFilters, filterPixivRecords, PIXIV_METRICS } from './pixiv';
import { SidebarHighlight } from './SidebarHighlight';
import { BilibiliCountsPage, BilibiliCountInfo } from './BilibiliCountsPage';
import { CollaborationToggle } from './CollaborationToggle';
import { collaborationRoster } from './collaborations';
import { publicUrl } from './publicUrls';
import { RaritySlider } from './RaritySlider';
import { TreemapHeatmap } from './TreemapHeatmap';
import { FavoritesMatrixPage } from './FavoritesMatrixPage';
import { HiddenOperatorsBar } from './HiddenOperatorsBar';
import {
  clearHiddenOperators,
  type HiddenByPlatform,
  isOperatorHidden,
  normalizeHiddenByPlatform,
  restoreHiddenOperator,
  toggleHiddenOperator,
} from './hiddenOperators';

const initialParams = new URLSearchParams(window.location.search);
type PageScope = PlatformId | 'skland';
const DEFAULT_PLATFORM = 'bilibili';
const sklandPosition = PLATFORMS.findIndex((platform) => platform.id === 'lofter');
const navigationPlatforms = [
  ...PLATFORMS.slice(0, sklandPosition),
  { id: 'skland', name: '森空岛', icon: 'skland' } as const,
  ...PLATFORMS.slice(sklandPosition),
];
const supportedScopes: readonly string[] = navigationPlatforms.map((platform) => platform.id);
const defaultPlatformOrder: readonly PageScope[] = navigationPlatforms.map(
  (platform) => platform.id,
);
const NAV_LONG_PRESS_MS = 350;
const INITIAL_VISIBLE = 100;
function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(`rhodes.${key}`);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(`rhodes.${key}`, JSON.stringify(value));
  } catch {
    /* 界面偏好不影响数据正确性。 */
  }
}
function normalizePlatformOrder(stored: unknown): PageScope[] {
  const valid = Array.isArray(stored)
    ? stored.filter((id): id is PageScope => typeof id === 'string' && supportedScopes.includes(id))
    : [];
  const unique = [...new Set(valid)];
  for (const id of defaultPlatformOrder) {
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

export default function App() {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [platformOrder, setPlatformOrder] = useState<PageScope[]>(() =>
    normalizePlatformOrder(readLocal<unknown>('platformOrder', defaultPlatformOrder)),
  );
  const orderedPlatforms = useMemo(
    () =>
      platformOrder
        .map((id) => navigationPlatforms.find((platform) => platform.id === id))
        .filter((platform): platform is (typeof navigationPlatforms)[number] => Boolean(platform)),
    [platformOrder],
  );
  const homePlatform = orderedPlatforms[0]?.id ?? DEFAULT_PLATFORM;
  const homePlatformName = orderedPlatforms[0]?.name ?? '哔哩哔哩';
  const [pageScope, setPageScope] = useState<PageScope>(() => {
    const urlPlatform = initialParams.get('platform') ?? '';
    if (supportedScopes.includes(urlPlatform)) return urlPlatform as PageScope;
    return (
      normalizePlatformOrder(readLocal<unknown>('platformOrder', defaultPlatformOrder))[0] ??
      DEFAULT_PLATFORM
    );
  });
  const scope = pageScope === 'skland' ? DEFAULT_PLATFORM : pageScope;
  const [generalMetric, setGeneralMetric] = useState<Metric>(
    initialParams.get('metric') === 'views' ? 'views' : 'likes',
  );
  const [pixivMetric, setPixivMetric] = useState<Metric>(
    PIXIV_METRICS.find((option) => option.value === initialParams.get('metric'))?.value ??
      'workCount',
  );
  const metric = scope === 'pixiv' ? pixivMetric : generalMetric;
  const setMetric = scope === 'pixiv' ? setPixivMetric : setGeneralMetric;
  const [view, setView] = useState<ViewMode>(
    initialParams.get('view') === 'heatmap' ? 'heatmap' : 'bars',
  );
  const [query, setQuery] = useState(initialParams.get('q') ?? '');
  const [years, setYears] = useState<number[]>(() => {
    const parsed = [
      ...new Set(
        (initialParams.get('years') ?? '')
          .split(',')
          .map(Number)
          .filter((y) => YEARS.includes(y)),
      ),
    ].sort();
    return initialParams.has('years') ? parsed : YEARS;
  });
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [includeCollaborations, setIncludeCollaborations] = useState(true);
  const [sort, setSort] = useState<'asc' | 'desc'>('desc');
  const [showAll, setShowAll] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    const stored = readLocal<unknown>('favorites', []);
    return new Set(Array.isArray(stored) ? stored.filter((x) => typeof x === 'string') : []);
  });
  const [hiddenByPlatform, setHiddenByPlatform] = useState<HiddenByPlatform>(() =>
    normalizeHiddenByPlatform(readLocal<unknown>('hiddenOperators', {})),
  );
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [pageTransitionId, setPageTransitionId] = useState(0);
  const [pageEntering, setPageEntering] = useState(true);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 650px)').matches);
  const [collapsed, setCollapsed] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const isTagSummary =
    pageScope === 'bilibili' ||
    pageScope === 'lofter' ||
    pageScope === 'douyin' ||
    pageScope === 'xiaohongshu' ||
    pageScope === 'weibo' ||
    pageScope === 'skland';
  const pixiv = usePixivSummary(scope === 'pixiv' || favoritesOnly);
  const [detail, setDetail] = useState<Operator | null>(null);
  const [toast, setToast] = useState('');
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    title: string;
    value: string;
    color: string;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navListRef = useRef<HTMLElement>(null);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const suppressNavClickRef = useRef(false);
  const navDragCleanupRef = useRef<(() => void) | null>(null);
  const [navDrag, setNavDrag] = useState<{
    id: PageScope;
    originIndex: number;
    targetIndex: number;
    offsetY: number;
    stepHeight: number;
  } | null>(null);
  const deferredQuery = useDeferredValue(query);
  const activePlatform = PLATFORMS.find((p) => p.id === scope);
  const platformName = activePlatform?.name ?? '哔哩哔哩';
  const metricLabel =
    metric === 'views' && scope !== 'pixiv'
      ? '观看量'
      : PIXIV_METRICS.find((option) => option.value === metric)!.label;
  const metricUnit = metric === 'workCount' ? '件' : '次';
  const annualCounts =
    scope === 'pixiv' &&
    metric === 'workCount' &&
    pixiv.data?.metadata.countMethod === 'chinese_base_tag_year_total';
  const pixivFilters = useMemo(
    () => effectivePixivFilters(filters, annualCounts),
    [filters, annualCounts],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    fetch(publicUrl('data/operators.json'), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('档案加载失败');
        return response.json() as Promise<Operator[]>;
      })
      .then((data) => {
        if (!Array.isArray(data) || !data.length) throw new Error('档案格式无效');
        setOperators(data.map((operator) => ({ ...operator, avatar: publicUrl(operator.avatar) })));
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setLoadError(true);
      });
    return () => controller.abort();
  }, [loadAttempt]);
  const rosterReady = operators.length > 0;
  useEffect(() => {
    if (rosterReady) return preloadTagSnapshots();
  }, [rosterReady]);
  useEffect(() => {
    if (!rosterReady) return;
    setPageEntering(true);
    const timer = window.setTimeout(() => setPageEntering(false), 1100);
    return () => window.clearTimeout(timer);
  }, [pageTransitionId, rosterReady]);

  const sourceRecords =
    metric === 'workCount'
      ? (pixiv.data?.countRecords ?? pixiv.data?.records ?? [])
      : (pixiv.data?.records ?? []);
  const records = useMemo(
    () => (scope === 'pixiv' ? filterPixivRecords(sourceRecords, pixivFilters) : sourceRecords),
    [scope, sourceRecords, pixivFilters],
  );
  const visibleOperators = useMemo(
    () =>
      collaborationRoster(operators, includeCollaborations).filter(
        (operator) => !annualCounts || pixiv.data?.metadata.countOperatorIds?.includes(operator.id),
      ),
    [operators, includeCollaborations, annualCounts, pixiv.data],
  );
  const activeYears = view === 'heatmap' ? YEARS : years;
  const knownCountOperators = useMemo(
    () =>
      new Set(
        (scope === 'pixiv' && metric === 'workCount') || favoritesOnly
          ? (
              pixiv.data?.metadata.countOperatorIds ??
              pixiv.data?.metadata.operatorIds ??
              []
            ).filter((id) => !pixiv.data?.metadata.unknownYearCounts?.[id])
          : [],
      ),
    [scope, metric, favoritesOnly, pixiv.data],
  );
  const currentHiddenIds = useMemo(
    () => (favoritesOnly ? [] : (hiddenByPlatform[pageScope] ?? [])),
    [favoritesOnly, hiddenByPlatform, pageScope],
  );
  const currentHiddenSet = useMemo(() => new Set(currentHiddenIds), [currentHiddenIds]);
  const ranked = useMemo(
    () =>
      rankOperators(
        visibleOperators,
        records,
        scope,
        metric,
        activeYears,
        filters,
        deferredQuery,
        sort,
        favoritesOnly ? favorites : undefined,
        knownCountOperators,
        currentHiddenSet,
      ),
    [
      visibleOperators,
      records,
      scope,
      metric,
      activeYears,
      filters,
      deferredQuery,
      sort,
      favoritesOnly,
      knownCountOperators,
      favorites,
      currentHiddenSet,
    ],
  );
  const availableRows = useMemo(() => ranked.filter((r) => r.available), [ranked]);
  const pageRows = showAll ? ranked : ranked.slice(0, INITIAL_VISIBLE);
  const maxValue = Math.max(1, ...availableRows.map((r) => r.total));
  const activeFilters = filterCount(pixivFilters, scope === 'pixiv');
  const hasData = availableRows.length > 0;
  const closeFilters = useCallback(() => {
    setFilterOpen(false);
    filterRef.current?.focus();
  }, []);

  useEffect(() => {
    setShowAll(false);
    setTooltip(null);
  }, [
    pageScope,
    metric,
    years,
    filters,
    includeCollaborations,
    deferredQuery,
    favoritesOnly,
    sort,
    currentHiddenSet,
  ]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (pageScope !== homePlatform) params.set('platform', pageScope);
    if (!isTagSummary && metric !== 'likes') params.set('metric', metric);
    if (view !== 'bars') params.set('view', view);
    if (query) params.set('q', query);
    if (!isTagSummary && years.length !== YEARS.length) params.set('years', years.join(','));
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    );
  }, [pageScope, homePlatform, isTagSummary, metric, view, query, years]);
  useEffect(() => () => navDragCleanupRef.current?.(), []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName;
      if (
        event.key === '/' &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) &&
        !dataOpen &&
        !detail &&
        !document.querySelector('dialog[open]') &&
        !filterOpen &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') {
        setMobileMenu(false);
        setTooltip(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dataOpen, detail, filterOpen]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const hide = () => setTooltip(null);
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 650px)');
    const update = () => {
      setIsMobile(media.matches);
      if (!media.matches) setMobileMenu(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobileMenu || !isMobile) return;
    const sidebar = sidebarRef.current;
    const buttons = sidebar?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
    const visibleButtons = buttons
      ? [...buttons].filter(
          (button) => button.getClientRects().length && getComputedStyle(button).display !== 'none',
        )
      : [];
    visibleButtons[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !visibleButtons.length) return;
      const first = visibleButtons[0];
      const last = visibleButtons[visibleButtons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      mobileToggleRef.current?.focus();
    };
  }, [mobileMenu, isMobile]);

  function changePlatform(value: PageScope) {
    setPageScope(value);
    setFavoritesOnly(false);
    setMobileMenu(false);
    setFilterOpen(false);
    setPageTransitionId((id) => id + 1);
    setPageEntering(true);
    window.scrollTo(0, 0);
  }
  function startNavPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    id: PageScope,
    originIndex: number,
  ) {
    if (event.button !== 0) return;
    navDragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const buttonEl = event.currentTarget;
    const scrollEl = buttonEl.closest('.nav-scroll');
    let activeDrag: {
      originIndex: number;
      targetIndex: number;
      stepHeight: number;
      maxIndex: number;
    } | null = null;

    const timer = window.setTimeout(() => {
      const items = navListRef.current
        ? [...navListRef.current.querySelectorAll<HTMLElement>('.nav-item')]
        : [];
      const stepHeight =
        items.length > 1
          ? Math.max(
              36,
              items[1].getBoundingClientRect().top - items[0].getBoundingClientRect().top,
            )
          : (buttonEl.getBoundingClientRect().height || 41) + 3;
      const maxIndex = Math.max(0, items.length - 1);
      suppressNavClickRef.current = true;
      activeDrag = {
        originIndex,
        targetIndex: originIndex,
        stepHeight,
        maxIndex,
      };
      setNavDrag({
        id,
        originIndex,
        targetIndex: originIndex,
        offsetY: 0,
        stepHeight,
      });
      try {
        buttonEl.setPointerCapture?.(pointerId);
      } catch {
        /* 忽略不支持指针捕获的环境 */
      }
      try {
        navigator.vibrate?.(12);
      } catch {
        /* 忽略不支持振动的设备 */
      }
    }, NAV_LONG_PRESS_MS);

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!activeDrag) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 6) {
          cleanup();
        }
        return;
      }
      moveEvent.preventDefault();
      const rawDeltaY = moveEvent.clientY - startY;
      const minOffset = -activeDrag.originIndex * activeDrag.stepHeight;
      const maxOffset = (activeDrag.maxIndex - activeDrag.originIndex) * activeDrag.stepHeight;
      const offsetY = Math.max(minOffset, Math.min(maxOffset, rawDeltaY));
      const targetIndex = Math.max(
        0,
        Math.min(
          activeDrag.maxIndex,
          Math.round(activeDrag.originIndex + offsetY / activeDrag.stepHeight),
        ),
      );
      activeDrag.targetIndex = targetIndex;
      setNavDrag({
        id,
        originIndex: activeDrag.originIndex,
        targetIndex,
        offsetY,
        stepHeight: activeDrag.stepHeight,
      });
    };

    const handleEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      if (activeDrag) {
        const { originIndex: fromIndex, targetIndex: toIndex } = activeDrag;
        if (fromIndex !== toIndex) {
          setPlatformOrder((previous) => {
            const next = [...previous];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            writeLocal('platformOrder', next);
            return next;
          });
        }
        setNavDrag(null);
        window.setTimeout(() => {
          suppressNavClickRef.current = false;
        }, 80);
      }
      cleanup();
    };

    const handleScroll = () => {
      if (!activeDrag) cleanup();
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      scrollEl?.removeEventListener('scroll', handleScroll);
      if (navDragCleanupRef.current === cleanup) {
        navDragCleanupRef.current = null;
      }
    };

    navDragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
    scrollEl?.addEventListener('scroll', handleScroll, { passive: true });
  }
  function toggleFavorite(id: string, sharedIds?: string[]) {
    const next = new Set(favorites);
    const selected = (sharedIds ?? [id]).filter((member) => next.has(member));
    if (selected.length) {
      selected.forEach((member) => next.delete(member));
      setToast('已移出我的关注');
    } else {
      next.add(id);
      setToast('已加入我的关注');
    }
    setFavorites(next);
    writeLocal('favorites', [...next]);
  }
  function handleToggleHide(platformKey: string, id: string, sharedIds?: string[]) {
    const opName = operators.find((o) => o.id === id)?.name;
    const { next, hidden } = toggleHiddenOperator(hiddenByPlatform, platformKey, id, sharedIds);
    setHiddenByPlatform(next);
    writeLocal('hiddenOperators', next);
    if (opName) {
      setToast(hidden ? `已隐藏「${opName}」` : `已恢复显示「${opName}」`);
    }
  }
  function handleRestoreHidden(platformKey: string, id: string) {
    const opName = operators.find((o) => o.id === id)?.name;
    const next = restoreHiddenOperator(hiddenByPlatform, platformKey, id);
    setHiddenByPlatform(next);
    writeLocal('hiddenOperators', next);
    if (opName) {
      setToast(`已恢复显示「${opName}」`);
    }
  }
  function handleClearHidden(platformKey: string) {
    const next = clearHiddenOperators(hiddenByPlatform, platformKey);
    setHiddenByPlatform(next);
    writeLocal('hiddenOperators', next);
    setToast('已恢复全部隐藏干员');
  }
  function showTooltip(event: MouseEvent<HTMLElement>, row: RankedOperator, year: number) {
    const value = row.yearly[year];
    setTooltip({
      x: Math.max(105, Math.min(window.innerWidth - 110, event.clientX)),
      y: Math.max(100, event.clientY - 12),
      title: `${row.operator.name} · ${year}`,
      value:
        value === null
          ? '未提供数据'
          : `${value.toLocaleString('zh-CN')} ${metricUnit}${metricLabel}`,
      color: YEAR_COLORS[year],
    });
  }
  function resetAll() {
    setFilters((previous) => ({ ...EMPTY_FILTERS, rarityTiers: previous.rarityTiers }));
    setYears(YEARS);
    setQuery('');
    setFavoritesOnly(false);
  }
  const operatorButton = (row: RankedOperator) => (
    <div className="operator-cell">
      <button
        className="operator-button"
        onClick={() => setDetail(row.operator)}
        aria-label={`查看${row.operator.name}详情`}
      >
        <img src={row.operator.avatar} alt="" width={42} height={42} loading="lazy" />
        <span>
          <strong>
            {row.operator.name}
            {favorites.has(row.operator.id) && (
              <Heart size={10} fill="currentColor" aria-label="已关注" />
            )}
          </strong>
          <small>
            {row.operator.profession}
            <span className="name-dot">·</span>
            {row.operator.factions[0] || '未知阵营'}
          </small>
        </span>
      </button>
      <button
        type="button"
        className="row-hide-button"
        aria-label={`隐藏${row.operator.name}`}
        title={`隐藏${row.operator.name}`}
        onClick={() => handleToggleHide(scope, row.operator.id)}
      >
        <EyeOff size={14} aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div
      className={`app ${collapsed ? 'sidebar-collapsed' : ''} ${mobileMenu ? 'mobile-menu-open' : ''}`}
    >
      <a className="skip-link" href="#main-content">
        跳转到主要内容
      </a>
      {mobileMenu && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭平台菜单"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        className={`sidebar ${navDrag ? 'is-dragging-nav' : ''}`}
        aria-label="平台导航"
        inert={isMobile && !mobileMenu}
      >
        <SidebarHighlight
          selection={favoritesOnly ? 'favorites' : pageScope}
          collapsed={collapsed}
          orderKey={platformOrder.join(',')}
          dragging={Boolean(navDrag)}
        />
        <button
          className="brand"
          aria-label={`罗德指数，返回${homePlatformName}`}
          onClick={() => changePlatform(homePlatform)}
        >
          <img src={publicUrl('favicon.svg')} width={42} height={42} alt="" />
          <span>
            <strong>
              罗德指数<span className="brand-dot">.</span>
            </strong>
            <small>每一份热爱，都有回响。</small>
          </span>
        </button>
        <div className="sidebar-divider" />
        <div className="nav-scroll">
          <p className="nav-label">创作热度</p>
          <nav ref={navListRef}>
            {orderedPlatforms.map((p, index) => {
              const isDraggingItem = navDrag?.id === p.id;
              let shiftY = 0;
              if (navDrag && !isDraggingItem) {
                if (
                  navDrag.originIndex < navDrag.targetIndex &&
                  index > navDrag.originIndex &&
                  index <= navDrag.targetIndex
                ) {
                  shiftY = -navDrag.stepHeight;
                } else if (
                  navDrag.originIndex > navDrag.targetIndex &&
                  index >= navDrag.targetIndex &&
                  index < navDrag.originIndex
                ) {
                  shiftY = navDrag.stepHeight;
                }
              }
              const itemStyle: CSSProperties | undefined = isDraggingItem
                ? { transform: `translate3d(0, ${navDrag.offsetY}px, 0) scale(1.03)` }
                : navDrag
                  ? { transform: `translate3d(0, ${shiftY}px, 0)` }
                  : undefined;
              return (
                <button
                  key={p.id}
                  title={p.name}
                  style={itemStyle}
                  className={`nav-item ${pageScope === p.id && !favoritesOnly ? 'active' : ''} ${isDraggingItem ? 'is-dragging' : navDrag ? 'is-shifting' : ''}`}
                  aria-current={pageScope === p.id && !favoritesOnly ? 'page' : undefined}
                  onPointerDown={(event) => startNavPointerDown(event, p.id, index)}
                  onContextMenu={(event) => {
                    if (navDrag) event.preventDefault();
                  }}
                  onClick={(event) => {
                    if (suppressNavClickRef.current) {
                      event.preventDefault();
                      suppressNavClickRef.current = false;
                      return;
                    }
                    changePlatform(p.id);
                  }}
                >
                  <BrandIcon name={p.icon} size={17} />
                  <span>{p.name}</span>
                  {pageScope === p.id && <span className="nav-active-dot" />}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="sidebar-bottom">
          <button
            title="我的关注"
            className={`nav-item ${favoritesOnly ? 'active' : ''}`}
            aria-pressed={favoritesOnly}
            onClick={() => {
              setFavoritesOnly(!favoritesOnly);
              setMobileMenu(false);
              setPageTransitionId((id) => id + 1);
              setPageEntering(true);
              window.scrollTo(0, 0);
            }}
          >
            <Heart size={17} strokeWidth={1.5} aria-hidden="true" />
            <span>我的关注</span>
            <small>{favorites.size}</small>
          </button>
          <div className="sidebar-divider" />
          <div className="sidebar-footnote">
            <span>
              为热爱，留一份记录。<small>干员档案由 PRTS 提供</small>
            </span>
            <button
              className="icon-button collapse-button"
              aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? (
                <PanelLeftOpen size={16} aria-hidden="true" />
              ) : (
                <PanelLeftClose size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </aside>

      <div className="workspace" inert={isMobile && mobileMenu}>
        <div
          key={pageTransitionId}
          className={`page-transition-stage ${pageEntering ? 'page-entering' : ''}`}
        >
          {favoritesOnly ? (
            <FavoritesMatrixPage
              operators={operators}
              favorites={favorites}
              onFavorite={toggleFavorite}
              includeCollaborations={includeCollaborations}
              onIncludeCollaborationsChange={setIncludeCollaborations}
              query={query}
              onQueryChange={setQuery}
              filters={filters}
              onFiltersChange={setFilters}
              filterOpen={filterOpen}
              onFilterOpen={() => setFilterOpen(!filterOpen)}
              onCloseFilters={closeFilters}
              searchRef={searchRef}
              filterRef={filterRef}
              mobileToggleRef={mobileToggleRef}
              mobileMenu={mobileMenu}
              onToggleMenu={() => setMobileMenu(!mobileMenu)}
              onOpenPixivDetail={(op, nextPixivMetric) => {
                setPixivMetric(nextPixivMetric);
                setDetail(op);
              }}
            />
          ) : isTagSummary ? (
            <BilibiliCountsPage
              platform={pageScope}
              operators={operators}
              view={view}
              onViewChange={setView}
              includeCollaborations={includeCollaborations}
              onIncludeCollaborationsChange={setIncludeCollaborations}
              query={query}
              onQueryChange={setQuery}
              filters={filters}
              onFiltersChange={setFilters}
              filterOpen={filterOpen}
              onFilterOpen={() => setFilterOpen(!filterOpen)}
              onCloseFilters={closeFilters}
              favorites={favorites}
              favoritesOnly={favoritesOnly}
              onClearFavorites={() => setFavoritesOnly(false)}
              onFavorite={toggleFavorite}
              hiddenIds={currentHiddenIds}
              onToggleHide={(id, sharedIds) => handleToggleHide(pageScope, id, sharedIds)}
              onRestoreHidden={(id) => handleRestoreHidden(pageScope, id)}
              onClearHidden={() => handleClearHidden(pageScope)}
              searchRef={searchRef}
              filterRef={filterRef}
              mobileToggleRef={mobileToggleRef}
              mobileMenu={mobileMenu}
              onToggleMenu={() => setMobileMenu(!mobileMenu)}
              onInfo={() => setDataOpen(true)}
            />
          ) : (
            <>
              <header className={`topbar ${scope === 'pixiv' ? 'pixiv-topbar' : ''}`}>
                <div className="breadcrumb">
                  <button
                    ref={mobileToggleRef}
                    className="icon-button mobile-menu-button"
                    aria-label="打开平台菜单"
                    aria-expanded={mobileMenu}
                    onClick={() => setMobileMenu(!mobileMenu)}
                  >
                    <Menu size={20} aria-hidden="true" />
                  </button>
                  <RaritySlider
                    value={filters.rarityTiers}
                    onChange={(rarityTiers) =>
                      setFilters((previous) => ({ ...previous, rarityTiers }))
                    }
                  />
                </div>
                <div className="header-controls">
                  <Segmented
                    label="图表类型"
                    value={view}
                    onChange={(value) => {
                      setView(value);
                      setTooltip(null);
                    }}
                    options={[
                      {
                        value: 'bars',
                        label: '条形图',
                        icon: <BarChart3 size={14} aria-hidden="true" />,
                      },
                      {
                        value: 'heatmap',
                        label: '热力图',
                        icon: <Grid2X2 size={14} aria-hidden="true" />,
                      },
                    ]}
                  />
                  {scope !== 'pixiv' && (
                    <>
                      <span className="control-divider" />
                      <Segmented
                        label="热度指标"
                        value={metric}
                        onChange={setMetric}
                        options={[
                          {
                            value: 'likes',
                            label: '点赞',
                            icon: <Heart size={14} aria-hidden="true" />,
                          },
                          {
                            value: 'views',
                            label: '观看量',
                            icon: <Play size={14} aria-hidden="true" />,
                          },
                        ]}
                      />
                    </>
                  )}
                  <div className="quick-filter-controls">
                    {scope === 'pixiv' && (
                      <Segmented
                        label="Pixiv 热度指标"
                        value={pixivMetric}
                        onChange={setPixivMetric}
                        options={PIXIV_METRICS}
                        className="pixiv-metrics"
                      />
                    )}
                    <CollaborationToggle
                      checked={includeCollaborations}
                      onChange={setIncludeCollaborations}
                    />
                    <div className="filter-anchor">
                      <button
                        ref={filterRef}
                        data-filter-trigger
                        className={`outline-button filter-trigger ${activeFilters || filterOpen ? 'has-filter' : ''}`}
                        aria-expanded={filterOpen}
                        aria-controls="operator-filters"
                        onClick={() => setFilterOpen(!filterOpen)}
                      >
                        <SlidersHorizontal size={15} aria-hidden="true" />
                        <span>筛选</span>
                        {activeFilters ? (
                          <span className="filter-count">{activeFilters}</span>
                        ) : (
                          <ChevronDown size={13} aria-hidden="true" />
                        )}
                      </button>
                      {filterOpen && (
                        <FilterPanel
                          filters={pixivFilters}
                          includeCollaborations={includeCollaborations}
                          showPixivFilters={scope === 'pixiv'}
                          pixivAnnualCounts={annualCounts}
                          years={years}
                          operators={annualCounts ? visibleOperators : operators}
                          onClose={closeFilters}
                          onApply={(nextFilters, nextYears) => {
                            setFilters(nextFilters);
                            setYears(nextYears);
                            closeFilters();
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </header>

              <main id="main-content" className="main-content">
                <section className="chart-section" aria-label="干员热度图表">
                  <div className="chart-toolbar">
                    <div className="chart-title">
                      <span className="chart-title-icon">
                        {view === 'bars' ? (
                          <BarChart3 size={17} strokeWidth={1.5} aria-hidden="true" />
                        ) : (
                          <Grid2X2 size={17} strokeWidth={1.5} aria-hidden="true" />
                        )}
                      </span>
                      <h1>
                        {scope === 'pixiv' && metric === 'workCount'
                          ? view === 'bars'
                            ? '作品数量排行'
                            : '年度作品分布'
                          : view === 'bars'
                            ? '已采集样本排行'
                            : '已采集年度样本'}
                      </h1>
                      <span className="chart-count">{ranked.length}</span>
                    </div>
                    <div className="chart-actions">
                      <label className="search-box">
                        <Search size={15} aria-hidden="true" />
                        <input
                          ref={searchRef}
                          aria-label="搜索干员"
                          placeholder="搜索干员名称、职业…"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                        {query ? (
                          <button aria-label="清除搜索" onClick={() => setQuery('')}>
                            <X size={13} aria-hidden="true" />
                          </button>
                        ) : (
                          <kbd>/</kbd>
                        )}
                      </label>
                      <button
                        className="icon-button export-button"
                        aria-label="Pixiv 统计规则"
                        title="Pixiv 统计规则"
                        onClick={() => setDataOpen(true)}
                        disabled={!operators.length}
                      >
                        <Info size={16} strokeWidth={1.5} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="chart-options">
                    <RankingNotice />
                    {view === 'bars' && (
                      <>
                        <div className="year-legend" aria-label="年份图例，点击切换该年份">
                          {YEARS.map((year) => (
                            <button
                              key={year}
                              aria-pressed={years.includes(year)}
                              title={`${years.includes(year) ? '隐藏' : '显示'} ${year} 年`}
                              className={years.includes(year) ? '' : 'inactive'}
                              onClick={() =>
                                setYears((previous) =>
                                  previous.includes(year)
                                    ? previous.filter((y) => y !== year)
                                    : [...previous, year].sort(),
                                )
                              }
                            >
                              <i style={{ background: YEAR_COLORS[year] }} />
                              {year}
                            </button>
                          ))}
                        </div>
                        <button
                          className="sort-button"
                          onClick={() => setSort(sort === 'desc' ? 'asc' : 'desc')}
                        >
                          {sort === 'desc' ? (
                            <ArrowDown size={12} aria-hidden="true" />
                          ) : (
                            <ArrowUp size={12} aria-hidden="true" />
                          )}
                          {`${metric === 'workCount' ? '数量' : '热度'}${sort === 'desc' ? '降序' : '升序'}`}
                        </button>
                      </>
                    )}
                  </div>
                  {(activeFilters > 0 || favoritesOnly) && (
                    <div className="active-filter-chips">
                      {favoritesOnly && (
                        <button onClick={() => setFavoritesOnly(false)}>
                          我的关注
                          <X size={11} aria-hidden="true" />
                        </button>
                      )}
                      {filters.professions.map((p) => (
                        <button
                          key={p}
                          onClick={() =>
                            setFilters({
                              ...filters,
                              professions: filters.professions.filter((v) => v !== p),
                            })
                          }
                        >
                          {p}
                          <X size={11} aria-hidden="true" />
                        </button>
                      ))}
                      {filters.factions.map((f) => (
                        <button
                          key={f}
                          onClick={() =>
                            setFilters({
                              ...filters,
                              factions: filters.factions.filter((v) => v !== f),
                            })
                          }
                        >
                          {f}
                          <X size={11} aria-hidden="true" />
                        </button>
                      ))}
                      {filters.gender !== '全部' && (
                        <button onClick={() => setFilters({ ...filters, gender: '全部' })}>
                          {filters.gender === '其他' ? '其他／未知' : filters.gender}
                          <X size={11} aria-hidden="true" />
                        </button>
                      )}
                      {scope === 'pixiv' &&
                        (['workTypes', 'ratings'] as const).flatMap((key) =>
                          (pixivFilters[key] ?? []).map((value) => (
                            <button
                              key={`${key}-${value}`}
                              onClick={() =>
                                setFilters({
                                  ...filters,
                                  [key]: filters[key]?.filter((item) => item !== value),
                                })
                              }
                            >
                              {value}
                              <X size={11} aria-hidden="true" />
                            </button>
                          )),
                        )}
                      <button className="clear-filters" onClick={resetAll}>
                        清除筛选
                      </button>
                    </div>
                  )}
                  {currentHiddenIds.length > 0 && (
                    <HiddenOperatorsBar
                      hiddenIds={currentHiddenIds}
                      operators={operators}
                      onRestore={(id) => handleRestoreHidden(scope, id)}
                      onRestoreAll={() => handleClearHidden(scope)}
                    />
                  )}

                  {!operators.length ? (
                    <div className="empty-state">
                      {loadError ? (
                        <>
                          <Info size={30} aria-hidden="true" />
                          <h3>档案暂时未能加载</h3>
                          <p>请检查网络连接，再试一次。</p>
                          <button
                            className="outline-button"
                            onClick={() => setLoadAttempt(loadAttempt + 1)}
                          >
                            重新加载
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="loading-bars">
                            <i />
                            <i />
                            <i />
                          </div>
                          <h3>正在整理干员档案</h3>
                          <p>热爱的回响，即将呈现。</p>
                        </>
                      )}
                    </div>
                  ) : !ranked.length ? (
                    <div className="empty-state">
                      <Search size={30} strokeWidth={1.2} aria-hidden="true" />
                      <h3>
                        {favoritesOnly && !favorites.size
                          ? '还没有关注的干员'
                          : '暂时没有找到匹配的干员'}
                      </h3>
                      <p>
                        {favoritesOnly && !favorites.size
                          ? '打开干员详情，点击“关注干员”即可加入这里。'
                          : '试试其他名称，或减少一些筛选条件。'}
                      </p>
                      <button
                        className="outline-button"
                        onClick={() => {
                          resetAll();
                          if (
                            !activeFilters &&
                            !query &&
                            !favoritesOnly &&
                            currentHiddenIds.length > 0
                          ) {
                            handleClearHidden(scope);
                          }
                        }}
                      >
                        查看全部干员
                        <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : !activeYears.length ? (
                    <div className="empty-state">
                      <CalendarDays size={30} strokeWidth={1.2} aria-hidden="true" />
                      <h3>先选一个年份吧</h3>
                      <p>点击上方年份图例，开始查看热度。</p>
                      <button className="outline-button" onClick={() => setYears(YEARS)}>
                        显示全部年份
                      </button>
                    </div>
                  ) : !hasData ? (
                    <div className="empty-state">
                      <Database size={30} strokeWidth={1.2} aria-hidden="true" />
                      <h3>
                        {scope === 'pixiv' && pixiv.loading
                          ? '正在读取 Pixiv 统计'
                          : `当前范围还没有${metricLabel}数据`}
                      </h3>
                      <p>
                        {scope === 'pixiv' && pixiv.error
                          ? pixiv.error
                          : '未提供的指标保留为空，不会当作 0 参与排名。'}
                      </p>
                      <button className="outline-button" onClick={() => setDataOpen(true)}>
                        查看数据与来源
                        <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <>
                      {view === 'bars' ? (
                        <div className="bar-chart">
                          <div className="bar-table-heading">
                            <span>排名</span>
                            <span>干员 / 阵营</span>
                            <span className="axis-labels">
                              {[0, 0.25, 0.5, 0.75, 1].map((value) => (
                                <span key={value}>{compactNumber(maxValue * value)}</span>
                              ))}
                            </span>
                            <span className="align-right">累计{metricLabel}</span>
                          </div>
                          <div className="chart-rows">
                            {pageRows.map((row, i) => (
                              <div
                                key={row.operator.id}
                                className="bar-row"
                                style={{ '--row-index': i } as CSSProperties}
                              >
                                <span
                                  className={`rank-number ${row.available && i < 3 ? 'top-rank' : ''}`}
                                >
                                  {row.available ? String(i + 1).padStart(2, '0') : '—'}
                                </span>
                                {operatorButton(row)}
                                <div className="bar-plot">
                                  {row.available ? (
                                    <div
                                      className="stacked-bar"
                                      style={{
                                        width: `${(row.total / maxValue) * 100}%`,
                                        minWidth: row.total > 0 ? 2 : 0,
                                      }}
                                    >
                                      {years
                                        .filter((year) => (row.yearly[year] ?? 0) > 0)
                                        .map((year) => (
                                          <button
                                            key={year}
                                            className="bar-segment"
                                            style={{
                                              backgroundColor: YEAR_COLORS[year],
                                              flexGrow: row.yearly[year] ?? 0,
                                            }}
                                            aria-label={`${row.operator.name}，${year} 年，${(row.yearly[year] ?? 0).toLocaleString('zh-CN')} ${metricUnit}${metricLabel}`}
                                            onMouseEnter={(event) => showTooltip(event, row, year)}
                                            onMouseMove={(event) => showTooltip(event, row, year)}
                                            onMouseLeave={() => setTooltip(null)}
                                            onFocus={(event) => {
                                              const rect =
                                                event.currentTarget.getBoundingClientRect();
                                              setTooltip({
                                                x: Math.max(
                                                  105,
                                                  Math.min(
                                                    window.innerWidth - 110,
                                                    rect.x + rect.width / 2,
                                                  ),
                                                ),
                                                y: rect.y - 8,
                                                title: `${row.operator.name} · ${year}`,
                                                value: `${compactNumber(row.yearly[year] ?? 0)} ${metricUnit}${metricLabel}`,
                                                color: YEAR_COLORS[year],
                                              });
                                            }}
                                            onBlur={() => setTooltip(null)}
                                            onClick={() => setDetail(row.operator)}
                                          />
                                        ))}
                                    </div>
                                  ) : (
                                    <span className="missing-value">未提供</span>
                                  )}
                                </div>
                                <button
                                  className="row-total"
                                  aria-label={`${row.operator.name}累计${metricLabel} ${row.available ? row.total.toLocaleString('zh-CN') : '未提供'}，查看详情`}
                                  onClick={() => setDetail(row.operator)}
                                >
                                  {row.available ? compactNumber(row.total) : '—'}
                                  <ArrowUpRight size={12} aria-hidden="true" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <TreemapHeatmap
                          rows={availableRows}
                          years={YEARS}
                          metricLabel={metricLabel}
                          onSelect={setDetail}
                        />
                      )}
                      {view === 'bars' && (
                        <div className="chart-footer">
                          <span className="pagination-info">
                            显示 1–{pageRows.length} 位，共 {ranked.length} 位干员
                          </span>
                          {ranked.length > INITIAL_VISIBLE && (
                            <button
                              className={`expand-toggle ${showAll ? 'expanded' : ''}`}
                              aria-expanded={showAll}
                              onClick={() => setShowAll((value) => !value)}
                            >
                              {showAll ? '收起，只看前 100 位' : `展开全部 ${ranked.length} 位`}
                              <ChevronDown size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </section>
                <footer className="page-footer">
                  <span>为喜欢的干员，记录每一次回响。</span>
                </footer>
              </main>
            </>
          )}
        </div>
      </div>
      {dataOpen &&
        (scope === 'pixiv' ? (
          <Modal title="Pixiv 统计规则" onClose={() => setDataOpen(false)}>
            <div className="count-method">
              {annualCounts ? (
                <>
                  <h3>中文本体标签的年度作品数</h3>
                  <p>
                    按角色的中文本体标签统计，例如
                    #黍。异格标签不单独统计，本体标签下仍可能包含异格作品。
                  </p>
                  <p>
                    按年份展示账号可见的标签搜索结果数，以日本时间归年。绘画包含插画、漫画和动图，小说单独统计；暂不支持分级筛选。
                  </p>
                  <p>浏览、点赞、收藏和评论来自另一批逐件采集的数据，覆盖范围与作品数不同。</p>
                </>
              ) : (
                <>
                  <h3>按角色标签统计作品与互动</h3>
                  <p>作品按 ID 去重，按发布时间统计每年数量。作品类型与分级可以组合筛选。</p>
                  <p>按作品发布年份分组，互动量为采集时累计值。未取得的指标保留为空。</p>
                  <p>收藏和评论若有缺失，仅累计已经取得的数值。</p>
                  <p>
                    作品数只需完成标签列表，不等待互动指标；浏览、点赞等在详情补齐后分别接入。受限、失败或未取完的范围保留为空。
                  </p>
                  <p>全年龄、R-18、R-18G 来自平台原生分级，未返回分级的作品归入“未标注”。</p>
                  <p>
                    缺少发布时间的作品列为年份未知，不编造年份，不计入分年榜单。每组保留一条代表来源，完整作品记录保留在采集数据库。
                  </p>
                </>
              )}
              <p>同名话题仍影响排名，请自行甄别</p>
            </div>
          </Modal>
        ) : isTagSummary ? (
          <BilibiliCountInfo platform={pageScope} onClose={() => setDataOpen(false)} />
        ) : null)}
      {detail && (
        <OperatorDetail
          operator={detail}
          records={
            favoritesOnly
              ? filterPixivRecords(
                  pixivMetric === 'workCount'
                    ? (pixiv.data?.countRecords ?? pixiv.data?.records ?? [])
                    : (pixiv.data?.records ?? []),
                  effectivePixivFilters(
                    filters,
                    pixivMetric === 'workCount' &&
                      pixiv.data?.metadata.countMethod === 'chinese_base_tag_year_total',
                  ),
                )
              : records
          }
          scope={favoritesOnly ? 'pixiv' : scope}
          metric={favoritesOnly ? pixivMetric : metric}
          years={years}
          knownCountOperators={knownCountOperators}
          favorite={favorites.has(detail.id)}
          onFavorite={() => toggleFavorite(detail.id)}
          hidden={!favoritesOnly && isOperatorHidden(currentHiddenSet, detail.id)}
          onToggleHide={!favoritesOnly ? () => handleToggleHide(scope, detail.id) : undefined}
          onClose={() => setDetail(null)}
        />
      )}
      {tooltip && (
        <div className="chart-tooltip" role="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <strong>
            <i style={{ background: tooltip.color }} />
            {tooltip.title}
          </strong>
          <span>{tooltip.value}</span>
        </div>
      )}
      <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">
        {toast && (
          <>
            <Check size={15} aria-hidden="true" />
            {toast}
          </>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {operators.length && !isTagSummary
          ? `当前显示${platformName}，${metricLabel}，${view === 'bars' ? '条形图' : '热力图'}，筛选结果 ${ranked.length} 位干员。`
          : ''}
      </span>
    </div>
  );
}

function OperatorDetail({
  operator,
  records,
  scope,
  metric,
  years,
  knownCountOperators,
  favorite,
  onFavorite,
  hidden = false,
  onToggleHide,
  onClose,
}: {
  operator: Operator;
  records: HeatRecord[];
  scope: PlatformId;
  metric: Metric;
  years: number[];
  knownCountOperators?: Set<string>;
  favorite: boolean;
  onFavorite: () => void;
  hidden?: boolean;
  onToggleHide?: () => void;
  onClose: () => void;
}) {
  const row = rankOperators(
    [operator],
    records,
    scope,
    metric,
    years,
    EMPTY_FILTERS,
    '',
    'desc',
    undefined,
    knownCountOperators,
  )[0];
  const max = Math.max(1, ...Object.values(row.yearly).filter((v): v is number => v !== null));
  return (
    <Modal title="干员观察档案" onClose={onClose} drawer>
      <div className="detail-identity">
        <div className="detail-avatar">
          <img src={operator.avatar} alt={`${operator.name}头像`} width={88} height={88} />
        </div>
        <div>
          <span className="rarity-stars" aria-label={`${operator.rarity} 星`}>
            {Array.from({ length: operator.rarity }, (_, i) => (
              <Star size={11} fill="currentColor" key={i} aria-hidden="true" />
            ))}
          </span>
          <h3>{operator.name}</h3>
          <p>{operator.englishName}</p>
        </div>
      </div>
      <div className="detail-tags">
        <span>
          {operator.profession} · {operator.branch}
        </span>
        {operator.factions.map((f) => (
          <span key={f}>{f}</span>
        ))}
        <span>{operator.originalGender}</span>
      </div>
      <div className="detail-actions">
        <button
          className={`outline-button full-width favorite-button ${favorite ? 'is-favorite' : ''}`}
          aria-pressed={favorite}
          onClick={onFavorite}
        >
          <Heart size={16} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
          {favorite ? '已关注 · 点击取消' : '关注这位干员'}
        </button>
        {onToggleHide && (
          <button
            className={`outline-button full-width hide-operator-button ${hidden ? 'is-hidden-operator' : ''}`}
            aria-pressed={hidden}
            onClick={onToggleHide}
          >
            {hidden ? (
              <Eye size={16} aria-hidden="true" />
            ) : (
              <EyeOff size={16} aria-hidden="true" />
            )}
            {hidden ? '已隐藏 · 点击恢复' : '隐藏这位干员'}
          </button>
        )}
      </div>
      <div className="detail-total">
        <span>
          累计
          {metric === 'views' && scope !== 'pixiv'
            ? '观看量'
            : PIXIV_METRICS.find((option) => option.value === metric)!.label}
          <span className="summary-tag">已采集</span>
        </span>
        <strong>{row.available ? compactNumber(row.total) : '未提供'}</strong>
        <p>{PLATFORMS.find((p) => p.id === scope)?.name} · 按当前选中年份汇总</p>
      </div>
      <h4 className="detail-section-title">每一年的回响</h4>
      <div className="detail-years">
        {years.map((year) => (
          <div key={year}>
            <span>{year}</span>
            <div>
              <i
                style={{
                  width: `${((row.yearly[year] ?? 0) / max) * 100}%`,
                  background: YEAR_COLORS[year],
                }}
              />
            </div>
            <strong>{row.yearly[year] === null ? '—' : compactNumber(row.yearly[year])}</strong>
          </div>
        ))}
      </div>
    </Modal>
  );
}
