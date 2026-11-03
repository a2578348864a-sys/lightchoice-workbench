import "server-only";

/**
 * Product Source Layer V1.2 — 商品资产收件箱（Source Asset Inbox Projection）
 *
 * 第一性原理与对外展示规则：
 * 1. 纯只读投影：不写数据库、不改 Evidence、不触发外部请求；
 * 2. 真实来源派生：所有字段均来自已保存的 Evidence 版本文件；
 * 3. 诚实空态：缺失字段显示 null，绝不伪造 0 或 $0.00；
 * 4. 字段覆盖率客观统计：基于 8 项关键事实字段（ASIN、标题、图片、品牌、价格、评分、评论数、BSR），
 *    明确给出「6/8 关键字段」及具体缺失项，严禁编造虚假"质量评分"；
 * 5. 最新状态仲裁：状态以最新版本（latest）的实际校验裁决（verdict）为准，
 *    最新版本被阻断则严格显示为「已阻断」。
 */

import type { AccessContext } from "@/lib/server/accessPassword";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { adaptEvidenceToProductFact } from "@/lib/sourceLayer/fact/productFactAdapter";
import type { FactField, ProductFact } from "@/lib/sourceLayer/fact/types";
import { SOURCE_LAYER_ERROR_REGISTRY } from "@/lib/sourceLayer/errorCodes";

export const SOURCE_ASSET_INBOX_SCHEMA = "source-asset-inbox.v1" as const;

/** 8 项关键字段覆盖率的分母口径（唯一来源，UI 文案与测试都引用它）。 */
export const SOURCE_ASSET_COVERAGE_FIELDS = [
  "ASIN",
  "商品标题",
  "商品主图",
  "品牌",
  "价格",
  "评分",
  "评论数",
  "BSR 排名",
] as const;

/**
 * 字段是否「有可展示值」——统一判定规则。
 *
 * 规则：`FactField.status === "present"` 且值非空。
 * 为什么不用 `Boolean(field.value)`：`rating = 0`、`reviewCount = 0` 这类真实观测值
 * 会被 `Boolean` 误判为缺失；而 `status` 是事实层已经裁决过的权威结果。
 * 所有字段（含金额字段）都走这一条规则，不允许各字段自行判断。
 */
export function hasDisplayValue<T>(field: FactField<T>): boolean {
  return field.status === "present" && field.value !== null && field.value !== undefined;
}

/** 单条商品的 8 项关键字段覆盖率。 */
export function coverageOf(productFact: ProductFact): {
  presentCount: number;
  totalCount: number;
  coverageRatio: number;
  presentFields: string[];
  missingFields: string[];
} {
  const presence: Array<{ label: string; present: boolean }> = [
    { label: "ASIN", present: hasDisplayValue(productFact.basic.asin) },
    { label: "商品标题", present: hasDisplayValue(productFact.basic.title) },
    { label: "商品主图", present: hasDisplayValue(productFact.basic.image) },
    { label: "品牌", present: hasDisplayValue(productFact.basic.brand) },
    { label: "价格", present: hasDisplayValue(productFact.basic.price) },
    { label: "评分", present: hasDisplayValue(productFact.basic.rating) },
    { label: "评论数", present: hasDisplayValue(productFact.basic.reviewCount) },
    { label: "BSR 排名", present: hasDisplayValue(productFact.market.bsr) },
  ];
  const presentFields = presence.filter((entry) => entry.present).map((entry) => entry.label);
  const missingFields = presence.filter((entry) => !entry.present).map((entry) => entry.label);
  const totalCount = presence.length;
  return {
    presentCount: presentFields.length,
    totalCount,
    coverageRatio: totalCount === 0 ? 0 : Math.round((presentFields.length / totalCount) * 100) / 100,
    presentFields,
    missingFields,
  };
}

/**
 * 是否可进入研究。
 *
 * 两层来源，缺一不可：
 * - 事实层裁决：`latest.validation.readyForResearch`（Evidence 记录里的权威字段）；
 * - 契约约束：validator 保证 `readyForResearch ⇒ verdict === "passed"`
 *   （见 `lib/sourceLayer/validator.ts` 的 `readyForResearch: verdict === "passed"`，
 *   以及 `sourceAdapter.parseEvidenceRecord` 对 `readyForResearch && verdict !== "passed"` 的拒绝）。
 *
 * 这里不复制一份推断规则，只读事实层字段；再用 verdict 做一次契约内的一致性收口。
 */
export function isReadyForResearch(input: {
  verdict: "passed" | "needs_review" | "blocked";
  readyForResearch?: boolean | null;
}): boolean {
  return input.verdict === "passed" && input.readyForResearch === true;
}

export type SourceAssetStatus = "可研究" | "需复核" | "已阻断";

export type SourceAssetItem = {
  subjectKey: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  brand: string | null;
  category: string | null;
  price: { amount: number; currency: string } | null;
  rating: number | null;
  reviewCount: number | null;
  bsr: { rank: number; category: string | null } | null;
  estimatedMonthlySales: number | null;
  estimatedMonthlyRevenueUsd: number | null;
  latestVerdict: "passed" | "needs_review" | "blocked";
  statusLabel: SourceAssetStatus;
  readyForResearch: boolean;
  sources: string[];
  versionCount: number;
  latestCapturedAt: string;
  updatedAt: string;
  fieldCoverage: {
    presentCount: number;
    totalCount: number;
    coverageRatio: number;
    presentFields: string[];
    missingFields: string[];
  };
  issues: Array<{
    code: string;
    severity: string;
    field: string | null;
    hint: string;
  }>;
  riskFlags: string[];
};

export type SourceAssetInboxPayload = {
  schemaVersion: typeof SOURCE_ASSET_INBOX_SCHEMA;
  accessMode: "owner" | "visitor";
  operator: string;
  totalCount: number;
  passedCount: number;
  reviewCount: number;
  blockedCount: number;
  items: SourceAssetItem[];
};

function formatSourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case "sellersprite_xlsx":
    case "excel_upload":
      return "卖家精灵";
    case "sellersprite_plugin":
      return "卖家精灵插件";
    case "amazon_dom":
    case "browser_dom":
      return "Amazon DOM";
    case "manual":
    case "manual_entry":
      return "手工录入";
    case "sellersprite_api":
      return "卖家精灵 API";
    case "public_api":
      return "公开接口";
    default:
      return sourceType;
  }
}

function operatorOf(context: AccessContext): string {
  return context.mode === "owner" ? "owner:v1" : `visitor:${context.demoAccessId}`;
}

export async function getSourceAssetInbox(
  context: AccessContext,
): Promise<SourceAssetInboxPayload> {
  const operator = operatorOf(context);
  const store = createEvidenceStore(operator);
  const subjects = await store.listSubjects();

  const items: SourceAssetItem[] = [];

  for (const entry of subjects) {
    const record = await store.getSubject(entry.subjectKey);
    const versions = record?.versions ?? [];
    if (versions.length === 0) {
      // 索引存在但无实际版本文件时必须 fail-closed：索引 verdict 不能证明当前有可用证据。
      const verdict = entry.latestVerdict ?? "needs_review";
      const presentFields = [
        ...(entry.asin ? ["ASIN"] : []),
        ...(entry.displayTitle ? ["商品标题"] : []),
      ];
      const missingFields = SOURCE_ASSET_COVERAGE_FIELDS.filter(
        (label) => !presentFields.includes(label),
      );
      items.push({
        subjectKey: entry.subjectKey,
        asin: entry.asin ?? null,
        title: entry.displayTitle ?? null,
        imageUrl: null,
        brand: null,
        category: null,
        price: null,
        rating: null,
        reviewCount: null,
        bsr: null,
        estimatedMonthlySales: null,
        estimatedMonthlyRevenueUsd: null,
        latestVerdict: verdict,
        // 没有实际 Evidence Version 时，即使索引 verdict=passed 也只能进入复核。
        statusLabel: "需复核",
        readyForResearch: false,
        sources: [formatSourceTypeLabel(entry.sourceType)],
        versionCount: 0,
        latestCapturedAt: entry.latestCapturedAt || entry.updatedAt,
        updatedAt: entry.updatedAt,
        fieldCoverage: {
          presentCount: presentFields.length,
          totalCount: SOURCE_ASSET_COVERAGE_FIELDS.length,
          coverageRatio: Math.round(
            (presentFields.length / SOURCE_ASSET_COVERAGE_FIELDS.length) * 100,
          ) / 100,
          presentFields,
          missingFields: [...missingFields],
        },
        issues: [{
          code: "evidence_versions_unavailable",
          severity: "warning",
          field: null,
          hint: "来源证据版本不可用，需要重新接入或复核。",
        }],
        riskFlags: [],
      });
      continue;
    }

    const latest = versions[versions.length - 1];
    const fact = adaptEvidenceToProductFact({ evidence: latest });

    // 收集所有版本的去重来源
    const sourceTypes = Array.from(
      new Set(versions.map((v) => formatSourceTypeLabel(v.sourceType))),
    );

    // 8 个关键事实字段覆盖率：统一走 hasDisplayValue（status === "present"）
    const fieldCoverage = coverageOf(fact);

    // 状态判定：以最新版本的实际校验结果为准
    const latestVerdict = latest.validation.verdict;
    const readyForResearch = isReadyForResearch({
      verdict: latestVerdict,
      readyForResearch: latest.validation.readyForResearch,
    });
    const statusLabel: SourceAssetStatus = readyForResearch
      ? "可研究"
      : latestVerdict === "blocked"
        ? "已阻断"
        : "需复核";

    // 提取问题与提示
    const issues = (latest.validation.issueCodes ?? []).map((code) => {
      const reg = SOURCE_LAYER_ERROR_REGISTRY[code as keyof typeof SOURCE_LAYER_ERROR_REGISTRY];
      return {
        code,
        severity: reg?.severity ?? "warning",
        field: null,
        hint: reg?.message ?? `数据项存在异常（${code}）`,
      };
    });

    items.push({
      subjectKey: entry.subjectKey,
      asin: fact.basic.asin.value,
      title: fact.basic.title.value,
      imageUrl: fact.basic.image.value,
      brand: fact.basic.brand.value,
      category: fact.basic.category.value,
      price: fact.basic.price.value,
      rating: fact.basic.rating.value,
      reviewCount: fact.basic.reviewCount.value,
      bsr: fact.market.bsr.value !== null
        ? { rank: fact.market.bsr.value, category: fact.basic.category.value }
        : null,
      estimatedMonthlySales: fact.market.monthlySalesEstimate.value,
      estimatedMonthlyRevenueUsd: fact.market.monthlyRevenueEstimate.value?.amount ?? null,
      latestVerdict,
      statusLabel,
      readyForResearch,
      sources: sourceTypes,
      versionCount: versions.length,
      latestCapturedAt: latest.capturedAt,
      updatedAt: entry.updatedAt,
      fieldCoverage,
      issues,
      riskFlags: [...(latest.pkg.riskFlags ?? [])],
    });
  }

  // 排序：按更新时间倒序
  items.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));

  return {
    schemaVersion: SOURCE_ASSET_INBOX_SCHEMA,
    accessMode: context.mode === "owner" ? "owner" : "visitor",
    operator,
    totalCount: items.length,
    passedCount: items.filter((item) => item.readyForResearch).length,
    reviewCount: items.filter((item) => item.statusLabel === "需复核").length,
    blockedCount: items.filter((item) => item.statusLabel === "已阻断").length,
    items,
  };
}
