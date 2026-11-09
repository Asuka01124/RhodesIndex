import { useDeferredValue, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Heart,
  Menu,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';
import type { Filters, Metric, Operator, TagSummaryRow } from './types';
import {
  compactNumber,
  EMPTY_FILTERS,
  filterCount,
  matchesOperator,
  rankOperators,
  YEARS,
} from './domain';
import { BrandIcon, Modal, Segmented } from './ui';
import { FilterPanel } from './Filters';
import { RaritySlider } from './RaritySlider';
import { CollaborationToggle } from './CollaborationToggle';
import { collaborationRoster } from './collaborations';
import { rankTagCounts } from './tagCounts';
import {
  useTagCounts,
  useLofterTagCounts,
  useDouyinTopicCounts,
  useXiaohongshuTopicCounts,
  useWeiboTagCounts,
  useSklandTagCounts,
  usePixivSummary,
} from './useTagCounts';
import { VISIBLE_PIXIV_METRICS } from './pixiv';
import { lofterDisplayRows } from './lofterCounts';
import { douyinDisplayRows, douyinRoster } from './douyinCounts';
import { hideAmbiguousDouyinTopics } from './douyinAmbiguity';
import { xiaohongshuDisplayRows } from './xiaohongshuCounts';
import {
  WEIBO_METRICS,
  WEIBO_METRIC_LABELS,
  weiboDisplayRows,
  type WeiboMetric,
} from './weiboCounts';
import {
  SKLAND_METRICS,
  SKLAND_METRIC_LABELS,
  sklandDisplayRows,
  sklandRoster,
  type SklandMetric,
} from './sklandCounts';
import { CountDetail } from './BilibiliCountsPage';

type MatrixPlatform =
  'bilibili' | 'pixiv' | 'skland' | 'lofter' | 'weibo' | 'xiaohongshu' | 'douyin';

const PIXIV_METRIC_DETAIL_LABELS: Record<Metric, string> = {
  workCount: '作品数',
  views: '浏览量',
  likes: '点赞数',
  bookmarks: '收藏数',
  comments: '评论数',
};

const LOFTER_METRICS = [
  { value: 'participation' as const, label: '参与' },
  { value: 'views' as const, label: '浏览' },
];

interface PlatformCellData {
  value: number | null;
  display: string | null;
  rank: number | null;
  totalRanked: number;
  record?: TagSummaryRow;
}

function resolveSharedId(
  operatorId: string,
  map: Map<string, PlatformCellData>,
): PlatformCellData | undefined {
  const direct = map.get(operatorId);
  if (direct) return direct;
  if (operatorId === 'char_1001_amiya2' || operatorId === 'char_1037_amiya3') {
    return map.get('char_002_amiya');
  }
  return undefined;
}

export function FavoritesMatrixPage({
  operators,
  favorites,
  onFavorite,
  includeCollaborations,
  onIncludeCollaborationsChange,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  filterOpen,
  onFilterOpen,
  onCloseFilters,
  searchRef,
  filterRef,
  mobileToggleRef,
  mobileMenu,
  onToggleMenu,
  onOpenPixivDetail,
}: {
  operators: Operator[];
  favorites: Set<string>;
  onFavorite: (id: string) => void;
  includeCollaborations: boolean;
  onIncludeCollaborationsChange: (value: boolean) => void;
  query: string;
  onQueryChange: (value: string) => void;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  filterOpen: boolean;
  onFilterOpen: () => void;
  onCloseFilters: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  filterRef: RefObject<HTMLButtonElement | null>;
  mobileToggleRef: RefObject<HTMLButtonElement | null>;
  mobileMenu: boolean;
  onToggleMenu: () => void;
  onOpenPixivDetail: (operator: Operator, metric: Metric) => void;
}) {
  const [sortPlatform, setSortPlatform] = useState<MatrixPlatform>('bilibili');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [pixivMetric, setPixivMetric] = useState<Metric>('workCount');
  const [sklandMetric, setSklandMetric] = useState<SklandMetric>('viewNum');
  const [lofterMetric, setLofterMetric] = useState<'participation' | 'views'>('participation');
  const [weiboMetric, setWeiboMetric] = useState<WeiboMetric>('originalAuthors');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerInitialFavs, setPickerInitialFavs] = useState<Set<string>>(() => new Set());
  const openPicker = () => {
    setPickerInitialFavs(new Set(favorites));
    setPickerOpen(true);
  };
  const [tagDetail, setTagDetail] = useState<{
    platform: Exclude<MatrixPlatform, 'pixiv'>;
    countLabel: string;
    operator: Operator;
    record: TagSummaryRow | undefined;
  } | null>(null);

  const bili = useTagCounts(true);
  const pixiv = usePixivSummary(true);
  const skland = useSklandTagCounts(true);
  const lofter = useLofterTagCounts(true);
  const weibo = useWeiboTagCounts(true);
  const xiaohongshu = useXiaohongshuTopicCounts(true);
  const douyin = useDouyinTopicCounts(true);

  const deferredQuery = useDeferredValue(query);
  const activeFilters = filterCount(filters);

  const columns = useMemo(
    () =>
      [
        { id: 'bilibili', name: '哔哩哔哩', metricLabel: '标签使用数', icon: 'bilibili' },
        {
          id: 'pixiv',
          name: 'Pixiv',
          metricLabel: PIXIV_METRIC_DETAIL_LABELS[pixivMetric],
          icon: 'pixiv',
        },
        {
          id: 'skland',
          name: '森空岛',
          metricLabel: SKLAND_METRIC_LABELS[sklandMetric],
          icon: 'skland',
        },
        {
          id: 'lofter',
          name: 'LOFTER',
          metricLabel: lofterMetric === 'participation' ? '标签参与数' : '标签浏览量',
          icon: 'pen',
        },
        {
          id: 'weibo',
          name: '微博',
          metricLabel: WEIBO_METRIC_LABELS[weiboMetric],
          icon: 'sinaweibo',
        },
        { id: 'xiaohongshu', name: '小红书', metricLabel: '话题浏览量', icon: 'xiaohongshu' },
        { id: 'douyin', name: '抖音', metricLabel: '话题播放量', icon: 'tiktok' },
      ] as const,
    [pixivMetric, sklandMetric, lofterMetric, weiboMetric],
  );

  const baseRoster = useMemo(
    () => collaborationRoster(operators, includeCollaborations),
    [operators, includeCollaborations],
  );

  // 计算各平台全站排名映射表（以全站所有干员为基准，保证名次为真实全站名次）
  const platformMaps = useMemo(() => {
    const buildTagMap = (roster: Operator[], rows: TagSummaryRow[], isTopicLike = false) => {
      const ranked = rankTagCounts(roster, rows, EMPTY_FILTERS, '', 'desc');
      const totalRanked = ranked.filter((r) => r.record?.workCount != null).length;
      const map = new Map<string, PlatformCellData>();
      ranked.forEach(({ operator, record }, index) => {
        const val = record?.workCount ?? null;
        const display =
          val === null
            ? null
            : `${record?.lowerBound ? '≥ ' : record?.approximate ? '约 ' : ''}${
                isTopicLike ? compactNumber(val) : (record?.displayValue ?? compactNumber(val))
              }`;
        const cell: PlatformCellData = {
          value: val,
          display,
          rank: val === null ? null : index + 1,
          totalRanked,
          record: record ?? undefined,
        };
        map.set(operator.id, cell);
        if (record?.sharedOperatorIds) {
          for (const sharedId of record.sharedOperatorIds) {
            if (!map.has(sharedId)) map.set(sharedId, cell);
          }
        }
      });
      return map;
    };

    const biliMap = buildTagMap(baseRoster, bili.data?.records ?? []);
    const sklandMap = buildTagMap(
      sklandRoster(baseRoster, skland.data),
      sklandDisplayRows(skland.data, sklandMetric),
      true,
    );
    const lofterMap = buildTagMap(baseRoster, lofterDisplayRows(lofter.data, lofterMetric));
    const weiboMap = buildTagMap(
      douyinRoster(baseRoster),
      weiboDisplayRows(weibo.data, weiboMetric),
    );
    const xhsMap = buildTagMap(
      douyinRoster(baseRoster),
      xiaohongshuDisplayRows(xiaohongshu.data),
      true,
    );
    const douyinMap = buildTagMap(
      hideAmbiguousDouyinTopics(douyinRoster(baseRoster), true, douyin.data?.records),
      douyinDisplayRows(douyin.data),
      true,
    );

    const pixivSource =
      pixivMetric === 'workCount'
        ? (pixiv.data?.countRecords ?? pixiv.data?.records ?? [])
        : (pixiv.data?.records ?? []);
    const knownPixivCounts = new Set(
      pixivMetric === 'workCount'
        ? (pixiv.data?.metadata.countOperatorIds ?? pixiv.data?.metadata.operatorIds ?? []).filter(
            (id) => !pixiv.data?.metadata.unknownYearCounts?.[id],
          )
        : [],
    );
    const pixivRanked = rankOperators(
      baseRoster,
      pixivSource,
      'pixiv',
      pixivMetric,
      YEARS,
      EMPTY_FILTERS,
      '',
      'desc',
      undefined,
      knownPixivCounts,
    );
    const pixivTotal = pixivRanked.filter((r) => r.available).length;
    const pixivMap = new Map<string, PlatformCellData>();
    pixivRanked.forEach((row, index) => {
      pixivMap.set(row.operator.id, {
        value: row.available ? row.total : null,
        display: row.available ? compactNumber(row.total) : null,
        rank: row.available ? index + 1 : null,
        totalRanked: pixivTotal,
      });
    });

    return {
      bilibili: biliMap,
      pixiv: pixivMap,
      skland: sklandMap,
      lofter: lofterMap,
      weibo: weiboMap,
      xiaohongshu: xhsMap,
      douyin: douyinMap,
    } satisfies Record<MatrixPlatform, Map<string, PlatformCellData>>;
  }, [
    baseRoster,
    bili.data,
    pixiv.data,
    pixivMetric,
    skland.data,
    sklandMetric,
    lofter.data,
    lofterMetric,
    weibo.data,
    weiboMetric,
    xiaohongshu.data,
    douyin.data,
  ]);

  const favoriteRows = useMemo(() => {
    const matched = baseRoster.filter(
      (op) => favorites.has(op.id) && matchesOperator(op, filters, deferredQuery),
    );
    return matched.sort((a, b) => {
      const map = platformMaps[sortPlatform];
      const av = resolveSharedId(a.id, map)?.value ?? null;
      const bv = resolveSharedId(b.id, map)?.value ?? null;
      if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
      const diff = sortDir === 'desc' ? (bv ?? 0) - (av ?? 0) : (av ?? 0) - (bv ?? 0);
      return diff || a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [baseRoster, favorites, filters, deferredQuery, platformMaps, sortPlatform, sortDir]);

  const handleSortColumn = (platform: MatrixPlatform) => {
    if (sortPlatform === platform) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortPlatform(platform);
      setSortDir('desc');
    }
  };

  const resetFilters = () => {
    onFiltersChange({ ...EMPTY_FILTERS, rarityTiers: filters.rarityTiers });
    onQueryChange('');
  };

  const pickerCandidates = useMemo(() => {
    const q = pickerQuery.trim().toLocaleLowerCase();
    return operators
      .filter((op) => {
        if (!q) return true;
        return [op.name, op.englishName, op.japaneseName, op.profession, ...op.factions]
          .join(' ')
          .toLocaleLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        const aFav = pickerInitialFavs.has(a.id);
        const bFav = pickerInitialFavs.has(b.id);
        if (aFav !== bFav) return aFav ? -1 : 1;
        if (a.rarity !== b.rarity) return b.rarity - a.rarity;
        return a.name.localeCompare(b.name, 'zh-CN');
      })
      .slice(0, 72);
  }, [operators, pickerQuery, pickerInitialFavs]);

  const activeCol = columns.find((c) => c.id === sortPlatform)!;

  return (
    <>
      <header className="topbar bili-count-topbar favorites-topbar">
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
          <div className="quick-filter-controls">
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
            <button className="outline-button fav-add-trigger" onClick={openPicker}>
              <Plus size={15} aria-hidden="true" />
              <span>添加关注</span>
            </button>
          </div>
        </div>
      </header>

      <main id="main-content" className="main-content favorites-matrix-page">
        <section className="chart-section" aria-label="我的关注跨平台热度对比表">
          <div className="chart-toolbar">
            <div className="chart-title">
              <span className="chart-title-icon">
                <Heart size={17} strokeWidth={1.6} aria-hidden="true" />
              </span>
              <h1>我的关注 · 跨平台对比</h1>
              <span className="chart-count">{favoriteRows.length}</span>
            </div>
            <div className="chart-actions">
              <label className="search-box">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchRef}
                  aria-label="在关注的干员中搜索"
                  placeholder="搜索已关注干员…"
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
            </div>
          </div>

          <div className="chart-options count-options fav-matrix-options">
            <div className="fav-metric-bar">
              {sortPlatform === 'pixiv' && (
                <Segmented
                  label="Pixiv 统计指标"
                  value={pixivMetric}
                  onChange={setPixivMetric}
                  options={VISIBLE_PIXIV_METRICS}
                  className="pixiv-metrics"
                />
              )}
              {sortPlatform === 'skland' && (
                <Segmented
                  label="森空岛统计指标"
                  value={sklandMetric}
                  onChange={setSklandMetric}
                  options={SKLAND_METRICS.map((m) => ({ ...m }))}
                />
              )}
              {sortPlatform === 'lofter' && (
                <Segmented
                  label="LOFTER 统计指标"
                  value={lofterMetric}
                  onChange={setLofterMetric}
                  options={LOFTER_METRICS}
                />
              )}
              {sortPlatform === 'weibo' && (
                <Segmented
                  label="微博统计指标"
                  value={weiboMetric}
                  onChange={setWeiboMetric}
                  options={WEIBO_METRICS.map((m) => ({ ...m }))}
                />
              )}
            </div>
            <button
              className="sort-button"
              onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
            >
              {sortDir === 'desc' ? (
                <ArrowDown size={12} aria-hidden="true" />
              ) : (
                <ArrowUp size={12} aria-hidden="true" />
              )}
              {activeCol.metricLabel}
              {sortDir === 'desc' ? '降序' : '升序'}
            </button>
          </div>

          {activeFilters > 0 && (
            <div className="active-filter-chips">
              <span>{activeFilters} 项筛选条件</span>
              <button className="clear-filters" onClick={resetFilters}>
                清除筛选
              </button>
            </div>
          )}

          {!operators.length ? (
            <div className="empty-state">
              <div className="loading-bars">
                <i />
                <i />
                <i />
              </div>
              <h3>正在整理干员档案</h3>
              <p>热爱的回响，即将呈现。</p>
            </div>
          ) : favorites.size === 0 ? (
            <div className="empty-state">
              <Heart size={30} strokeWidth={1.3} aria-hidden="true" />
              <h3>还没有关注的干员</h3>
              <p>添加你喜欢的干员，即可在一张表内横向对比 7 大平台的热度与全站排名。</p>
              <button className="outline-button" onClick={openPicker}>
                <Plus size={14} aria-hidden="true" />
                选择要关注的干员
              </button>
            </div>
          ) : !favoriteRows.length ? (
            <div className="empty-state">
              <Search size={30} strokeWidth={1.3} aria-hidden="true" />
              <h3>没有匹配的已关注干员</h3>
              <p>当前共关注 {favorites.size} 位干员，试试放宽星级或筛选条件。</p>
              <button
                className="outline-button"
                onClick={() => {
                  onFiltersChange({ ...EMPTY_FILTERS });
                  onQueryChange('');
                }}
              >
                显示全部已关注干员
              </button>
            </div>
          ) : (
            <div className="fav-matrix-scroll">
              <table className="fav-matrix-table">
                <thead>
                  <tr>
                    <th scope="col" className="fav-col-operator">
                      干员 / 阵营
                    </th>
                    {columns.map((col) => {
                      const isActive = sortPlatform === col.id;
                      return (
                        <th
                          key={col.id}
                          scope="col"
                          aria-sort={
                            isActive ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none'
                          }
                          className={isActive ? 'is-sorted' : 'is-dimmed'}
                        >
                          <button
                            type="button"
                            className="fav-th-button"
                            onClick={() => handleSortColumn(col.id)}
                          >
                            <span className="fav-th-title">
                              <BrandIcon name={col.icon} size={15} />
                              {col.name}
                              {isActive &&
                                (sortDir === 'desc' ? (
                                  <ArrowDown size={13} aria-hidden="true" />
                                ) : (
                                  <ArrowUp size={13} aria-hidden="true" />
                                ))}
                            </span>
                            <small>{col.metricLabel}</small>
                          </button>
                        </th>
                      );
                    })}
                    <th scope="col" className="fav-col-action" aria-label="关注操作" />
                  </tr>
                </thead>
                <tbody>
                  {favoriteRows.map((operator) => (
                    <tr key={operator.id}>
                      <td className="fav-col-operator">
                        <button
                          type="button"
                          className="operator-button"
                          onClick={() => onOpenPixivDetail(operator, pixivMetric)}
                        >
                          <img src={operator.avatar} alt="" width={38} height={38} loading="lazy" />
                          <span>
                            <strong>{operator.name}</strong>
                            <small>
                              {operator.profession}
                              <span className="name-dot">·</span>
                              {operator.factions[0] || '未知阵营'}
                            </small>
                          </span>
                        </button>
                      </td>
                      {columns.map((col) => {
                        const cell = resolveSharedId(operator.id, platformMaps[col.id]);
                        const hasVal = cell && cell.value !== null && cell.display !== null;
                        const isActive = sortPlatform === col.id;
                        return (
                          <td key={col.id} className={isActive ? 'is-sorted-col' : 'is-dimmed-col'}>
                            <button
                              type="button"
                              className="fav-cell-button"
                              onClick={() => {
                                if (col.id === 'pixiv') {
                                  onOpenPixivDetail(operator, pixivMetric);
                                } else {
                                  setTagDetail({
                                    platform: col.id,
                                    countLabel: col.metricLabel,
                                    operator,
                                    record: cell?.record,
                                  });
                                }
                              }}
                              aria-label={`查看${operator.name}在${col.name}的统计详情`}
                            >
                              {hasVal ? (
                                <>
                                  <span className="fav-cell-val">{cell.display}</span>
                                  <span
                                    className={`fav-cell-rank ${cell.rank !== null && cell.rank <= 10 ? 'is-top' : ''}`}
                                  >
                                    #{String(cell.rank).padStart(2, '0')}
                                  </span>
                                </>
                              ) : (
                                <span className="fav-cell-empty">未取得</span>
                              )}
                            </button>
                          </td>
                        );
                      })}
                      <td className="fav-col-action">
                        <button
                          type="button"
                          className="icon-button fav-remove-btn"
                          title={`取消关注${operator.name}`}
                          aria-label={`取消关注${operator.name}`}
                          onClick={() => onFavorite(operator.id)}
                        >
                          <Heart size={15} fill="currentColor" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="page-footer">
          <span>为喜欢的干员，记录每一次回响。</span>
        </footer>
      </main>

      {pickerOpen && (
        <Modal title="添加 / 管理关注干员" onClose={() => setPickerOpen(false)}>
          <div className="fav-picker-modal">
            <label className="search-box fav-picker-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="text"
                placeholder="输入干员名称、外文名、职业或阵营…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                autoFocus
              />
              {pickerQuery && (
                <button aria-label="清除搜索" onClick={() => setPickerQuery('')}>
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </label>
            <p className="fav-picker-summary">
              已关注 <strong>{favorites.size}</strong> 位干员 · 点击卡片即可加入或移出关注
            </p>
            <div className="fav-picker-grid">
              {pickerCandidates.map((op) => {
                const isFav = favorites.has(op.id);
                return (
                  <button
                    key={op.id}
                    type="button"
                    className={`fav-picker-card ${isFav ? 'is-selected' : ''}`}
                    aria-pressed={isFav}
                    onClick={() => onFavorite(op.id)}
                  >
                    <img src={op.avatar} alt="" width={36} height={36} loading="lazy" />
                    <span className="fav-picker-info">
                      <strong>
                        {op.name}
                        <small className="fav-picker-rarity">
                          {op.rarity}
                          <Star size={9} fill="currentColor" aria-hidden="true" />
                        </small>
                      </strong>
                      <small>
                        {op.profession} · {op.factions[0] || '未知阵营'}
                      </small>
                    </span>
                    <Heart
                      size={15}
                      className="fav-picker-heart"
                      fill={isFav ? 'currentColor' : 'none'}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </Modal>
      )}

      {tagDetail && (
        <CountDetail
          platform={tagDetail.platform}
          countLabel={tagDetail.countLabel}
          operator={tagDetail.operator}
          record={tagDetail.record}
          favorite={favorites.has(tagDetail.operator.id)}
          onFavorite={() => onFavorite(tagDetail.operator.id)}
          onClose={() => setTagDetail(null)}
        />
      )}
    </>
  );
}
