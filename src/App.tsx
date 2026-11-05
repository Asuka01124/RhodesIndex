import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Database,
  Grid2X2,
  Heart,
  Info,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import type {
  Filters,
  HeatDataset,
  HeatRecord,
  Metric,
  Operator,
  RankedOperator,
  PlatformId,
  ViewMode,
  DataMode,
  WorkObservation,
} from './types';
import {
  compactNumber,
  csvEscape,
  DEFAULT_FILTERS,
  EMPTY_FILTERS,
  filterCount,
  rankOperators,
  validateDataset,
  YEARS,
} from './domain';
import { createDemoRecords, PLATFORMS, platformSearch, YEAR_COLORS } from './data';
import { BrandIcon, downloadFile, Modal, RankingNotice, Segmented } from './ui';
import { FilterPanel } from './Filters';
import { DataPanel } from './DataPanel';
import { useLiveData } from './useLiveData';
import { preloadTagSnapshots, usePixivSummary } from './useTagCounts';
import { filterPixivRecords, PIXIV_METRICS } from './pixiv';
import { SidebarHighlight } from './SidebarHighlight';
import { BilibiliCountsPage, BilibiliCountInfo } from './BilibiliCountsPage';
import { CollaborationToggle } from './CollaborationToggle';
import { collaborationRoster } from './collaborations';
import { RaritySlider } from './RaritySlider';
import { TreemapHeatmap } from './TreemapHeatmap';

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
    PIXIV_METRICS.find((option) => option.value === initialParams.get('metric'))?.value ?? 'views',
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
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [pageTransitionId, setPageTransitionId] = useState(0);
  const [pageEntering, setPageEntering] = useState(true);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 650px)').matches);
  const [collapsed, setCollapsed] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [imported, setImported] = useState<HeatDataset | null>(null);
  const [sourceMode, setSourceMode] = useState<DataMode>('collected');
  const isTagSummary =
    pageScope === 'bilibili' ||
    pageScope === 'lofter' ||
    pageScope === 'douyin' ||
    pageScope === 'xiaohongshu' ||
    pageScope === 'weibo' ||
    pageScope === 'skland';
  const collection = useLiveData(!isTagSummary && scope !== 'pixiv');
  const pixiv = usePixivSummary(scope === 'pixiv');
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
  const isDemo = sourceMode === 'demo';
  const isCollected = sourceMode === 'collected';
  const modeLabel = isDemo ? '演示' : isCollected ? '真实样本' : '导入';

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    fetch('/data/operators.json', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('档案加载失败');
        return response.json() as Promise<Operator[]>;
      })
      .then((data) => {
        if (!Array.isArray(data) || !data.length) throw new Error('档案格式无效');
        setOperators(data);
        const saved = readLocal<unknown>('imported', null);
        if (saved) {
          try {
            setImported(validateDataset(saved, data));
            if (readLocal<string>('sourceMode', 'demo') === 'imported') setSourceMode('imported');
          } catch {
            setToast('已保存的导入文件格式无效，当前使用真实采集模式。');
          }
        }
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

  const demoRecords = useMemo(
    () => (isDemo ? createDemoRecords(operators) : []),
    [operators, isDemo],
  );
  const importedRecords = useMemo(
    () => imported?.records.filter((row) => row.platform !== 'youtube'),
    [imported],
  );
  const sourceRecords =
    sourceMode === 'imported' && importedRecords
      ? importedRecords
      : isDemo
        ? demoRecords
        : scope === 'pixiv'
          ? (pixiv.data?.records ?? [])
          : collection.live.records;
  const records = useMemo(
    () => (scope === 'pixiv' ? filterPixivRecords(sourceRecords, filters) : sourceRecords),
    [scope, sourceRecords, filters],
  );
  const visibleOperators = useMemo(
    () => collaborationRoster(operators, includeCollaborations),
    [operators, includeCollaborations],
  );
  const activeYears = view === 'heatmap' ? YEARS : years;
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
      favorites,
    ],
  );
  const availableRows = useMemo(() => ranked.filter((r) => r.available), [ranked]);
  const pageRows = showAll ? ranked : ranked.slice(0, INITIAL_VISIBLE);
  const maxValue = Math.max(1, ...availableRows.map((r) => r.total));
  const activeFilters = filterCount(filters, scope === 'pixiv');
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
    sourceMode,
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
  function toggleFavorite(id: string) {
    const next = new Set(favorites);
    if (next.has(id)) {
      next.delete(id);
      setToast('已移出我的关注');
    } else {
      next.add(id);
      setToast('已加入我的关注');
    }
    setFavorites(next);
    writeLocal('favorites', [...next]);
  }
  function setDataMode(mode: DataMode) {
    setSourceMode(mode);
    writeLocal('sourceMode', mode);
  }
  function importDataset(data: HeatDataset) {
    try {
      localStorage.setItem('rhodes.imported', JSON.stringify(data));
      localStorage.setItem('rhodes.sourceMode', JSON.stringify('imported'));
    } catch {
      throw new Error('当前浏览器存储不足或不可用，数据未导入；请缩小文件或允许本机存储。');
    }
    setImported(data);
    setSourceMode('imported');
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
          : `${value.toLocaleString('zh-CN')} 次${metricLabel === '点赞' ? '点赞' : '观看'}`,
      color: YEAR_COLORS[year],
    });
  }
  function resetAll() {
    setFilters((previous) => ({ ...EMPTY_FILTERS, rarityTiers: previous.rarityTiers }));
    setYears(YEARS);
    setQuery('');
    setFavoritesOnly(false);
  }
  function exportCsv() {
    const matrix: (string | number | null)[][] = [
      [
        '干员',
        '职业',
        '阵营',
        '性别',
        '星级',
        ...years.map((year) => `${year}年${metricLabel}`),
        `${metricLabel}合计`,
        '平台',
        '数据模式',
      ],
      ...ranked.map((row) => [
        row.operator.name,
        row.operator.profession,
        row.operator.factions.join('、'),
        row.operator.originalGender,
        row.operator.rarity,
        ...years.map((year) => row.yearly[year]),
        row.available ? row.total : null,
        platformName,
        isDemo
          ? '演示数据，非真实统计'
          : isCollected
            ? '公开作品真实样本，部分覆盖'
            : '用户导入数据',
      ]),
    ];
    downloadFile(
      `罗德指数-${platformName}-${metricLabel}-${modeLabel}.csv`,
      '\ufeff' + matrix.map((row) => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8',
    );
    setToast(`已导出 ${ranked.length} 位干员的当前筛选数据`);
  }

  const operatorButton = (row: RankedOperator) => (
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
          <img src="/favicon.svg" width={42} height={42} alt="" />
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
          <button
            title="数据与来源"
            className="nav-item"
            onClick={() => {
              setDataOpen(true);
              setMobileMenu(false);
            }}
          >
            <Database size={17} strokeWidth={1.5} aria-hidden="true" />
            <span>数据与来源</span>
            <ArrowUpRight size={13} aria-hidden="true" />
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
          {isTagSummary ? (
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
                          filters={filters}
                          includeCollaborations={includeCollaborations}
                          showPixivFilters={scope === 'pixiv'}
                          years={years}
                          operators={operators}
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
                        {view === 'bars'
                          ? isCollected
                            ? '已核验样本排行'
                            : '干员热度排行'
                          : isCollected
                            ? '已采集年度样本'
                            : '年度热度图谱'}
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
                        aria-label={scope === 'pixiv' ? 'Pixiv 统计规则' : '导出当前筛选 CSV'}
                        title={scope === 'pixiv' ? 'Pixiv 统计规则' : '导出当前筛选 CSV'}
                        onClick={scope === 'pixiv' ? () => setDataOpen(true) : exportCsv}
                        disabled={!operators.length}
                      >
                        {scope === 'pixiv' ? (
                          <Info size={16} strokeWidth={1.5} aria-hidden="true" />
                        ) : (
                          <ArrowDownToLine size={16} strokeWidth={1.5} aria-hidden="true" />
                        )}
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
                          {sort === 'desc' ? '热度降序' : '热度升序'}
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
                          (filters[key] ?? []).map((value) => (
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
                      <button className="outline-button" onClick={resetAll}>
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
                        {isCollected && scope === 'pixiv' && pixiv.loading
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
                                            aria-label={`${row.operator.name}，${year} 年，${(row.yearly[year] ?? 0).toLocaleString('zh-CN')} 次${metricLabel}`}
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
                                                value: `${compactNumber(row.yearly[year] ?? 0)} 次${metricLabel}`,
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
                <div className="chart-caption">
                  <span>
                    <Info size={13} strokeWidth={1.5} aria-hidden="true" />
                    {isDemo
                      ? '当前为演示数据，不代表实际平台热度。'
                      : isCollected
                        ? scope === 'pixiv'
                          ? `已接入 ${pixiv.data?.metadata.operatorIds.length ?? 0} 位已完成干员，互动量为采集时累计值。`
                          : `真实样本共 ${collection.live.metadata.workCount} 件作品，非全站总量；缺失指标不计为零。`
                        : '当前为用户导入数据，未混入演示数值。'}
                    按作品发布年份分组。
                  </span>
                  {view === 'heatmap' && (
                    <span className="heat-scale">
                      较少
                      <span>
                        {[15, 35, 55, 75, 94].map((p) => (
                          <i
                            key={p}
                            style={{ background: `color-mix(in srgb, #0071e3 ${p}%, #eef4fc)` }}
                          />
                        ))}
                      </span>
                      较多
                    </span>
                  )}
                </div>
                <footer className="page-footer">
                  <span>为喜欢的干员，记录每一次回响。</span>
                  <button onClick={() => setDataOpen(true)}>
                    <CircleHelp size={13} aria-hidden="true" />
                    统计口径与数据来源
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
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
              <h3>已完成干员的作品统计</h3>
              <p>按作品 ID 去重，展示浏览、点赞、收藏和评论。作品类型与分级可以组合筛选。</p>
              <p>按作品发布年份分组，互动量为采集时累计值。未取得的指标保留为空。</p>
              <p>收藏和评论若有缺失，仅累计已经取得的数值。</p>
              <p>只接入标签分页和点赞、浏览量补齐的干员。受限、失败或尚未完成的干员保留为空。</p>
              <p>全年龄、R-18、R-18G 来自平台原生分级，未返回分级的作品归入“未标注”。</p>
              <p>每个统计分组保留一条代表来源，完整作品记录保留在采集数据库。</p>
              <p>同名话题仍影响排名，请自行甄别</p>
            </div>
          </Modal>
        ) : isTagSummary ? (
          <BilibiliCountInfo platform={pageScope} onClose={() => setDataOpen(false)} />
        ) : (
          <DataPanel
            operators={operators}
            imported={imported}
            activeMode={sourceMode}
            onUseDemo={() => setDataMode('demo')}
            onUseImported={() => setDataMode('imported')}
            onImport={importDataset}
            onClose={() => setDataOpen(false)}
            collection={collection}
            filteredIds={ranked.map((row) => row.operator.id)}
            onUseCollected={() => setDataMode('collected')}
          />
        ))}
      {detail && (
        <OperatorDetail
          operator={detail}
          records={records}
          scope={scope}
          metric={metric}
          years={years}
          isDemo={isDemo}
          isCollected={isCollected}
          sourceWorks={isCollected ? collection.live.works : []}
          favorite={favorites.has(detail.id)}
          onFavorite={() => toggleFavorite(detail.id)}
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
  isDemo,
  isCollected,
  sourceWorks,
  favorite,
  onFavorite,
  onClose,
}: {
  operator: Operator;
  records: HeatRecord[];
  scope: PlatformId;
  metric: Metric;
  years: number[];
  isDemo: boolean;
  isCollected: boolean;
  sourceWorks: WorkObservation[];
  favorite: boolean;
  onFavorite: () => void;
  onClose: () => void;
}) {
  const row = rankOperators([operator], records, scope, metric, years, EMPTY_FILTERS, '')[0];
  const max = Math.max(1, ...Object.values(row.yearly).filter((v): v is number => v !== null));
  const selectedRecords = records.filter(
    (r) => r.operatorId === operator.id && r.platform === scope && years.includes(r.year),
  );
  const urls = [...new Set(selectedRecords.flatMap((r) => r.sourceUrls))];
  const platforms = PLATFORMS.filter((p) => p.id === scope);
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
      <button
        className={`outline-button full-width favorite-button ${favorite ? 'is-favorite' : ''}`}
        aria-pressed={favorite}
        onClick={onFavorite}
      >
        <Heart size={16} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
        {favorite ? '已关注 · 点击取消' : '关注这位干员'}
      </button>
      <div className="detail-total">
        <span>
          累计
          {metric === 'views' && scope !== 'pixiv'
            ? '观看量'
            : PIXIV_METRICS.find((option) => option.value === metric)!.label}
          <span className="summary-tag">{isDemo ? '演示' : isCollected ? '真实样本' : '导入'}</span>
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
      <h4 className="detail-section-title">{isDemo ? '去平台发现更多创作' : '记录来源'}</h4>
      {isCollected && (
        <div className="work-evidence">
          {sourceWorks
            .filter(
              (work) =>
                work.operatorIds.includes(operator.id) &&
                work.platform === scope &&
                years.includes(
                  Number(
                    new Intl.DateTimeFormat('en-US', {
                      timeZone: 'Asia/Shanghai',
                      year: 'numeric',
                    }).format(new Date(work.publishedAt)),
                  ),
                ),
            )
            .slice(0, 12)
            .map((work) => (
              <a
                key={`${work.platform}:${work.id}`}
                href={work.url}
                target="_blank"
                rel="noreferrer"
              >
                <strong>
                  {work.title}
                  <ArrowUpRight size={12} aria-hidden="true" />
                </strong>
                <span>
                  {PLATFORMS.find((p) => p.id === work.platform)?.name} ·{' '}
                  {new Date(work.publishedAt).toLocaleDateString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                </span>
                <small>
                  点赞 {work.likes === null ? '未提供' : work.likes.toLocaleString('zh-CN')} · 观看{' '}
                  {work.views === null ? '未提供' : work.views.toLocaleString('zh-CN')}
                </small>
                <small>
                  统计于{' '}
                  {new Date(work.observedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </small>
              </a>
            ))}
        </div>
      )}
      {isDemo ? (
        <p className="muted detail-explanation">以下为外部搜索入口，不作为演示数值的来源。</p>
      ) : (
        <div className="record-sources">
          {urls.length ? (
            urls.slice(0, 8).map((url, i) => (
              <a href={url} target="_blank" rel="noreferrer" key={url}>
                来源 {i + 1}
                <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            ))
          ) : (
            <p className="muted">当前范围未提供来源记录。</p>
          )}
        </div>
      )}
      <div className="detail-platforms">
        {platforms.map((p) => (
          <a href={platformSearch(p.id, operator)} target="_blank" rel="noreferrer" key={p.id}>
            <BrandIcon name={p.icon} size={15} />
            {p.name}
            <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        ))}
      </div>
      <a
        className="outline-button full-width prts-link"
        href={operator.sourceUrl}
        target="_blank"
        rel="noreferrer"
      >
        查看 PRTS 完整档案
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
      <div className="detail-footnote">
        <Sparkles size={14} aria-hidden="true" />
        <span>
          {isDemo
            ? '每一份热爱都值得记录，演示数值不代表真实热度。'
            : isCollected
              ? '仅覆盖已经采集并核验的作品；Pixiv 收藏数不当作点赞。真实指标可能随平台更新而变化。'
              : '数据由导入文件提供，请结合来源及统计时间阅读。'}
        </span>
      </div>
    </Modal>
  );
}
