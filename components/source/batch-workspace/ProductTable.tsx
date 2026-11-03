"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/DataTable";
import { CardMenu } from "./ProductCard";
import { GalleryImage } from "./GalleryImage";
import { amazonProductUrl, formatMoneyValue, formatRatingDisplay, formatReviewCountDisplay, resolveGalleryGaps, resolveGalleryTitle, resolveUsagePresentation, type GalleryItem } from "./presentation";
import styles from "./ProductTable.module.css";

type Props = {
  items: GalleryItem[];
  page?: number; onPageChange?: (page: number) => void;
  marketplace: string | null;
  selectedIds: string[];
  expandedItemId: string | null;
  busy: boolean;
  onToggleSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  onArchive: (item: GalleryItem) => void;
  onRestore: (item: GalleryItem) => void;
  onDelete: (item: GalleryItem) => void;
};

/** Reuses the existing TanStack v8 table and existing card menu. No query/cache or business writes here. */
const TableActions = createContext<Props | null>(null);
function useTableActions() {
  const value = useContext(TableActions);
  if (!value) throw new Error("ProductTable actions context is missing");
  return value;
}
// Stable column/cell component identities preserve cached image state and keyboard focus on selection.
const columns: ColumnDef<GalleryItem, unknown>[] = [
    {
      id: "select", enableSorting: false,
      header: function PageSelectionHeader({ table }) {
        const { selectedIds, onToggleSelect, page: savedPage = 0, onPageChange } = useTableActions();
        const restored = useRef(false), lastRequested = useRef(savedPage);
        const pageIndex = table.getState().pagination.pageIndex;
        useEffect(() => {
          const safePage = Math.min(savedPage, Math.max(0, table.getPageCount() - 1));
          if (!restored.current || lastRequested.current !== savedPage) {
            restored.current = true; lastRequested.current = savedPage;
            if (pageIndex !== safePage) { table.setPageIndex(safePage); return; }
          }
          if (pageIndex !== savedPage) onPageChange?.(pageIndex);
        }, [savedPage, pageIndex, onPageChange, table]);
        const selected = new Set(selectedIds);
        const page = table.getRowModel().rows.map(row => row.original);
        const count = page.filter(item => selected.has(item.id)).length;
        return <span className={styles.check} onClick={event => event.stopPropagation()}>
          <input type="checkbox" aria-label="全选当前页商品" data-testid="table-select-page" title="全选当前页商品，保留其他页的选择"
            checked={page.length > 0 && count === page.length}
            ref={element => { if (element) element.indeterminate = count > 0 && count < page.length; }}
            onChange={event => { for (const item of page) if (selected.has(item.id) !== event.target.checked) onToggleSelect(item.id); }} />
        </span>;
      },
      cell: function SelectionCell({ row }) {
        const { selectedIds, onToggleSelect } = useTableActions();
        return <span className={styles.check} onClick={event => event.stopPropagation()}>
        <input type="checkbox" aria-label={`选择商品 ${row.original.asin}`} checked={selectedIds.includes(row.original.id)}
          onChange={() => onToggleSelect(row.original.id)} />
      </span>;
      },
    },
    {
      id: "product", header: "商品", enableSorting: false,
      cell: function ProductIdentityCell({ row }) {
        const { expandedItemId, onOpenDetail } = useTableActions();
        const item = row.original, title = resolveGalleryTitle(item);
        return <div className={styles.identity} data-testid="batch-product-item" data-item-id={item.id}
          data-asin={item.asin} data-reviewing={expandedItemId === item.id}>
          <div className={styles.thumbnail} onClick={event => event.stopPropagation()}>
            <GalleryImage src={item.image} alt={title.primary} onOpenDetail={() => onOpenDetail(item.id)} />
          </div>
          <div className={styles.productText}>
            <button type="button" className={styles.name} title={title.secondaryOriginal ? `${title.primary}\n${title.secondaryOriginal}` : title.primary}
              data-testid="toggle-product-detail" aria-expanded={expandedItemId === item.id}
              aria-controls={`gallery-detail-${item.id}`} onClick={event => { event.stopPropagation(); onOpenDetail(item.id); }}>{title.primary}</button>
            <p className={styles.meta}><span className={styles.asin}>{item.asin}</span><span className={styles.brand}>{item.brand?.trim() || "品牌未记录"}</span></p>
          </div>
        </div>;
      },
    },
    {
      id: "price", header: "价格", enableSorting: false,
      cell: ({ row }) => {
        const price = formatMoneyValue(row.original.price?.value, row.original.price?.currency);
        return <div className={styles.numeric} data-testid="table-price"><strong>{price?.text ?? "价格未知"}</strong>
          {row.original.price?.status === "conflict" ? <span className={styles.warning}>待核对</span> : row.original.price?.status === "estimated" ? <span className={styles.muted}>估算</span> : null}</div>;
      },
    },
    {
      id: "rating", header: "评分 / 评价", enableSorting: false,
      cell: ({ row }) => {
        const rating = formatRatingDisplay(row.original.rating), reviews = formatReviewCountDisplay(row.original.reviewCount);
        return <div className={styles.numeric} data-testid="table-rating"><strong className={rating?.pending ? styles.warning : undefined}>{rating?.text ?? "暂无评分"}</strong><span className={reviews.pending ? styles.warning : styles.muted}>{reviews.text || "暂无评价数"}</span></div>;
      },
    },
    {
      id: "materials", header: "资料状态", enableSorting: false,
      cell: ({ row }) => {
        const usage = resolveUsagePresentation(row.original), gaps = resolveGalleryGaps(row.original);
        return <div className={styles.materials} data-testid="table-materials"><span className={styles.status} data-tone={usage.tone}>{usage.label}</span>
          <span className={styles.materialNote} title={gaps.map(g => g.label).join(" · ")}>{gaps.map(g => g.label).join(" · ") || "查看资料记录"}</span></div>;
      },
    },
    {
      id: "actions", header: "操作", enableSorting: false,
      cell: function ProductActionsCell({ row }) {
        const { marketplace, busy, onArchive, onRestore, onDelete } = useTableActions();
        return <div className={styles.actions} onClick={event => event.stopPropagation()}>
        <CardMenu item={row.original} amazonUrl={amazonProductUrl(row.original.asin, row.original.marketplace ?? marketplace)} busy={busy}
          onArchive={() => onArchive(row.original)} onRestore={() => onRestore(row.original)} onDelete={() => onDelete(row.original)} />
      </div>;
      },
    },
  ];

export function ProductTable(props: Props) {
  const { items, onOpenDetail } = props;
  return <TableActions.Provider value={props}><div className={styles.root} data-testid="batch-product-table">
    <DataTable columns={columns} data={items} getRowId={item => item.id} onRowClick={item => onOpenDetail(item.id)} pageSize={20} />
  </div></TableActions.Provider>;
}
