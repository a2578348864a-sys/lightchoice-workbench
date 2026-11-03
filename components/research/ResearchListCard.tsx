"use client";

import Link from "next/link";
import { Archive, ArrowRight, MoreHorizontal, Trash2 } from "lucide-react";

import { ProductImage } from "@/components/source-layer/ProductImage";
import { AnchoredMenu } from "./AnchoredMenu";
import { resolveMarketplaceLabel, resolveProductIdentityTitle } from "@/components/ui/ProductIdentity";
import {
  researchCardChoiceLabel,
  researchCardCtaOf,
  researchCardPriceLabel,
  researchCardStatusOf,
  researchFindingOf,
  type ResearchListRow,
} from "./researchListRow";
import styles from "./research-list.module.css";

type ResearchListCardProps = {
  row: ResearchListRow;
  selected: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onArchive: (row: ResearchListRow) => void;
  onDelete: (row: ResearchListRow) => void;
};

/**
 * 研究清单卡片：图在上、身份居中、动作收在底部一行。
 * 只展示「这是什么商品 / 现在什么状态 / 下一步做什么」，结论与证据留在详情页。
 */
export function ResearchListCard({ row, selected, busy, onSelect, onArchive, onDelete }: ResearchListCardProps) {
  const brand = row.brand ?? row.displayOnlyIdentity?.brand ?? null;
  const category = row.category ?? row.displayOnlyIdentity?.category ?? null;
  const image = row.image ?? row.displayOnlyIdentity?.imageUrl ?? null;
  const displayTitle = resolveProductIdentityTitle({ title: row.title, asin: row.asin, brand, category });
  const status = researchCardStatusOf(row);
  const cta = researchCardCtaOf(row);
  const price = researchCardPriceLabel(row);
  const finding = researchFindingOf(row);
  const archived = Boolean(row.archivedAt);
  const decisionLabel = researchCardChoiceLabel(row.myChoice);
  const hasDecision = decisionLabel !== "尚未保存人工决定";

  return (
    <article className={styles.card} data-stale={row.stale ? "true" : "false"} data-testid="research-card">
      <div className={styles.cover}>
        <ProductImage
          src={image}
          alt={displayTitle}
          className={styles.coverImg}
          iconClassName="size-8"
          placeholderLabel="暂无商品图"
          testId="research-card-image"
        />
        <label className={styles.pick} title={selected ? "取消选择该研究" : "选择该研究以批量处理"}>
          <input
            type="checkbox"
            aria-label={"选择研究 " + row.asin}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
          选择
        </label>
        <div className={styles.coverStatus}>
          <span className={styles.pill} data-tone={status.tone}>{status.label}</span>
          {row.stale ? <span className={styles.pill} data-tone="warn">需复核</span> : null}
        </div>
      </div>

      <div className={styles.body}>
        <h3 className={styles.title}>
          <Link href={cta.href}>{displayTitle}</Link>
        </h3>
        <p className={styles.ident}>
          {brand ? <span>{brand}</span> : null}
          {brand ? <span className={styles.dot}>·</span> : null}
          <span className={styles.asin}>{row.asin}</span>
          <span className={styles.dot}>·</span>
          <span>{resolveMarketplaceLabel(row.marketplace)}</span>
          {price ? <><span className={styles.dot}>·</span><span>{price}</span></> : null}
        </p>
        <div className={styles.finding} data-status={finding.status} data-testid="research-card-finding">
          <span className={styles.findingLabel}>{finding.label}</span>
          <p
            className={styles.findingText}
            data-placeholder={finding.text ? "false" : "true"}
            title={finding.text ?? finding.basis ?? undefined}
          >
            {finding.text ?? finding.basis ?? "—"}
          </p>
          <p className={styles.findingBasis}>{finding.text ? finding.basis ?? "" : "完整内容见商品详情"}</p>
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.decision}>
          {hasDecision ? <b>{decisionLabel}</b> : decisionLabel}
        </span>
        <div className={styles.actions}>
          <Link className={styles.cta} href={cta.href} data-tone={cta.muted ? "muted" : undefined} data-testid="research-card-cta">
            {cta.label}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <AnchoredMenu
            ariaLabel={"更多操作 " + row.asin}
            title="更多操作"
            triggerClassName={styles.moreTrigger}
            triggerContent={<MoreHorizontal className="size-4" aria-hidden="true" />}
            panelClassName={styles.menuPanel}
            testId="research-card-menu"
          >
            {(close) => (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    close();
                    onArchive(row);
                  }}
                >
                  <Archive className="size-3.5" aria-hidden="true" />
                  {archived ? "恢复到研究清单" : "归档（不影响研报）"}
                </button>
                <button
                  type="button"
                  data-danger
                  disabled={busy}
                  onClick={() => {
                    close();
                    onDelete(row);
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  删除研究任务
                </button>
              </>
            )}
          </AnchoredMenu>
        </div>
      </div>
    </article>
  );
}
