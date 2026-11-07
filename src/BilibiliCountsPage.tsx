import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  Eye,
  EyeOff,
  Grid2X2,
  Heart,
  Info,
  Menu,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { Filters, NativeTagCount, Operator, TagSummaryRow, ViewMode } from './types';
import { compactNumber, EMPTY_FILTERS, filterCount, YEARS } from './domain';
import { BrandIcon, Modal, RankingNotice, Segmented } from './ui';
import { FilterPanel } from './Filters';
import { rankTagCounts } from './tagCounts';
import { TreemapHeatmap } from './TreemapHeatmap';
import { buildTagCountEntries } from './treemap';
import {
  useTagCounts,
  useLofterTagCounts,
  useDouyinTopicCounts,
  useXiaohongshuTopicCounts,
  useWeiboTagCounts,
  useSklandTagCounts,
} from './useTagCounts';
import { lofterDisplayRows } from './lofterCounts';
import { douyinDisplayRows, douyinRoster } from './douyinCounts';
import { CollaborationToggle } from './CollaborationToggle';
import { collaborationRoster } from './collaborations';
import { DouyinAmbiguityToggle } from './DouyinAmbiguityToggle';
import { hideAmbiguousDouyinTopics } from './douyinAmbiguity';
import { RaritySlider } from './RaritySlider';
import { XIAOHONGSHU_METHOD, xiaohongshuDisplayRows } from './xiaohongshuCounts';
import {
  WEIBO_METRICS,
  WEIBO_METRIC_LABELS,
  WEIBO_METHOD,
  weiboDisplayRows,
  type WeiboMetric,
} from './weiboCounts';
import {
  SKLAND_METRICS,
  SKLAND_METRIC_LABELS,
  SKLAND_SEARCH_EXAMPLE,
  sklandDisplayRows,
  sklandRoster,
  type SklandMetric,
} from './sklandCounts';
import { HiddenOperatorsBar } from './HiddenOperatorsBar';
import { isOperatorHidden } from './hiddenOperators';

const dateLabel = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未取得';

const nativeLabel = (value: NativeTagCount | null | undefined) =>
  value
    ? value.exact
      ? value.display
      : value.estimate !== null
        ? `约 ${value.display}`
        : value.display
    : '未取得';

const INITIAL_VISIBLE = 100;
const PLATFORM_NAMES = {
  bilibili: '哔哩哔哩',
  lofter: 'LOFTER',
  douyin: '抖音',
  xiaohongshu: '小红书',
  weibo: '微博',
  skland: '森空岛',
};
type CountPlatform = keyof typeof PLATFORM_NAMES;

export function BilibiliCountInfo({
  onClose,
  platform = 'bilibili',
}: {
  onClose: () => void;
  platform?: CountPlatform;
}) {
  if (platform === 'skland') {
    return (
      <Modal title="森空岛热度规则" onClose={onClose}>
        <div className="count-method">
          <h3>干员话题累计统计</h3>
          <p>
            按核验过的话题 ID 读取森空岛的原生浏览、发帖和讨论数。点击排行数值可查看话题
            ID、来源和采集时间。
          </p>
          <p>
            共用话题只排一次。未匹配或未取得的指标留空。话题统计可能包含攻略、讨论与二创，也可能与其他话题重叠。
          </p>
          <a
            className="outline-button"
            href={SKLAND_SEARCH_EXAMPLE}
            target="_blank"
            rel="noreferrer"
          >
            在森空岛搜索「望」
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
      </Modal>
    );
  }
  if (platform === 'xiaohongshu') {
    return (
      <Modal title="小红书热度规则" onClose={onClose}>
        <div className="count-method">
          <h3>角色话题累计浏览量</h3>
          <p>{XIAOHONGSHU_METHOD}</p>
          <p>
            每位角色只统计一个话题。大多数角色直接用本名，比如 #黍、#阿米娅。
            容易撞名的角色会加「明日方舟」，比如 #明日方舟爱丽丝。
          </p>
          <p>阿米娅的三个职业形态共用 #阿米娅。找不到对应话题或浏览量时留空。</p>
          <p>点击排行数值可查看实际话题、来源和采集时间。</p>
        </div>
      </Modal>
    );
  }
  if (platform === 'weibo') {
    return (
      <Modal title="微博热度规则" onClose={onClose}>
        <div className="count-method">
          <h3>角色话题热度</h3>
          <p>{WEIBO_METHOD}</p>
          <p>
            阿米娅各职业形态共用 #阿米娅#，爱丽丝使用
            #明日方舟爱丽丝#。原创人数、讨论次数和阅读次数均读取话题页的数据总览。
          </p>
          <p>
            显示为万或亿的数值保留原文并按约数排序；话题页没有数据总览时保留为空，不补
            0。不同话题可能包含同一作者或内容，不合并、不相加。
          </p>
          <p>点击排行数值可查看实际话题、来源和采集时间。</p>
        </div>
      </Modal>
    );
  }
  const isLofter = platform === 'lofter';
  const isDouyin = platform === 'douyin';
  return (
    <Modal
      title={`${isLofter ? 'LOFTER 热度规则' : isDouyin ? '抖音热度规则' : '哔哩哔哩数据与来源'}`}
      onClose={onClose}
    >
      <div className="count-method">
        <h3>
          {isLofter ? '中文标签的浏览与参与' : isDouyin ? '话题累计播放量' : '单角色 TAG 使用数'}
        </h3>
        <p>
          {isLofter
            ? '展示已采集的标签浏览与参与原文；万、亿等缩写标为约数。参与数不冒充已去重作品总数。'
            : isDouyin
              ? '读取平台同名话题的原生累计播放量 view_count；它不是作品数或独立热度指数。阿米娅三个职业形态共用同一份统计，不重复相加。'
              : '直接读取角色中文主名 TAG 的使用数，不加明日方舟，联动角色也不加作品名。本体和异格合并显示，例如德克萨斯与缄默德克萨斯只排一行。'}
        </p>
        <p>
          不同标签可能包含同一件作品，不将各干员数量相加为平台总量。未取得的数据保留为空；采集中、受限或截断如实标注。
        </p>
        <p>
          {isLofter
            ? '打开干员详情可查看标签、来源和采集时间。'
            : isDouyin
              ? '话题名称与干员主名相同，不代表内容全部属于该角色；常见名称可能混入其他内容。详情和CSV保留完整数值、话题ID、来源和采集时间。'
              : '合计为各形态 TAG 的使用次数，同一视频打了多个形态标签会重复计入，不是去重作品总数。点击数值可查看每个 TAG 的小计、来源和采集时间；未取得的形态不补零，已取得的小计标为下限。'}
        </p>
        {isDouyin && (
          <p>
            默认隐藏播放量 10
            亿及以上的同名话题结果，可在顶部“隐藏同名”开关中恢复查看；此外还有部分极端同名话题未予收录。
          </p>
        )}
      </div>
    </Modal>
  );
}

export function BilibiliCountsPage({
  platform = 'bilibili',
  operators,
  view,
  onViewChange,
  includeCollaborations,
  onIncludeCollaborationsChange,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  filterOpen,
  onFilterOpen,
  onCloseFilters,
  favorites,
  favoritesOnly,
  onClearFavorites,
  onFavorite,
  hiddenIds = [],
  onToggleHide,
  onRestoreHidden,
  onClearHidden,
  searchRef,
  filterRef,
  mobileToggleRef,
  mobileMenu,
  onToggleMenu,
  onInfo,
}: {
  platform?: CountPlatform;
  operators: Operator[];
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  includeCollaborations: boolean;
  onIncludeCollaborationsChange: (value: boolean) => void;
  query: string;
  onQueryChange: (value: string) => void;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  filterOpen: boolean;
  onFilterOpen: () => void;
  onCloseFilters: () => void;
  favorites: Set<string>;
  favoritesOnly: boolean;
  onClearFavorites: () => void;
  onFavorite: (id: string, sharedIds?: string[]) => void;
  hiddenIds?: readonly string[];
  onToggleHide?: (id: string, sharedIds?: string[]) => void;
  onRestoreHidden?: (id: string) => void;
  onClearHidden?: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  filterRef: RefObject<HTMLButtonElement | null>;
  mobileToggleRef: RefObject<HTMLButtonElement | null>;
  mobileMenu: boolean;
  onToggleMenu: () => void;
  onInfo: () => void;
}) {
  const isLofter = platform === 'lofter';
  const isDouyin = platform === 'douyin';
  const isXiaohongshu = platform === 'xiaohongshu';
  const isWeibo = platform === 'weibo';
  const isSkland = platform === 'skland';
  const isTopic = isDouyin || isXiaohongshu || isWeibo || isSkland;
  const platformName = PLATFORM_NAMES[platform];
  const [lofterMetric, setLofterMetric] = useState<'participation' | 'views'>('participation');
  const [weiboMetric, setWeiboMetric] = useState<WeiboMetric>('originalAuthors');
  const [sklandMetric, setSklandMetric] = useState<SklandMetric>('viewNum');
  const [hideAmbiguous, setHideAmbiguous] = useState(true);
  const bili = useTagCounts(platform === 'bilibili');
  const lofter = useLofterTagCounts(isLofter);
  const douyin = useDouyinTopicCounts(isDouyin);
  const xiaohongshu = useXiaohongshuTopicCounts(isXiaohongshu);
  const weibo = useWeiboTagCounts(isWeibo);
  const skland = useSklandTagCounts(isSkland);
  const existing = isLofter
    ? lofter
    : isDouyin
      ? douyin
      : isXiaohongshu
        ? xiaohongshu
        : isWeibo
          ? weibo
          : bili;
  const { data, loading, error } = isSkland ? skland : existing;
  const countLabel = isSkland
    ? SKLAND_METRIC_LABELS[sklandMetric]
    : isLofter
      ? lofterMetric === 'participation'
        ? '参与数'
        : '浏览量'
      : isDouyin
        ? '话题播放量'
        : isXiaohongshu
          ? '话题浏览量'
          : isWeibo
            ? WEIBO_METRIC_LABELS[weiboMetric]
            : '标签使用数';
  const countRecords = useMemo<TagSummaryRow[]>(
    () =>
      isSkland
        ? sklandDisplayRows(skland.data, sklandMetric)
        : isLofter
          ? lofterDisplayRows(lofter.data, lofterMetric)
          : isDouyin
            ? douyinDisplayRows(douyin.data)
            : isXiaohongshu
              ? xiaohongshuDisplayRows(xiaohongshu.data)
              : isWeibo
                ? weiboDisplayRows(weibo.data, weiboMetric)
                : (bili.data?.records ?? []),
    [
      isSkland,
      skland.data,
      sklandMetric,
      isLofter,
      isDouyin,
      isXiaohongshu,
      isWeibo,
      lofter.data,
      lofterMetric,
      douyin.data,
      xiaohongshu.data,
      weibo.data,
      weiboMetric,
      bili.data,
    ],
  );
  const [sort, setSort] = useState<'asc' | 'desc'>('desc');
  const [showAll, setShowAll] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const ranked = useMemo(
    () =>
      rankTagCounts(
        collaborationRoster(
          isSkland
            ? sklandRoster(operators, skland.data)
            : isDouyin
              ? hideAmbiguousDouyinTopics(
                  douyinRoster(operators),
                  hideAmbiguous,
                  douyin.data?.records,
                )
              : isXiaohongshu || isWeibo
                ? douyinRoster(operators)
                : operators,
          includeCollaborations,
        ),
        countRecords,
        filters,
        deferredQuery,
        sort,
        favoritesOnly ? favorites : undefined,
        hiddenSet,
      ),
    [
      operators,
      isSkland,
      skland.data,
      isDouyin,
      isXiaohongshu,
      isWeibo,
      hideAmbiguous,
      douyin.data,
      countRecords,
      filters,
      includeCollaborations,
      deferredQuery,
      sort,
      favoritesOnly,
      favorites,
      hiddenSet,
    ],
  );
  const rows = showAll ? ranked : ranked.slice(0, INITIAL_VISIBLE);
  const max = Math.max(1, ...ranked.map((r) => r.record?.workCount ?? 0));
  const treemapEntries = useMemo(() => buildTagCountEntries(ranked), [ranked]);
  const detail = operators.find((o) => o.id === detailId);
  const detailRecord = countRecords.find((r) => r.operatorId === detailId);
  const activeFilters = filterCount(filters);
  useEffect(() => {
    setShowAll(false);
  }, [
    deferredQuery,
    filters,
    includeCollaborations,
    favoritesOnly,
    sort,
    lofterMetric,
    weiboMetric,
    sklandMetric,
    platform,
    hideAmbiguous,
    hiddenSet,
  ]);
  const reset = () => {
    onFiltersChange({ ...EMPTY_FILTERS, rarityTiers: filters.rarityTiers });
    onQueryChange('');
    onClearFavorites();
  };
  return (
    <>
      <header
        className={`topbar bili-count-topbar${isLofter ? ' lofter-tag-topbar' : ''}${isDouyin ? ' douyin-topic-topbar' : ''}${isWeibo || isSkland ? ' weibo-topic-topbar' : ''}`}
      >
        <div className="breadcrumb">
          <button
            ref={mobileToggleRef}
            className="icon-button mobile-menu-button"
            aria-label="打开平台菜单"
            aria-expanded={mobileMenu}
            onClick={onToggleMenu}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <RaritySlider
            value={filters.rarityTiers}
            onChange={(rarityTiers) => onFiltersChange({ ...filters, rarityTiers })}
          />
        </div>
        <div className="header-controls">
          <Segmented
            label="图表类型"
            value={view}
            onChange={onViewChange}
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
          <div className="quick-filter-controls">
            {isLofter && (
              <Segmented
                label="LOFTER统计指标"
                value={lofterMetric}
                onChange={setLofterMetric}
                options={[
                  { value: 'participation', label: '参与' },
                  { value: 'views', label: '浏览' },
                ]}
              />
            )}
            {isDouyin && (
              <DouyinAmbiguityToggle checked={hideAmbiguous} onChange={setHideAmbiguous} />
            )}
            {isWeibo && (
              <Segmented
                label="微博统计指标"
                value={weiboMetric}
                onChange={setWeiboMetric}
                options={WEIBO_METRICS.map((metric) => ({ ...metric }))}
              />
            )}
            {isSkland && (
              <Segmented
                label="森空岛统计指标"
                value={sklandMetric}
                onChange={setSklandMetric}
                options={SKLAND_METRICS.map((metric) => ({ ...metric }))}
              />
            )}
            <CollaborationToggle
              checked={includeCollaborations}
              onChange={onIncludeCollaborationsChange}
            />
            <div className="filter-anchor">
              <button
                ref={filterRef}
                className={`outline-button filter-trigger ${activeFilters || filterOpen ? 'has-filter' : ''}`}
                data-filter-trigger
                aria-expanded={filterOpen}
                aria-controls="operator-filters"
                onClick={onFilterOpen}
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
                  years={YEARS}
                  operators={operators}
                  showYears={false}
                  onClose={onCloseFilters}
                  onApply={(next) => {
                    onFiltersChange(next);
                    onCloseFilters();
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </header>
      <main id="main-content" className="main-content bili-count-page">
        <section
          className="chart-section"
          aria-label={`${platformName}${isTopic ? '话题' : '标签'}统计排行`}
        >
          <div className="chart-toolbar">
            <div className="chart-title">
              <span className="chart-title-icon">
                <BrandIcon name={platform} size={18} />
              </span>
              <h1>
                {isSkland
                  ? `森空岛${countLabel}排行`
                  : isLofter
                    ? `标签${countLabel}排行`
                    : isTopic
                      ? `${countLabel}排行`
                      : '标签使用数排行'}
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
                  onChange={(e) => onQueryChange(e.target.value)}
                />
                {query ? (
                  <button aria-label="清除搜索" onClick={() => onQueryChange('')}>
                    <X size={13} aria-hidden="true" />
                  </button>
                ) : (
                  <kbd>/</kbd>
                )}
              </label>
              <button
                className="icon-button export-button"
                aria-label={platformName + '热度规则'}
                title={platformName + '热度规则'}
                aria-haspopup="dialog"
                onClick={onInfo}
              >
                <Info size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="chart-options count-options">
            <p className="count-coverage">
              {isSkland ? (
                skland.data ? (
                  `已取得 ${skland.data.metadata.available[sklandMetric]} / ${skland.data.metadata.totalOperators} 条档案的${countLabel}`
                ) : loading ? (
                  '正在读取森空岛话题统计…'
                ) : (
                  '等待本地采集快照'
                )
              ) : (
                <RankingNotice />
              )}
            </p>
            {view === 'bars' && (
              <button
                className="sort-button"
                onClick={() => setSort(sort === 'desc' ? 'asc' : 'desc')}
              >
                {sort === 'desc' ? (
                  <ArrowDown size={12} aria-hidden="true" />
                ) : (
                  <ArrowUp size={12} aria-hidden="true" />
                )}
                {countLabel}
                {sort === 'desc' ? '降序' : '升序'}
              </button>
            )}
          </div>
          {!isSkland && loading && !data && (
            <p className="count-message" role="status">
              正在读取标签统计…
            </p>
          )}
          {error && (
            <p className="count-message" role="status">
              {error}
              {data ? ' 当前显示上次取得的数据。' : ''}
            </p>
          )}
          {(activeFilters > 0 || favoritesOnly) && (
            <div className="active-filter-chips">
              {favoritesOnly && (
                <button onClick={onClearFavorites}>
                  我的关注
                  <X size={11} aria-hidden="true" />
                </button>
              )}
              {activeFilters > 0 && <span>{activeFilters} 项筛选条件</span>}
              <button className="clear-filters" onClick={reset}>
                清除筛选
              </button>
            </div>
          )}
          {hiddenIds.length > 0 && onRestoreHidden && onClearHidden && (
            <HiddenOperatorsBar
              hiddenIds={hiddenIds}
              operators={operators}
              onRestore={onRestoreHidden}
              onRestoreAll={onClearHidden}
            />
          )}
          {isSkland && !skland.data ? (
            <div className="empty-state">
              <BrandIcon name="skland" size={30} />
              <h3>{loading ? '正在读取本地快照' : error ? '话题统计读取失败' : '尚未采集'}</h3>
              <p>本地采集快照可用后，这里会显示干员的话题排行。</p>
            </div>
          ) : !operators.length ? (
            <div className="empty-state">
              <div className="loading-bars">
                <i />
                <i />
                <i />
              </div>
              <h3>正在整理干员档案</h3>
              <p>热爱的回响，即将呈现。</p>
            </div>
          ) : !ranked.length ? (
            <div className="empty-state">
              <Search size={30} aria-hidden="true" />
              <h3>暂时没有匹配的干员</h3>
              <p>试试其他名称，或减少筛选条件。</p>
              <button
                className="outline-button"
                onClick={() => {
                  reset();
                  if (!activeFilters && !query && !favoritesOnly && hiddenIds.length > 0) {
                    onClearHidden?.();
                  }
                }}
              >
                查看全部干员
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          ) : view === 'heatmap' ? (
            treemapEntries.length ? (
              <TreemapHeatmap
                entries={treemapEntries}
                metricLabel={countLabel}
                onSelect={(op) => setDetailId(op.id)}
              />
            ) : (
              <div className="empty-state">
                <Grid2X2 size={30} aria-hidden="true" />
                <h3>当前范围还没有{countLabel}数据</h3>
                <p>未提供的指标保留为空，不会当作 0 参与展示。</p>
              </div>
            )
          ) : (
            <>
              <div className="bar-table-heading">
                <span>排名</span>
                <span>干员 / 阵营</span>
                <div className="axis-labels">
                  <span>0</span>
                  <span>{compactNumber(max / 2)}</span>
                  <span>{compactNumber(max)}</span>
                </div>
                <span className="align-right">{countLabel}</span>
              </div>
              <div className="bar-table">
                {rows.map(({ operator: o, record: r }, i) => (
                  <div className="bar-row" key={o.id} style={{ '--row-index': i } as CSSProperties}>
                    <span className={`rank-number ${i < 3 ? 'top-rank' : ''}`}>
                      {r?.workCount === null || !r ? '—' : String(i + 1).padStart(2, '0')}
                    </span>
                    <div className="operator-cell">
                      <button className="operator-button" onClick={() => setDetailId(o.id)}>
                        <img src={o.avatar} alt="" width={38} height={38} loading="lazy" />
                        <span>
                          <strong>
                            {o.name}
                            {(platform === 'bilibili'
                              ? (r?.sharedOperatorIds ?? [o.id]).some((id) => favorites.has(id))
                              : favorites.has(o.id)) && (
                              <Heart size={10} fill="currentColor" aria-label="已关注" />
                            )}
                          </strong>
                          <small>
                            {o.profession}
                            <span className="name-dot">·</span>
                            {o.factions[0] || '未知阵营'}
                          </small>
                        </span>
                      </button>
                      {onToggleHide && (
                        <button
                          type="button"
                          className="row-hide-button"
                          aria-label={`隐藏${o.name}`}
                          title={`隐藏${o.name}`}
                          onClick={() => onToggleHide(o.id, r?.sharedOperatorIds)}
                        >
                          <EyeOff size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <div className="bar-plot" aria-hidden="true">
                      {r?.workCount !== null && r && (
                        <div
                          className="count-bar"
                          style={{ width: `${(r.workCount / max) * 100}%` }}
                        />
                      )}
                    </div>
                    <button
                      className="row-total count-total"
                      onClick={() => setDetailId(o.id)}
                      aria-label={`${o.name}${countLabel} ${r?.workCount == null ? '未取得' : isDouyin || isXiaohongshu ? r.workCount.toLocaleString('zh-CN') : (r.displayValue ?? r.workCount.toLocaleString('zh-CN'))}，查看来源`}
                    >
                      {r?.workCount == null ? (
                        '未取得'
                      ) : (
                        <>
                          {r.lowerBound ? '≥ ' : r.approximate ? '约 ' : ''}
                          {r.displayValue ?? r.workCount.toLocaleString('zh-CN')}
                          {!isLofter && !isDouyin && !r.complete && (
                            <small className="count-partial-label">部分</small>
                          )}
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
              <div className="chart-footer">
                <span>
                  显示 1–{rows.length} 位，共 {ranked.length} 位干员
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
            </>
          )}
        </section>
        <footer className="page-footer">
          <span>为喜欢的干员，记录每一次回响。</span>
        </footer>
      </main>
      {detail && (
        <CountDetail
          platform={platform}
          countLabel={countLabel}
          operator={detail}
          record={detailRecord}
          favorite={
            platform === 'bilibili'
              ? (detailRecord?.sharedOperatorIds ?? [detail.id]).some((id) => favorites.has(id))
              : favorites.has(detail.id)
          }
          onFavorite={() =>
            onFavorite(
              detail.id,
              platform === 'bilibili' ? detailRecord?.sharedOperatorIds : undefined,
            )
          }
          hidden={isOperatorHidden(hiddenSet, detail.id, detailRecord?.sharedOperatorIds)}
          onToggleHide={
            onToggleHide
              ? () => onToggleHide(detail.id, detailRecord?.sharedOperatorIds)
              : undefined
          }
          onClose={() => setDetailId(null)}
        />
      )}
    </>
  );
}

export function CountDetail({
  platform,
  countLabel,
  operator: o,
  record: r,
  favorite,
  onFavorite,
  hidden = false,
  onToggleHide,
  onClose,
}: {
  platform: CountPlatform;
  countLabel: string;
  operator: Operator;
  record: TagSummaryRow | undefined;
  favorite: boolean;
  onFavorite: () => void;
  hidden?: boolean;
  onToggleHide?: () => void;
  onClose: () => void;
}) {
  const isXiaohongshu = platform === 'xiaohongshu';
  const isWeibo = platform === 'weibo';
  const isSkland = platform === 'skland';
  const isTopic = platform === 'douyin' || isXiaohongshu || isWeibo || isSkland;
  return (
    <Modal
      title={`${PLATFORM_NAMES[platform]}${isTopic ? '话题' : '标签'}统计`}
      onClose={onClose}
      drawer
    >
      <div className="detail-identity">
        <img src={o.avatar} alt="" width={72} height={72} />
        <div>
          <h3>{o.name}</h3>
          <p>{o.englishName}</p>
        </div>
      </div>
      <div className="detail-tags">
        <span>
          {o.profession} · {o.branch}
        </span>
        {o.factions.map((f) => (
          <span key={f}>{f}</span>
        ))}
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
          {countLabel}
          <span className="summary-tag">
            {platform === 'lofter' ? '平台累计显示' : isTopic ? '话题累计' : '单角色 TAG'}
          </span>
        </span>
        <strong>
          {r?.workCount == null
            ? '未取得'
            : `${r.lowerBound ? '≥ ' : r.approximate ? '约 ' : ''}${isTopic && !isWeibo ? r.workCount.toLocaleString('zh-CN') : (r.displayValue ?? r.workCount.toLocaleString('zh-CN'))}`}
        </strong>
        <p>
          {platform === 'lofter' ? '来源标签' : isTopic ? '来源话题' : '干员名称'}：
          {isTopic && (!isSkland || r?.nativeTag) ? '#' : ''}
          {r?.nativeTag || (isXiaohongshu || isWeibo || isSkland ? '未取得' : o.name)}
        </p>
        {platform === 'bilibili' && <p>本体与异格合并，按各形态 TAG 使用数合计。</p>}
        {isTopic && !isWeibo && <p>话题 ID：{r?.topicId || '未取得'}</p>}
      </div>
      <dl className="count-detail-meta">
        {isSkland && (
          <div>
            <dt>话题发布时间</dt>
            <dd>{dateLabel(r?.publishedAt)}</dd>
          </div>
        )}
        <div>
          <dt>采集时间</dt>
          <dd>{dateLabel(r?.observedAt)}</dd>
        </div>
        <div>
          <dt>数据状态</dt>
          <dd>
            {r?.workCount == null
              ? r?.missingReason || '尚未取得统计，不计为零。'
              : platform === 'lofter'
                ? r.approximate
                  ? '平台缩写显示，按约数排序，不冒充精确数量。'
                  : '平台原始显示的精确整数。'
                : r.coverageNote}
          </dd>
        </div>
      </dl>
      {isTopic && r?.sharedOperatorIds && r.sharedOperatorIds.length > 1 && (
        <p className="muted">
          {isSkland
            ? '多个干员档案共用这份话题统计，排行仅显示一条。'
            : '阿米娅各职业形态共用这份话题统计，未重复采集或相加。'}
        </p>
      )}
      {platform === 'lofter' && (
        <dl className="count-detail-meta">
          <div>
            <dt>标签浏览</dt>
            <dd>
              {r?.nativeViews
                ? `${r.nativeViews.exact ? '' : '约 '}${r.nativeViews.display}`
                : '未取得'}
            </dd>
          </div>
          <div>
            <dt>标签参与</dt>
            <dd>
              {r?.nativeParticipation
                ? `${r.nativeParticipation.exact ? '' : '约 '}${r.nativeParticipation.display}`
                : '未取得'}
            </dd>
          </div>
        </dl>
      )}
      {isWeibo && (
        <dl className="count-detail-meta">
          <div>
            <dt>原创人数</dt>
            <dd>{nativeLabel(r?.nativeOriginalAuthors)}</dd>
          </div>
          <div>
            <dt>讨论次数</dt>
            <dd>{nativeLabel(r?.nativeDiscussions)}</dd>
          </div>
          <div>
            <dt>阅读次数</dt>
            <dd>{nativeLabel(r?.nativeReads)}</dd>
          </div>
        </dl>
      )}
      {isSkland && (
        <dl className="count-detail-meta">
          <div>
            <dt>浏览量</dt>
            <dd>{nativeLabel(r?.nativeReads)}</dd>
          </div>
          <div>
            <dt>发帖数</dt>
            <dd>{nativeLabel(r?.nativePosts)}</dd>
          </div>
          <div>
            <dt>讨论数</dt>
            <dd>{nativeLabel(r?.nativeDiscussions)}</dd>
          </div>
        </dl>
      )}
      {platform === 'bilibili' && r?.components && (
        <>
          <h4 className="detail-section-title">各形态 TAG 使用数</h4>
          <dl className="count-detail-meta">
            {r.components.map((part) => (
              <div key={part.tag}>
                <dt>#{part.nativeTag}</dt>
                <dd>
                  {part.workCount === null ? '未取得' : part.workCount.toLocaleString('zh-CN')}
                  <small className="muted"> · {dateLabel(part.observedAt)}</small>
                  {part.workCount === null && part.missingReason && <p>{part.missingReason}</p>}
                  {part.updateError && <p>{part.updateError}</p>}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {r?.updateError && (
        <p className="count-message">最近刷新未成功，保留上次的数量和采集时间：{r.updateError}</p>
      )}
    </Modal>
  );
}
