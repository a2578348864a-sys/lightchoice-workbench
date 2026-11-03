"use client";

import { useState, type ReactNode } from "react";
import { Archive, LayoutGrid, RotateCcw, Search, Table2, Grid3X3, Trash2, X } from "lucide-react";
import styles from "./BatchWorkspace.module.css";
import matrixStyles from "./ProductMaterialMatrix.module.css";
import { ProductCard } from "./ProductCard";
import { ProductTable } from "./ProductTable";
import type { ProductSort } from "./productTablePresentation";
import type { GalleryItem } from "./presentation";

export type GalleryStatusFilter = "all" | "ready" | "review" | "blocked";

const FILTER_OPTIONS: Array<{ value: GalleryStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "ready", label: "有效商品" },
  { value: "review", label: "待核对" },
  { value: "blocked", label: "已排除" },
];

/**
 * T01 商品画廊：检索 / 既有状态筛选 / 商品选择 / 详情 / 来源 / 归档恢复删除入口。
 * 所有业务动作仍由既有 handler 执行；本组件只负责画廊的展示与工具条组织。
 */
export function ProductGallery({
  items,
  browseView = "gallery", onBrowseViewChange, tablePage = 0, onTablePageChange,
  matrixOpen = false,
  onMatrixOpenChange,
  matrixNode,
  matrixFilterLabel,
  matrixNotice,
  onClearMatrixFilter,
  sort,
  onSortChange,
  filteredItems,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  counts,
  selectedIds,
  onToggleSelect,
  onSelectAllFiltered,
  onClearSelection,
  expandedItemId,
  onOpenDetail,
  onArchive,
  onRestore,
  onDelete,
  busy,
  loading,
  bulkBusy,
  onBulk,
  bulkNoticeNode,
  marketplace,
  itemsLoaded = true,
  loadError = null,
  onRetryLoad,
}: {
  items: GalleryItem[];
  browseView?: "gallery" | "table"; onBrowseViewChange?: (view: "gallery" | "table") => void;
  tablePage?: number; onTablePageChange?: (page: number) => void;
  matrixOpen?: boolean;
  onMatrixOpenChange?: (value: boolean) => void;
  matrixNode?: ReactNode;
  matrixFilterLabel?: string;
  matrixNotice?: string;
  onClearMatrixFilter?: () => void;
  sort: ProductSort;
  onSortChange: (value: ProductSort) => void;
  filteredItems: GalleryItem[];
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: GalleryStatusFilter;
  onStatusFilterChange: (value: GalleryStatusFilter) => void;
  counts: Record<GalleryStatusFilter, number>;
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onSelectAllFiltered: (checked: boolean) => void;
  onClearSelection: () => void;
  expandedItemId: string | null;
  onOpenDetail: (id: string) => void;
  onArchive: (item: GalleryItem) => void;
  onRestore: (item: GalleryItem) => void;
  onDelete: (item: GalleryItem) => void;
  busy: boolean;
  loading: boolean;
  bulkBusy: boolean;
  onBulk: (action: "archive" | "restore" | "delete") => void;
  bulkNoticeNode?: ReactNode;
  marketplace: string | null;
  /** 是否已成功读取过该批次的商品（用于区分「读取中」与真实 0 条）。 */
  itemsLoaded?: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
}) {
  const view = browseView;
  const setView = (value: "gallery" | "table") => onBrowseViewChange?.(value);
  const [selectionNotice, setSelectionNotice] = useState("");
  const notifyFilterChange = () => { if (selectedIds.length) setSelectionNotice(`筛选已变更，已清除之前的 ${selectedIds.length} 项选择。`); };
  const selected = new Set(selectedIds);
  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every((item) => selected.has(item.id));
  const hasActiveFilter = Boolean(search.trim()) || statusFilter !== "all";
  const selectedCount = selectedIds.length;

  return (
    <section data-testid="batch-products-gallery" className={styles.gallery} aria-label="批次商品">
      <div className={styles.galleryHead}>
        <div className={styles.galleryTitleGroup}>
          <h3 className={styles.galleryTitle}>{matrixOpen ? "商品资料矩阵" : view === "gallery" ? "商品画廊" : "商品表格"}</h3>
          <span className={styles.galleryCount} data-testid="gallery-visible-count" aria-live="polite">
            {loading && !itemsLoaded ? "正在读取商品…" : `显示 ${filteredItems.length} / 共 ${items.length} 款`}
          </span>
          <div className={styles.viewSwitch} role="group" aria-label="商品视图">
            <button type="button" aria-pressed={!matrixOpen && view === "gallery"} data-testid="view-gallery" onClick={() => { onMatrixOpenChange?.(false); setView("gallery"); }}><LayoutGrid size={15} aria-hidden="true" />画廊</button>
            <button type="button" aria-pressed={!matrixOpen && view === "table"} data-testid="view-table" onClick={() => { onMatrixOpenChange?.(false); setView("table"); }}><Table2 size={15} aria-hidden="true" />表格</button>
          </div>
          {matrixNode ? <button type="button" className={matrixStyles.entryButton} aria-pressed={matrixOpen} aria-expanded={matrixOpen} data-testid="open-material-matrix" onClick={() => onMatrixOpenChange?.(!matrixOpen)}><Grid3X3 size={15} aria-hidden="true" />资料矩阵</button> : null}
        </div>

        <div className={styles.tools}>
          <div className={styles.searchBox}>
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={search}
              placeholder="搜索 ASIN、标题、品牌或类目…"
              aria-label="搜索商品"
              data-testid="batch-product-search"
              onChange={(event) => { notifyFilterChange(); onSearchChange(event.target.value); }}
            />
          </div>
          <div className={styles.segmented} role="group" aria-label="按可用状态筛选商品">
            {FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={styles.segment}
                aria-pressed={statusFilter === option.value}
                data-testid={`batch-status-filter-${option.value}`}
                onClick={() => { if (statusFilter !== option.value) { notifyFilterChange(); onStatusFilterChange(option.value); } }}
              >
                {option.label}
                <b>{itemsLoaded ? counts[option.value] ?? 0 : "–"}</b>
              </button>
            ))}
          </div>
          <select className={styles.sortSelect} aria-label="商品排序" value={sort} onChange={event => onSortChange(event.target.value as ProductSort)}>
            <option value="original">原始顺序</option><option value="price_asc">价格从低到高</option><option value="price_desc">价格从高到低</option><option value="rating_desc">评分从高到低</option><option value="reviews_desc">评价数从多到少</option>
          </select>
        </div>
      </div>

      {!matrixOpen && matrixFilterLabel ? <div className={matrixStyles.activeFilter} data-testid="active-material-filter">资料筛选：{matrixFilterLabel}<button type="button" onClick={onClearMatrixFilter}>清除资料筛选</button></div> : null}
      {matrixNotice ? <p className={styles.selectionNotice} role="status">{matrixNotice}</p> : null}
      {selectionNotice ? <p className={styles.selectionNotice} role="status">{selectionNotice}</p> : null}
      {!matrixOpen ? <div className={styles.galleryMeta}>
        <label className={styles.selectAll}>
          <input
            type="checkbox"
            checked={allFilteredSelected}
            aria-label="选择当前筛选商品"
            data-testid="batch-select-all"
            disabled={filteredItems.length === 0}
            onChange={(event) => onSelectAllFiltered(event.target.checked)}
          />
          <span>选择当前筛选商品</span>
        </label>
        <span aria-live="polite">
          {selectedCount > 0 ? `已选 ${selectedCount} 款` : loading && !itemsLoaded ? "读取中…" : `${filteredItems.length} 款可浏览`}
        </span>
      </div> : null}

      {selectedCount > 0 && !matrixOpen ? (
        <div data-testid="source-item-bulk-toolbar" className={styles.bulkBar}>
          <span>
            已选 <strong>{selectedCount}</strong> 条商品（跨页选择）{selectedCount > 100 ? "；单次最多处理 100 条" : ""}
          </span>
          <div className={styles.bulkActions}>
            <button type="button" className={styles.bulkBtn} disabled={bulkBusy || selectedCount > 100} onClick={() => onBulk("archive")}>
              <Archive size={13} aria-hidden="true" />
              批量归档
            </button>
            <button type="button" className={styles.bulkBtn} disabled={bulkBusy || selectedCount > 100} onClick={() => onBulk("restore")}>
              <RotateCcw size={13} aria-hidden="true" />
              批量恢复
            </button>
            <button type="button" className={styles.bulkBtn} data-tone="danger" disabled={bulkBusy || selectedCount > 100} onClick={() => onBulk("delete")}>
              <Trash2 size={13} aria-hidden="true" />
              批量删除
            </button>
            <button type="button" className={styles.bulkDismiss} onClick={() => { setSelectionNotice(""); onClearSelection(); }} aria-label="清除商品选择">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      {bulkNoticeNode}

      <div hidden={!matrixOpen}>{matrixNode}</div>
      {!matrixOpen ? (loading ? (
        <div className={styles.grid} aria-busy="true" aria-label="正在读取商品">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className={styles.skeletonCard}>
              <div className={styles.skeletonImage} />
              <div className={styles.skeletonBody}>
                <div className={styles.skeletonLine} data-w="30" />
                <div className={styles.skeletonLine} data-w="75" />
                <div className={styles.skeletonLine} data-w="55" />
                <div className={styles.skeletonLine} data-w="40" />
              </div>
            </div>
          ))}
        </div>
      ) : loadError && items.length === 0 ? (
        <div className={styles.empty} data-testid="gallery-load-error">
          <span className={styles.emptyIcon} aria-hidden="true">
            <LayoutGrid size={19} />
          </span>
          <p className={styles.emptyTitle}>商品列表读取失败</p>
          <p className={styles.emptyHint}>{loadError}</p>
          {onRetryLoad ? (
            <button type="button" className={styles.emptyAction} onClick={onRetryLoad}>重新读取</button>
          ) : null}
        </div>
      ) : filteredItems.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon} aria-hidden="true">
            <LayoutGrid size={19} />
          </span>
          <p className={styles.emptyTitle}>当前筛选条件下暂无商品</p>
          <p className={styles.emptyHint}>
            {items.length === 0 ? "该批次还没有可用于浏览的商品记录。" : "可以调整状态筛选或清空搜索词后再看。"}
          </p>
          {hasActiveFilter ? (
            <button
              type="button"
              className={styles.emptyAction}
              onClick={() => {
                notifyFilterChange();
                onSearchChange("");
                onStatusFilterChange("all");
              }}
            >
              清除筛选条件
            </button>
          ) : null}
        </div>
      ) : view === "table" ? (
        <ProductTable page={tablePage} onPageChange={onTablePageChange} items={filteredItems} marketplace={marketplace} selectedIds={selectedIds} expandedItemId={expandedItemId}
          busy={busy} onToggleSelect={onToggleSelect} onOpenDetail={onOpenDetail} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} />
      ) : (
        <div className={styles.grid} data-testid="batch-gallery-grid">
          {filteredItems.map((item) => (
            <ProductCard
              key={item.id}
              item={item}
              marketplace={marketplace}
              selected={selected.has(item.id)}
              detailOpen={expandedItemId === item.id}
              busy={busy}
              onToggleSelect={() => onToggleSelect(item.id)}
              onOpenDetail={() => onOpenDetail(item.id)}
              onArchive={() => onArchive(item)}
              onRestore={() => onRestore(item)}
              onDelete={() => onDelete(item)}
            />
          ))}
        </div>
      )) : null}
    </section>
  );
}
