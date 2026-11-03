"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, MoreHorizontal, PackageX, RotateCcw, Trash2 } from "lucide-react";
import styles from "./BatchWorkspace.module.css";
import { GalleryImage } from "./GalleryImage";
import {
  amazonProductUrl,
  formatMoneyValue,
  formatRatingDisplay,
  formatReviewCountDisplay,
  marketplaceCode,
  resolveGalleryGaps,
  resolveGalleryTitle,
  resolveUsagePresentation,
  type GalleryItem,
} from "./presentation";

export type ProductCardProps = {
  item: GalleryItem;
  marketplace: string | null;
  selected: boolean;
  detailOpen: boolean;
  busy: boolean;
  onToggleSelect: () => void;
  onOpenDetail: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

/**
 * 商品卡菜单：低频动作（来源 / 归档 / 恢复 / 删除）收进清晰的更多菜单。
 * 仅做展示接线，所有动作仍由原有 handler 执行（版本检查、幂等、依赖保护不变）。
 */
export function CardMenu({
  item,
  amazonUrl,
  busy,
  onArchive,
  onRestore,
  onDelete,
}: {
  item: GalleryItem;
  amazonUrl: string | null;
  busy: boolean;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"down" | "up">("down");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    function onPointer(event: MouseEvent | PointerEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className={styles.cardMenuWrap} ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.cardMenuBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`更多操作：${item.asin}`}
        data-testid="product-card-more"
        onClick={() => {
          if (!open) {
            const rect = buttonRef.current?.getBoundingClientRect();
            const spaceBelow = rect ? window.innerHeight - rect.bottom : Number.POSITIVE_INFINITY;
            setPlacement(spaceBelow < 220 ? "up" : "down");
          }
          setOpen((prev) => !prev);
        }}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className={styles.cardMenu} data-placement={placement} role="menu" aria-label={`${item.asin} 更多操作`}>
          {amazonUrl ? (
            <a
              className={styles.menuItem}
              role="menuitem"
              href={amazonUrl}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => setOpen(false)}
            >
              <ExternalLink size={13} aria-hidden="true" />
              在 Amazon 查看来源
            </a>
          ) : (
            <span className={styles.menuItem} role="menuitem" aria-disabled="true" title="该条目没有可用 ASIN，无法生成来源链接">
              <ExternalLink size={13} aria-hidden="true" />
              来源链接不可用
            </span>
          )}
          <div className={styles.menuSep} aria-hidden="true" />
          {item.archivedAt ? (
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              data-testid="product-card-restore"
              disabled={busy}
              onClick={() => run(onRestore)}
            >
              <RotateCcw size={13} aria-hidden="true" />
              恢复商品
            </button>
          ) : (
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              data-testid="product-card-archive"
              disabled={busy}
              onClick={() => run(onArchive)}
            >
              <PackageX size={13} aria-hidden="true" />
              归档商品
            </button>
          )}
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-tone="danger"
            data-testid="product-card-delete"
            disabled={busy}
            onClick={() => run(onDelete)}
          >
            <Trash2 size={13} aria-hidden="true" />
            删除商品
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ProductCard({
  item,
  marketplace,
  selected,
  detailOpen,
  busy,
  onToggleSelect,
  onOpenDetail,
  onArchive,
  onRestore,
  onDelete,
}: ProductCardProps) {
  const title = resolveGalleryTitle(item);
  const usage = resolveUsagePresentation(item);
  const gaps = resolveGalleryGaps(item);
  const price = formatMoneyValue(item.price?.value, item.price?.currency);
  const priceNote = item.price?.status === "estimated"
    ? "估算"
    : item.price?.status === "conflict"
      ? "待核对"
      : null;
  const rating = formatRatingDisplay(item.rating);
  const review = formatReviewCountDisplay(item.reviewCount);
  const market = marketplaceCode(item.marketplace ?? marketplace);
  const amazonUrl = amazonProductUrl(item.asin, item.marketplace ?? marketplace);
  const titleId = `gallery-title-${item.id}`;

  return (
    <article
      data-testid="batch-product-item"
      data-item-id={item.id}
      data-asin={item.asin}
      data-selected={selected ? "true" : undefined}
      data-archived={item.archivedAt ? "true" : undefined}
      aria-labelledby={titleId}
      className={`${styles.card}${selected ? ` ${styles.cardSelected}` : ""}${detailOpen ? ` ${styles.cardDetailOpen}` : ""}`}
    >
      <GalleryImage src={item.image} alt={title.primary} onOpenDetail={onOpenDetail} />

      <span className={styles.statusPill} data-tone={usage.tone}>{usage.label}</span>

      <label
        className={styles.checkbox}
        data-checked={selected ? "true" : "false"}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`选择商品 ${item.asin}`}
        />
        {selected ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : null}
      </label>

      <div className={styles.body}>
        <p className={styles.brand}>{item.brand?.trim() || "品牌未记录"}</p>

        <h3
          id={titleId}
          className={`${styles.cardTitle}${title.primaryIsChinese ? ` ${styles.secondaryZh}` : ""}`}
          title={title.primary}
        >
          {title.primary}
        </h3>

        {title.secondaryOriginal ? (
          <p className={styles.cardTitleOriginal} title={title.secondaryOriginal}>
            {title.secondaryOriginal}
          </p>
        ) : null}

        <p className={styles.category} title={title.categoryNote ?? undefined}>
          {title.categoryNote ? (
            <>
              <span className={styles.categoryLabel}>类目 · </span>
              {title.categoryNote}
            </>
          ) : (
            <span className={styles.categoryLabel}>类目未记录</span>
          )}
        </p>

        <div className={styles.priceRow}>
          <p className={styles.price}>
            {price ? (
              <>
                {price.text}
                {priceNote ? <span className={styles.priceNote}>{priceNote}</span> : null}
              </>
            ) : (
              <span className={styles.priceUnknown}>价格未知</span>
            )}
          </p>
          <p className={styles.rating}>
            {rating ? (
              <>
                {rating.pending ? null : <span className={styles.ratingStar} aria-hidden="true">★</span>}
                <span className={rating.pending ? styles.reviewPending : undefined}>{rating.text}</span>
              </>
            ) : (
              <span className={styles.ratingMuted}>暂无评分</span>
            )}
            {review.text ? (
              <>
                <span className={styles.ratingMuted} aria-hidden="true">·</span>
                <span className={review.pending ? styles.reviewPending : undefined}>{review.text}</span>
              </>
            ) : null}
          </p>
        </div>

        <div className={styles.gaps} aria-label="资料缺口">
          {gaps.map((gap) => (
            <span key={gap.key} className={styles.gap} data-tone={gap.tone}>{gap.label}</span>
          ))}
        </div>

        <div className={styles.foot}>
          <span className={styles.asin} title={`${item.asin} · ${market}`}>
            {item.asin} · {market}
            {amazonUrl ? (
              <a
                className={styles.asinLink}
                href={amazonUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="在 Amazon 查看来源"
                aria-label={`在 Amazon 查看 ${item.asin}`}
              >
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            ) : null}
          </span>
          <span className={styles.cardActions}>
            <button
              type="button"
              className={styles.detailBtn}
              aria-expanded={detailOpen}
              aria-controls={`gallery-detail-${item.id}`}
              data-testid="toggle-product-detail"
              onClick={onOpenDetail}
            >
              {detailOpen ? "收起" : "详情"}
            </button>
            <CardMenu
              item={item}
              amazonUrl={amazonUrl}
              busy={busy}
              onArchive={onArchive}
              onRestore={onRestore}
              onDelete={onDelete}
            />
          </span>
        </div>
      </div>
    </article>
  );
}
