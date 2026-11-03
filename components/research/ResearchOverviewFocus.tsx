"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CircleDashed,
  FileText,
  Gavel,
  ShieldAlert,
} from "lucide-react";

import { ProductImage } from "@/components/source-layer/ProductImage";
import styles from "./ResearchOverviewFocus.module.css";

/** 02 站点代码转中文标签；未知站点保持原样，不猜。 */
function marketplaceLabel(code: string | null): string {
  if (!code) return "站点未知";
  const upper = code.toUpperCase();
  if (upper === "US") return "美国站";
  if (upper === "UK" || upper === "GB") return "英国站";
  if (upper === "DE") return "德国站";
  if (upper === "JP") return "日本站";
  return `${upper} 站`;
}

function roleLabel(role: string | null | undefined): string | null {
  if (role === "benchmark") return "基准商品";
  if (role === "newcomer") return "新进入者";
  if (role === "pain_point") return "痛点样本";
  return null;
}

function money(price: number | null, currency: string | null): string | null {
  if (price === null || !Number.isFinite(price)) return null;
  const symbol = currency === "USD" || !currency ? "$" : currency === "CNY" || currency === "RMB" ? "¥" : `${currency} `;
  return `${symbol}${price.toFixed(2)}`;
}

/**
 * 去掉括号里的内部字段名（如 `（public_top_reviews_only）`）。
 * 只做展示清洗：不新增事实、不改写结论，删掉的是数据库字段名而不是信息。
 */
export function plainText(text: string): string {
  return text
    .replace(/[（(]\s*[A-Za-z0-9_.:\-]{4,}\s*[）)]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type ResearchOverviewCoverage = {
  facts: number;
  reviews: number | null;
  themes: number;
  /** 已评估时的风险摘要；未评估时传 null，界面如实显示“尚未评估”。 */
  risk: string | null;
};

/** 证据审查结论：总览只展示一条“最关键限制”，完整审查按需展开。 */
export type ResearchOverviewAudit = {
  label: string;
  headline: string | null;
  tone: "ok" | "warn" | "blocked" | "muted";
  /** 阻断 / 提醒条目数（可选）：用于把“最关键限制”压成一句人话。 */
  blocking?: number;
  warning?: number;
  onOpen?: () => void;
};

export type ResearchOverviewFocusProps = {
  title: string | null;
  asin: string;
  marketplace: string;
  imageUrl: string | null;
  brand: string | null;
  category: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  marketSource: {
    scanId: string | null;
    sampleKey: string | null;
    role: string | null;
    note: string | null;
    sampleHash: string | null;
  } | null;
  researchRevision: number | null;
  /** valid = 当前报告与研究版本一致；stale = 来源变化需重新确认；missing = 尚无正式研报；ambiguous = V1 与 V5 并存，权威未定。 */
  reportState: "valid" | "stale" | "missing" | "ambiguous";
  decision: { label: string | null; reason: string | null; stale: boolean } | null;
  question: string;
  finding: string | null;
  findingSource: string | null;
  /** 调用方可覆盖主发现区标题（如「报告权威未定」）；缺省为「核心发现」。 */
  findingLabel?: string;
  consumptionNotice?: string | null;
  unknown: string | null;
  unknownSource: string | null;
  /** 最关键限制：优先展示证据审查结论；审查通过时回退到最大未知。 */
  audit?: ResearchOverviewAudit | null;
  missing: string[];
  coverage: ResearchOverviewCoverage;
  primary: { label: string; onClick?: () => void; href?: string };
  /** 结论关联的原文证据块（由调用方按既有证据关联装配；无确认关联时显示如实空态）。 */
  conclusionEvidence?: ReactNode;
  /** 打开统一资料阅读器的指定资料（依据 / 审查 / 商品事实 / 档案）。 */
  onOpenMaterial?: (target: "archive" | "facts" | "report" | "audit" | "reviews" | "competitors") => void;
  onOpenDecision?: () => void;
  /**
   * 单页报告的第 3～7 段（买家反馈 / 竞品 / 改良与待验证 / 成本 / 风险），
   * 由调用方组装后插在「研究结论」与「下一步」之间；总览自身保持只读展示。
   */
  children?: ReactNode;
};

/**
 * 03 商品研究总览（单页报告）。
 *
 * 从上到下直接回答：商品概况 → 研究结论 → （调用方插入的买家反馈 / 竞品 / 改良 / 成本 / 风险）→ 下一步。
 * 报告权威状态（当前有效 / 需重新确认 / 暂停采信 / 权威未定 / 尚无研报）在结论区一句话说清；
 * 完整研报、原始评论与完整审查仍走统一资料阅读器，供深入核查，不是理解本页的必经入口。
 * 只消费调用方传入的只读投影：不取数、不写库、不触发模型、不改研究/决定状态。
 */
export function ResearchOverviewFocus({
  title,
  asin,
  marketplace,
  imageUrl,
  brand,
  category,
  price,
  currency,
  rating,
  reviewCount,
  marketSource,
  researchRevision,
  reportState,
  decision,
  question,
  finding,
  findingSource,
  findingLabel = "核心发现",
  consumptionNotice,
  unknown,
  unknownSource,
  audit,
  missing,
  coverage,
  primary,
  conclusionEvidence,
  onOpenMaterial,
  onOpenDecision,
  children,
}: ResearchOverviewFocusProps) {
  const role = roleLabel(marketSource?.role);
  const hasDecision = Boolean(decision?.label);
  const decisionStale = Boolean(decision?.stale && hasDecision);
  const reportLabel = consumptionNotice
    ? "报告暂停采信"
    : reportState === "valid"
      ? "报告有效"
      : reportState === "stale"
        ? "报告需重新确认"
        : reportState === "ambiguous"
          ? "报告权威未定"
          : "尚无正式研报";
  const auditLimited = Boolean(audit && audit.tone !== "ok");

  /** 事实行：只放能一眼读完的数字，不再做成一排双行标签。 */
  const facts = [
    money(price, currency) ? `${money(price, currency)} 售价` : null,
    rating !== null ? `${rating.toFixed(1)} 分` : null,
    reviewCount !== null ? `${reviewCount.toLocaleString("en-US")} 条评价` : null,
  ].filter((item): item is string => Boolean(item));

  const decisionText = hasDecision ? `${decisionStale ? "历史：" : ""}${decision?.label}` : "尚未决定";

  /**
   * 「发现可靠吗」只给一句主结论 + 一句补充。
   * 主结论优先说时效（旧结论还能不能信），其次说阻断，最后回退到最大未知。
   */
  const limitPrimary = consumptionNotice
    ? "研报结论暂不能采信"
    : reportState === "ambiguous"
      ? "V1 与 V5 两份研报并存，系统不会自动选择；确认权威之前，结论与决定都不能采信。"
      : reportState === "stale"
        ? "来源已变化，旧结论需重新确认"
        : audit?.tone === "blocked"
          ? "存在阻断，暂不能作为决策依据"
          : auditLimited
            ? audit?.label ?? "证据审查提出问题"
            : unknown
              ? plainText(unknown)
              : "尚未记录未知项";
  const auditNote = audit?.blocking
    ? `${audit.blocking} 处越级结论`
    : audit?.warning
      ? `${audit.warning} 处表述强于证据`
      : null;
  /** 只有在主结论不是审查结论时，审查条目数才作为补充出现，避免同一句话写两遍。 */
  const limitNote = [reportState === "stale" || consumptionNotice ? auditNote : null, coverage.reviews !== null ? `只读了 ${coverage.reviews} 条评论` : null]
    .filter(Boolean)
    .join(" · ");
  /** 样本口径单独一行：它解释“为什么只能信到这一步”，完整句子保留在证据审查里。 */
  const sampleCaveat = unknown && limitPrimary !== plainText(unknown) ? plainText(unknown) : null;

  return (
    <section className={styles.focus} data-testid="research-overview-focus" aria-label="商品研究总览">
      {/* ① 商品身份 + 研究状态 */}
      <header className={styles.identity}>
        <div className={styles.thumb}>
          <ProductImage
            src={imageUrl}
            alt={title ?? asin}
            className={styles.thumbImage}
            iconClassName="size-8"
            placeholderLabel="暂无商品图"
            testId="research-overview-product-image"
          />
          {role ? <span className={styles.roleTag}>{role}</span> : null}
        </div>

        <div className={styles.identityMain}>
          <h1 className={styles.title}>{title?.trim() || asin}</h1>
          <p className={styles.meta}>
            <span className={styles.asin}>{asin}</span>
            <span className={styles.dot}>·</span>
            <span>{marketplaceLabel(marketplace)}</span>
            {brand ? (<><span className={styles.dot}>·</span><span>{brand}</span></>) : null}
            {category ? (<><span className={styles.dot}>·</span><span>{category}</span></>) : null}
            {marketSource?.scanId ? (
              <Link className={styles.marketLink} href={`/market-analysis/${marketSource.scanId}`}>
                回看 02 市场 <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </p>

          <p className={styles.facts} aria-label="商品事实与研究状态">
            {facts.map((fact) => (
              <span key={fact} data-kind="fact">{fact}</span>
            ))}
            <span data-kind="state">{researchRevision !== null ? `rev.${researchRevision}` : "尚未生成研报版本"}</span>
            <span data-kind="state" data-tone={reportState === "valid" && !consumptionNotice ? "ok" : reportState === "missing" ? "muted" : "warn"}>
              {reportLabel}
            </span>
            <span data-kind="state" data-tone={decisionStale ? "warn" : hasDecision ? "ok" : "muted"}>
              人工决定：{decisionText}
            </span>
          </p>

          {onOpenMaterial ? (
            <button type="button" className={styles.factLink} onClick={() => onOpenMaterial("facts")} data-testid="overview-open-facts">
              查看商品事实与来源 <ArrowRight className="size-3" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className={styles.identityAside}>
          {primary.href ? (
            <Link className={styles.primary} href={primary.href} data-testid="research-overview-primary">
              {primary.label}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          ) : (
            <button type="button" className={styles.primary} onClick={primary.onClick} data-testid="research-overview-primary">
              {primary.label}
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {/* ② 研究结论：权威状态一句话 + 主发现 + 报告引用原文 + 最关键限制 */}
      <div className={styles.board}>
        <article className={styles.headlineCard} data-empty={finding || consumptionNotice ? "false" : "true"} data-testid="research-overview-finding">
          <header className={styles.cardHead}>
            <span className={styles.cardKicker}>研究结论</span>
            <span className={styles.stateChip} data-tone={consumptionNotice ? "blocked" : reportState === "valid" ? "ok" : reportState === "missing" ? "muted" : reportState === "ambiguous" ? "blocked" : "warn"}>
              {reportLabel}
            </span>
            {findingLabel && !consumptionNotice ? <span className={styles.findingTag}>{findingLabel}</span> : null}
          </header>
          <p className={styles.headlineText}>
            {consumptionNotice ?? finding ?? "尚无已保存的正式研报，本页不展示推测结论。"}
          </p>
          {findingSource && !consumptionNotice ? <p className={styles.cardSource}>{findingSource}</p> : null}
          {conclusionEvidence}
          <footer className={styles.headlineFoot}>
            {onOpenMaterial && reportState !== "ambiguous" ? (
              <button type="button" className={styles.ghostLink} onClick={() => onOpenMaterial("report")} data-testid="overview-open-evidence">
                查看依据与原文 <ArrowRight className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {consumptionNotice ? <span className={styles.noticeTag}><FileText className="size-3.5" aria-hidden="true" />原文保留在研报区</span> : null}
          </footer>
        </article>

        <aside className={styles.sideCard} data-tone={auditLimited ? audit?.tone ?? "warn" : reportState === "stale" ? "warn" : "muted"} data-testid="research-overview-limit">
          <header className={styles.cardHead}>
            <span className={styles.cardKicker}>
              {auditLimited || reportState === "stale" ? <ShieldAlert className="size-4" aria-hidden="true" /> : <CircleDashed className="size-4" aria-hidden="true" />}
              最关键限制
            </span>
            {auditLimited && audit?.label ? <span className={styles.cardSource}>{audit.label}</span> : null}
          </header>
          <p className={styles.sideText}>{limitPrimary}</p>
          {limitNote ? <p className={styles.sideNote}>{limitNote}</p> : null}
          {sampleCaveat ? <p className={styles.sideAside}>{sampleCaveat}</p> : null}
          {audit?.onOpen ? (
            <button type="button" className={styles.sideLink} onClick={audit.onOpen}>
              查看完整证据审查 <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </aside>
      </div>

      {/* ③～⑦ 买家反馈 / 竞品情况 / 改良与待验证 / 成本 / 风险：由详情页组装插入 */}
      {children}

      {decisionStale ? (
        <p className={styles.staleNote} role="status">
          <ShieldAlert className="size-4" aria-hidden="true" />
          来源或报告已更新：历史决定与旧研报仍保留，但不再作为当前有效结论；重新确认后才会恢复。
        </p>
      ) : null}

      {/* ⑧ 下一步：一句处境 + 唯一人工决策入口；完整资料与覆盖明细收在底部 */}
      <footer className={styles.nextSection} data-part="next">
        <div className={styles.nextCard} data-testid="research-overview-next">
          <div className={styles.nextMain}>
            <span className={styles.cardKicker}>下一步</span>
            <p className={styles.nextLead}>{question}</p>
          </div>
          {onOpenDecision && !/决定/.test(primary.label) ? (
            <button type="button" className={styles.nextBtn} onClick={onOpenDecision} data-testid="overview-open-decision">
              <Gavel className="size-4" aria-hidden="true" />
              {hasDecision ? "查看人工决定" : "去做人工决定"}
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className={styles.materialsRow} data-part="materials">
          {onOpenMaterial ? (
            <button type="button" className={styles.archiveLink} onClick={() => onOpenMaterial("archive")} data-testid="overview-open-archive">
              <span className={styles.archiveMain}>
                <strong>研究档案</strong>
                <em>原始评论 · VOC · 商品事实 · 研报</em>
              </span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          ) : null}

          <details className={styles.statusDetails} data-part="coverage">
            <summary>证据覆盖明细</summary>
            <div className={styles.coverage} aria-label="已收集的证据覆盖">
              <div><span>商品事实</span><strong>{coverage.facts}</strong><em>项已记录</em></div>
              <div><span>评论样本</span><strong>{coverage.reviews === null ? "—" : coverage.reviews.toLocaleString("en-US")}</strong><em>{coverage.reviews === null ? "未记录可读数" : "条可读"}</em></div>
              <div><span>VOC 主题</span><strong>{coverage.themes}</strong><em>{coverage.themes > 0 ? "个已归并" : "尚未归并"}</em></div>
              <div><span>风险核查</span><strong>{coverage.risk ?? "未评估"}</strong><em>{coverage.risk ? "" : "尚无可读摘要"}</em></div>
            </div>
            {missing.length > 0 ? (
              <p className={styles.coverageGap}>仍缺：{missing.slice(0, 6).join(" · ")}{missing.length > 6 ? ` 等 ${missing.length} 项` : ""}</p>
            ) : null}
          </details>
        </div>
      </footer>
    </section>
  );
}
