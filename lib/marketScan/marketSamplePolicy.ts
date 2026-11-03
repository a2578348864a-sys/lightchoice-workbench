import { PRODUCT_BATCH_EVIDENCE_STATUSES } from "@/lib/productBatchContract";
import { MIN_VALID_SAMPLE_COUNT } from "@/lib/marketScan/marketSampleConstants";

export { MIN_VALID_SAMPLE_COUNT };

/**
 * 市场样本政策唯一事实源（MARKET_SAMPLE_POLICY）。
 *
 * 本模块只定义「有效市场商品集合」的判定口径与阈值常量，供服务端投影与
 * MarketScan 创建共用，前端只消费服务端投影，不再自行实现有效性算法。
 *
 * 边界（刻意收窄）：
 * - 只读取已有确定性字段（evidenceStatus / archivedAt / marketplace / productKey /
 *   parentAsin / familyProjectionJson），不做任何推测或 AI 推断；
 * - 不引入第二事实源，不修改 EvidenceStore / ProductFact / Human Decision 权威；
 * - 判定结果只用于「能否以及如何进入市场研究样本」。
 */

/**
 * 建立正式市场研究所需的最小有效商品数（唯一常量）。
 * Source UI、MarketScan 创建、Market Gate、Representative 保存、Research handoff
 * 必须全部引用该常量，禁止再各自硬编码 30。
 */
export const MARKET_SAMPLE_POLICY_VERSION = "deterministic-market-products.v2" as const;

/** 允许进入 Valid Product Set 的 Source Lifecycle 证据状态（沿用既有正式业务状态定义）。 */
export const VALID_EVIDENCE_STATUSES = PRODUCT_BATCH_EVIDENCE_STATUSES.filter((status) => status !== "insufficient_evidence");

/** 明确排除：已否决 / 被阻断类状态。 */
export const EXCLUDED_EVIDENCE_STATUSES = ["blocked", "rejected", "quarantined", "invalid"] as const;

/**
 * 明确排除：待人工确认 / 未解决类状态。
 * `insufficient_evidence` 是 SellerSprite V1 合同中「证据不足，暂不参与排序」的正式状态，
 * 语义即「待补充/待确认」，因此归入待确认而不是有效集合。
 */
export const PENDING_REVIEW_EVIDENCE_STATUSES = ["needs_review", "pending", "unresolved", "insufficient_evidence"] as const;

export type ValidProductEvidenceStatus = (typeof VALID_EVIDENCE_STATUSES)[number];

export type MarketProductExclusionReason =
  | "ARCHIVED_ITEM"
  | "BLOCKED"
  | "NEEDS_REVIEW"
  | "INVALID_OR_REJECTED"
  | "MARKETPLACE_MISMATCH"
  | "UNKNOWN_EVIDENCE_STATUS"
  | "DUPLICATE_PARENT_VARIANT";

export const MARKET_PRODUCT_EXCLUSION_LABELS: Readonly<Record<MarketProductExclusionReason, string>> = {
  ARCHIVED_ITEM: "条目已归档",
  BLOCKED: "证据被阻断",
  NEEDS_REVIEW: "待人工确认",
  INVALID_OR_REJECTED: "已判无效或否决",
  MARKETPLACE_MISMATCH: "不属于当前站点范围",
  UNKNOWN_EVIDENCE_STATUS: "证据状态无法判定",
  DUPLICATE_PARENT_VARIANT: "重复父子变体",
};

/** 参与判定的最小条目形状（由调用方从已持久化字段投影而来）。 */
export type MarketProductCandidate = {
  readonly id: string;
  readonly productKey: string;
  readonly ordinal: number;
  readonly asin: string | null;
  readonly parentAsin: string | null;
  readonly familyProjectionJson: string;
  readonly evidenceStatus: string;
  readonly archivedAt: Date | null;
  /** Evidence/Fact resolver result; lifecycle status alone never establishes identity. */
  readonly deterministicValid?: boolean;
};

export type MarketProductExclusion = {
  readonly itemId: string;
  readonly reason: MarketProductExclusionReason;
};

export type ValidMarketProductSet = {
  /** 批次原始记录数（对账口径，含未落明细的差额）。 */
  readonly rawCount: number;
  /** 最终可进入市场研究样本的有效商品数（已按确定性父子变体折叠）。 */
  readonly validCount: number;
  /** 待人工确认 / 未解决，不计入有效集合。 */
  readonly pendingReviewCount: number;
  /** 被排除条目数（含变体折叠）。 */
  readonly excludedCount: number;
  /** 有效商品条目 ID（已折叠变体，顺序稳定）。 */
  readonly validItemIds: readonly string[];
  /** 逐条排除原因，便于 UI 与验收解释差异。 */
  readonly excludedReasons: readonly MarketProductExclusion[];
  /** 创建正式市场研究的最低样本门槛。 */
  readonly minimumRequired: number;
  /** 父子变体折叠是否真正生效。 */
  readonly parentVariationDedup: ParentVariationSummary;
};

export type ParentVariationSummary = {
  readonly status: "APPLIED" | "NOT_AVAILABLE";
  readonly basis: "parentAsin" | "familyIdentity" | "not_available";
  readonly groupsCollapsed: number;
  readonly sourceItemCount: number;
  readonly retainedItemCount: number;
  readonly notice: string;
};

function normalizeMarketplace(value: string | null | undefined): string | null {
  const next = typeof value === "string" ? value.trim().toUpperCase() : "";
  return next || null;
}

function normalizeKey(value: string | null | undefined): string | null {
  const next = typeof value === "string" ? value.trim().toUpperCase() : "";
  return next || null;
}

/** 确定性 family identity 读取，与 parentVariation.ts 同源语义（只读，不推断）。 */
function stableFamilyIdentity(familyProjectionJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(familyProjectionJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const family = root.family;
    if (family && typeof family === "object" && !Array.isArray(family)) {
      const identity = (family as Record<string, unknown>).familyIdentity;
      if (typeof identity === "string" && identity.trim()) return identity.trim();
    }
    const direct = root.familyIdentity;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  } catch {
    return null;
  }
  return null;
}

type EligibilityVerdict =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: MarketProductExclusionReason };

/**
 * 单条目资格判定：归档 / 阻断 / 待确认 / 无效 / 站点不符 / 状态未知 一律排除。
 */
export function classifyMarketProductEligibility(input: {
  readonly item: Pick<MarketProductCandidate, "evidenceStatus" | "archivedAt" | "productKey" | "asin">;
  readonly batchMarketplace?: string | null;
}): EligibilityVerdict {
  if (input.item.archivedAt !== null) return { eligible: false, reason: "ARCHIVED_ITEM" };

  const status = typeof input.item.evidenceStatus === "string" ? input.item.evidenceStatus.trim() : "";
  if ((EXCLUDED_EVIDENCE_STATUSES as readonly string[]).includes(status)) {
    return { eligible: false, reason: status === "blocked" ? "BLOCKED" : "INVALID_OR_REJECTED" };
  }
  if ((PENDING_REVIEW_EVIDENCE_STATUSES as readonly string[]).includes(status)) {
    return { eligible: false, reason: "NEEDS_REVIEW" };
  }
  if (!(VALID_EVIDENCE_STATUSES as readonly string[]).includes(status)) {
    return { eligible: false, reason: "UNKNOWN_EVIDENCE_STATUS" };
  }

  const asin = input.item.asin?.trim().toUpperCase() ?? "";
  const binding = /^(?:amazon:([A-Z]{2,8}):|asin:)([A-Z0-9]{10})$/iu.exec(input.item.productKey.trim());
  if (!/^[A-Z0-9]{10}$/u.test(asin) || !binding || binding[2]?.toUpperCase() !== asin) {
    return { eligible: false, reason: "INVALID_OR_REJECTED" };
  }
  const batchMarketplace = normalizeMarketplace(input.batchMarketplace);
  if (!batchMarketplace) return { eligible: false, reason: "MARKETPLACE_MISMATCH" };
  if (batchMarketplace) {
    const subject = /^amazon:([A-Z]{2,8}):[A-Z0-9]{10}$/iu.exec(input.item.productKey.trim());
    const subjectMarketplace = subject ? subject[1]!.toUpperCase() : null;
    if (subjectMarketplace && subjectMarketplace !== batchMarketplace) {
      return { eligible: false, reason: "MARKETPLACE_MISMATCH" };
    }
  }

  return { eligible: true };
}

/** 只按可靠 parentAsin / familyIdentity 折叠重复变体；无可靠字段时不折叠、不猜测。 */
export function dedupeMarketProductVariants(
  items: readonly MarketProductCandidate[],
): { readonly retained: readonly MarketProductCandidate[]; readonly collapsedIds: readonly string[]; readonly summary: ParentVariationSummary } {
  const sorted = [...items].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const identities = new Set<string>();
  const duplicateIds: string[] = [];
  const ordered = sorted.filter((item) => {
    const identity = normalizeKey(item.asin) ?? item.productKey;
    if (identities.has(identity)) { duplicateIds.push(item.id); return false; }
    identities.add(identity); return true;
  });
  const hasParent = ordered.some((item) => normalizeKey(item.parentAsin) !== null);
  const withFamily = ordered.map((item) => ({ item, family: stableFamilyIdentity(item.familyProjectionJson) }));
  const hasFamily = withFamily.some((entry) => entry.family !== null);
  const basis: ParentVariationSummary["basis"] = hasParent ? "parentAsin" : hasFamily ? "familyIdentity" : "not_available";

  if (basis === "not_available") {
    return {
      retained: ordered,
      collapsedIds: duplicateIds,
      summary: {
        status: "NOT_AVAILABLE",
        basis,
        groupsCollapsed: 0,
        sourceItemCount: ordered.length,
        retainedItemCount: ordered.length,
        notice: "父子变体合并未执行：当前来源没有可靠的父 ASIN 或同族标识，无法识别变体关系。",
      },
    };
  }

  const seen = new Set<string>();
  const retained: MarketProductCandidate[] = [];
  const collapsedIds: string[] = [...duplicateIds];
  for (const entry of withFamily) {
    const key = basis === "parentAsin"
      ? `asin:${normalizeKey(entry.item.parentAsin) ?? normalizeKey(entry.item.asin) ?? entry.item.productKey}`
      : entry.family ?? `asin:${normalizeKey(entry.item.asin) ?? entry.item.productKey}`;
    if (seen.has(key)) {
      collapsedIds.push(entry.item.id);
      continue;
    }
    seen.add(key);
    retained.push(entry.item);
  }

  return {
    retained,
    collapsedIds,
    summary: {
      status: "APPLIED",
      basis,
      groupsCollapsed: collapsedIds.length,
      sourceItemCount: ordered.length,
      retainedItemCount: retained.length,
      notice: collapsedIds.length > 0
        ? `已按可靠 ${basis === "parentAsin" ? "parentAsin" : "familyIdentity"} 确定性保留 ${retained.length} 个代表样本，折叠 ${collapsedIds.length} 个变体。`
        : `已检查可靠 ${basis === "parentAsin" ? "parentAsin" : "familyIdentity"}，未发现需要折叠的重复变体。`,
    },
  };
}

/**
 * VALID_PRODUCT_SET 唯一权威 resolver。
 *
 * 前后端必须共用本函数结果：UI 只展示，服务端只按 validItemIds 建单。
 */
export function resolveValidMarketProductSet(input: {
  readonly items: readonly MarketProductCandidate[];
  readonly batchMarketplace?: string | null;
  /** 批次原始记录数；缺省时退化为条目数。用于暴露「库存 vs 明细」差异。 */
  readonly declaredItemCount?: number | null;
  readonly minimumRequired?: number;
}): ValidMarketProductSet {
  const minimumRequired = input.minimumRequired ?? MIN_VALID_SAMPLE_COUNT;
  const excludedReasons: MarketProductExclusion[] = [];
  const eligible: MarketProductCandidate[] = [];
  let pendingReviewCount = 0;

  for (const item of input.items) {
    const verdict = item.deterministicValid === false
      ? { eligible: false as const, reason: "INVALID_OR_REJECTED" as const }
      : classifyMarketProductEligibility({ item, batchMarketplace: input.batchMarketplace });
    if (verdict.eligible) {
      eligible.push(item);
      continue;
    }
    excludedReasons.push({ itemId: item.id, reason: verdict.reason });
    if (verdict.reason === "NEEDS_REVIEW") pendingReviewCount += 1;
  }

  const dedupe = dedupeMarketProductVariants(eligible);
  for (const itemId of dedupe.collapsedIds) {
    excludedReasons.push({ itemId, reason: "DUPLICATE_PARENT_VARIANT" });
  }

  const validItemIds = dedupe.retained.map((item) => item.id);
  const declaredItemCount = typeof input.declaredItemCount === "number" && Number.isFinite(input.declaredItemCount)
    ? Math.max(0, Math.trunc(input.declaredItemCount))
    : 0;

  return {
    rawCount: Math.max(declaredItemCount, input.items.length),
    validCount: validItemIds.length,
    pendingReviewCount,
    excludedCount: excludedReasons.length,
    validItemIds,
    excludedReasons,
    minimumRequired,
    parentVariationDedup: dedupe.summary,
  };
}

/** UI 与验收统一使用：有效样本是否达到门槛。 */
export function isMarketSampleSufficient(validCount: number, minimumRequired: number = MIN_VALID_SAMPLE_COUNT): boolean {
  return validCount >= minimumRequired;
}
