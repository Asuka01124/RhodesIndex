import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronDown,
  Grid2X2,
  Heart,
  Info,
  Menu,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { Filters, NativeTagCount, Operator, TagSummaryRow, ViewMode } from './types';
import { compactNumber, csvEscape, EMPTY_FILTERS, filterCount, YEARS } from './domain';
import { BrandIcon, downloadFile, Modal, RankingNotice, Segmented } from './ui';
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
      title={`${isLofter ? 'LOFTER' : isDouyin ? '抖音' : '哔哩哔哩'}数据与来源`}
      onClose={onClose}
    >
      <div className="count-method">
        <h3>
          {isLofter ? '中文标签的浏览与参与' : isDouyin ? '话题累计播放量' : '组合关键词搜索结果数'}
        </h3>
        <p>
          {isLofter
            ? '展示已采集的标签浏览与参与原文；万、亿等缩写标为约数。参与数不冒充已去重作品总数。'
            : isDouyin
              ? '读取平台同名话题的原生累计播放量 view_count；它不是作品数或独立热度指数。阿米娅三个职业形态共用同一份统计，不重复相加。'
              : '搜索角色中文名和明日方舟，联动角色再加对应作品名。直接读取搜索接口返回的数量；触顶时按不重叠时间段汇总，不再逐条核验视频标签。'}
        </p>
        <p>
          不同标签可能包含同一件作品，不将各干员数量相加为平台总量。未取得的数据保留为空；采集中、受限或截断如实标注。
        </p>
        <p>
          {isLofter
            ? '打开干员详情可查看标签、来源和采集时间。'
            : isDouyin
              ? '话题名称与干员主名相同，不代表内容全部属于该角色；常见名称可能混入其他内容。详情和CSV保留完整数值、话题ID、来源和采集时间。'
              : '搜索可命中标题、简介等内容，不保证同时打齐标签，也不代表全站总量。详情保留实际搜索词、来源和采集时间。'}
        </p>
        {isDouyin && (
          <p>
            默认隐藏播放量 10
            亿及以上的同名话题结果。可在顶部“隐藏同名”开关中恢复查看；隐藏不随排序或筛选变化，原始数据保留。
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
  onFavorite: (id: string) => void;
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
            : '搜索结果数';
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
  const [exported, setExported] = useState(false);
  const deferredQuery = useDeferredValue(query);
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
  ]);
  useEffect(() => {
    if (!exported) return;
    const timer = setTimeout(() => setExported(false), 2500);
    return () => clearTimeout(timer);
  }, [exported]);
  const exportCsv = () => {
    const matrix = isLofter
      ? [
          [
            '干员',
            '职业',
            '阵营',
            '浏览（原文）',
            '浏览精度',
            '参与（原文）',
            '参与精度',
            '来源标签',
            '来源',
            '采集时间',
          ],
          ...ranked.map(({ operator: o, record: r }) => [
            o.name,
            o.profession,
            o.factions.join('、'),
            r?.nativeViews?.display ?? null,
            r?.nativeViews ? (r.nativeViews.exact ? '精确' : '约数') : '未取得',
            r?.nativeParticipation?.display ?? null,
            r?.nativeParticipation ? (r.nativeParticipation.exact ? '精确' : '约数') : '未取得',
            r?.tag ?? o.name,
            r?.url ?? '',
            r?.observedAt ?? '',
          ]),
        ]
      : isDouyin
        ? [
            ['干员', '话题', '话题累计播放量', '话题ID', '归属说明', '来源', '采集时间'],
            ...ranked.map(({ operator: o, record: r }) => [
              o.name,
              r?.tag ?? o.name,
              r?.workCount ?? null,
              r?.topicId ?? '',
              '同名话题，角色归属待核实',
              r?.apiSourceUrl ?? '',
              r?.observedAt ?? '',
            ]),
          ]
        : [
            [
              '干员',
              '职业',
              '阵营',
              '组合搜索结果数',
              '统计范围',
              '实际搜索词',
              '来源',
              '采集时间',
            ],
            ...ranked.map(({ operator: o, record: r }) => [
              o.name,
              o.profession,
              o.factions.join('、'),
              r?.workCount ?? null,
              r?.coverageNote ?? '未取得',
              r?.query ?? '',
              r?.apiSourceUrl ?? '',
              r?.observedAt ?? '',
            ]),
          ];
    downloadFile(
      `罗德指数-${platformName}-${isDouyin ? '话题' : '标签'}统计.csv`,
      '\ufeff' + matrix.map((row) => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8',
    );
    setExported(true);
  };
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
                      : '组合搜索结果数'}
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
              {isXiaohongshu || isWeibo || isSkland ? (
                <button
                  className="icon-button export-button"
                  aria-label={`${platformName}热度规则`}
                  title={`${platformName}热度规则`}
                  aria-haspopup="dialog"
                  onClick={onInfo}
                >
                  <Info size={16} aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="icon-button export-button"
                  aria-label={`导出${isDouyin ? '话题' : '标签'}统计 CSV`}
                  title={`导出${isDouyin ? '话题' : '标签'}统计 CSV`}
                  onClick={exportCsv}
                  disabled={!data}
                >
                  {exported ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <ArrowDownToLine size={16} aria-hidden="true" />
                  )}
                </button>
              )}
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
              <button className="outline-button" onClick={reset}>
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
                    <button className="operator-button" onClick={() => setDetailId(o.id)}>
                      <img src={o.avatar} alt="" width={38} height={38} loading="lazy" />
                      <span>
                        <strong>
                          {o.name}
                          {favorites.has(o.id) && (
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
        <div className="chart-caption count-caption">
          <span>
            <Info size={13} aria-hidden="true" />
            {isSkland
              ? '森空岛话题的原生累计统计。未取得的指标留空，共用话题只排一次。'
              : isLofter
                ? '平台标签浏览／参与显示值；约数按显示值估计排序，未取得不计为零。'
                : isDouyin
                  ? '同名话题累计播放量；角色归属待核实，可能包含其他内容，不代表作品数。'
                  : isXiaohongshu
                    ? '未取得浏览量的话题保留为空。'
                    : isWeibo
                      ? '角色话题的原生统计；万、亿为约数，未取得的指标留空。'
                      : '角色名＋明日方舟，联动再加作品名；数量来自组合搜索，不要求打齐标签，不代表全站总量。'}
          </span>
          <span>
            {view === 'heatmap' && treemapEntries.length > 0 && (
              <span className="heat-scale" style={{ marginRight: 14 }}>
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
            更新至 {dateLabel(data?.metadata.generatedAt)}
          </span>
        </div>
        <footer className="page-footer">
          <span>为喜欢的干员，记录每一次回响。</span>
          <button onClick={onInfo}>
            统计口径与数据来源
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        </footer>
      </main>
      {detail && (
        <CountDetail
          platform={platform}
          countLabel={countLabel}
          operator={detail}
          record={detailRecord}
          favorite={favorites.has(detail.id)}
          onFavorite={() => onFavorite(detail.id)}
          onClose={() => setDetailId(null)}
        />
      )}
    </>
  );
}

function CountDetail({
  platform,
  countLabel,
  operator: o,
  record: r,
  favorite,
  onFavorite,
  onClose,
}: {
  platform: CountPlatform;
  countLabel: string;
  operator: Operator;
  record: TagSummaryRow | undefined;
  favorite: boolean;
  onFavorite: () => void;
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
          {countLabel}
          <span className="summary-tag">
            {platform === 'lofter' ? '平台累计显示' : isTopic ? '话题累计' : '组合搜索'}
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
        {platform === 'bilibili' && <p>搜索关键词：{r?.query || '尚未取得'}</p>}
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
      {platform === 'bilibili' && r?.countedWindows !== undefined && (
        <p className="muted">
          已取得 {r.countedWindows} 个时间范围的小计，待处理 {r.pendingWindows ?? 0} 个范围。
        </p>
      )}
      {r?.updateError && (
        <p className="count-message">最近刷新未成功，保留上次的数量和采集时间：{r.updateError}</p>
      )}
      <h4 className="detail-section-title">记录来源</h4>
      <div className="record-sources">
        {r?.url && (
          <a href={r.url} target="_blank" rel="noreferrer">
            {platform === 'lofter'
              ? '打开平台标签页'
              : isTopic
                ? '查看平台原始汇总'
                : '打开对应搜索'}
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        )}
        {!isSkland && r?.apiSourceUrl && r.apiSourceUrl !== r.url && (
          <a href={r.apiSourceUrl} target="_blank" rel="noreferrer">
            查看平台原始统计
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        )}
      </div>
      <p className="muted detail-explanation">
        {platform === 'lofter'
          ? '浏览和参与是不同指标；参与不等同于已核验的去重作品数。'
          : platform === 'douyin'
            ? '这是平台同名话题的原生累计播放量 view_count；角色归属尚待核实，可能包含其他内容，不能当作作品量或角色专属热度。'
            : isXiaohongshu
              ? XIAOHONGSHU_METHOD
              : isSkland
                ? '浏览、发帖和讨论分别取自话题详情的原生累计字段。'
                : isWeibo
                  ? '原创人数、讨论次数和阅读次数均来自话题页“数据总览”；万、亿为约数，缺失保留为空，不能当作微博全站热度。'
                  : '数量来自组合关键词搜索，可包含标题或简介命中，并非严格标签交集。未完成分段或触顶时仅展示下限。'}{' '}
        同一作品可能出现在多个干员标签中，不直接相加。
      </p>
    </Modal>
  );
}
