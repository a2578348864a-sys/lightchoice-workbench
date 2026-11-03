import type { V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";

export type V3ModuleRegistryEntry = {
  id: V3ModuleId;
  label: string;
  evidenceKind: string;
  productionEntrypoints: readonly string[];
  preferredAcquisitionModes: readonly string[];
  downstream: "product_fact_and_evidence" | "evidence_only";
  minimumIdentity: readonly string[];
};

/**
 * SellerSprite 采集来源的唯一规范名。
 *
 * 采集端与写入校验必须复用该常量，禁止再手写 provider 字面量：
 * 历史事故中 payload 手写为 `SellerSphere`，Capture Gateway 照单接受，
 * 而消费侧 provider 硬校验导致证据被静默拒绝（附件进入通用引用却不进研究输入）。
 */
export const SELLERSPRITE_PROVIDER_NAME = "SellerSprite" as const;

/** 证据来源类型中属于 SellerSprite 的集合。 */
export const SELLERSPRITE_SOURCE_TYPES = ["sellersprite_plugin", "sellersprite_xlsx"] as const;

/**
 * 来源唯一为 SellerSprite 的模块。
 * `historical_trend` 可来自 SellerSprite 历史导出或用户自带 Keepa 导表，故不在此列，
 * 避免把其他合法 Provider 的调用一并拦下。
 */
export const SELLERSPRITE_ONLY_MODULE_IDS = [
  "sellersprite_product_market",
  "reverse_asin",
  "keyword_mining_trend",
] as const;

export type ProviderContractViolation = "SELLERSPRITE_PROVIDER_REQUIRED";

/** provider 归一化：仅用于契约比较，不改变落库原值。 */
export function normalizeProviderName(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * 判定该「模块 + 来源类型」组合是否落在 SellerSprite 专属 provider 契约范围内。
 * 来源类型或模块任一命中即纳入（覆盖 historical_trend 的 SellerSprite 来源面）。
 */
export function isSellerSpriteScoped(input: { module: string; sourceType: string }): boolean {
  return (SELLERSPRITE_SOURCE_TYPES as readonly string[]).includes(input.sourceType)
    || (SELLERSPRITE_ONLY_MODULE_IDS as readonly string[]).includes(input.module);
}

/**
 * provider 写入契约（fail-closed，必须在写入前调用）。
 *
 * 当**来源类型或模块任一声明为 SellerSprite** 时，provider 必须归一化等于规范名；
 * 缺失、空串或任何其他拼写一律判为违规，由调用方在写库前拒绝。
 * 非 SellerSprite 来源/模块返回 null，保持其他合法 Provider 的既有调用不变。
 */
export function sellerSpriteProviderContractViolation(input: {
  module: string;
  sourceType: string;
  provider: string | null | undefined;
}): ProviderContractViolation | null {
  if (!isSellerSpriteScoped(input)) return null;
  return normalizeProviderName(input.provider) === normalizeProviderName(SELLERSPRITE_PROVIDER_NAME)
    ? null
    : "SELLERSPRITE_PROVIDER_REQUIRED";
}

/**
 * 八大模块的唯一能力目录。它只描述入口和证据边界，不把未验证能力标成在线。
 * 真实 ONLINE 结论由 evaluateV3ModuleOnline 依据当前运行证据计算。
 */
export const V3_MODULE_REGISTRY: readonly V3ModuleRegistryEntry[] = Object.freeze([
  {
    id: "amazon_detail",
    label: "Amazon 商品详情",
    evidenceKind: "v3_amazon_detail_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/source-layer/collect/amazon-detail", "POST /api/source-layer/acquire/browser-visible"],
    preferredAcquisitionModes: ["DOM_DIRECT", "SCREENSHOT_EVIDENCE"],
    downstream: "product_fact_and_evidence",
    minimumIdentity: ["asin", "sourceUrl", "capturedAt"],
  },
  {
    id: "amazon_search_market",
    label: "Amazon 市场搜索 / Top N",
    evidenceKind: "v3_amazon_search_market_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/source-layer/collect/amazon-search", "POST /api/source-layer/acquire/browser-visible"],
    preferredAcquisitionModes: ["DOM_DIRECT", "EXTENSION_RENDERED", "VISIBLE_CHART"],
    downstream: "product_fact_and_evidence",
    minimumIdentity: ["asin", "query", "page", "capturedAt"],
  },
  {
    id: "sellersprite_product_market",
    label: "SellerSprite 商品 / 市场深度",
    evidenceKind: "v3_sellersprite_product_market_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/source-layer/acquire/browser-visible", "POST /api/source-layer/acquire/module"],
    preferredAcquisitionModes: ["DOM_DIRECT", "EXTENSION_RENDERED", "VISIBLE_CHART", "SCREENSHOT_EVIDENCE"],
    downstream: "evidence_only",
    minimumIdentity: ["asin", "sourceUrl", "capturedAt"],
  },
  {
    id: "reverse_asin",
    label: "SellerSprite 反查 ASIN",
    evidenceKind: "v3_reverse_asin_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/source-layer/acquire/browser-visible", "scripts/pilot/v3-browser-visible-evidence.ts"],
    preferredAcquisitionModes: ["DOM_DIRECT", "EXTENSION_RENDERED", "VISIBLE_CHART", "SCREENSHOT_EVIDENCE"],
    downstream: "evidence_only",
    minimumIdentity: ["asin", "sourceUrl", "capturedAt"],
  },
  {
    id: "keyword_mining_trend",
    label: "关键词挖掘 / 趋势",
    evidenceKind: "v3_keyword_mining_trend_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/source-layer/acquire/browser-visible", "POST /api/source-layer/acquire/module"],
    preferredAcquisitionModes: ["DOM_DIRECT", "EXTENSION_RENDERED", "VISIBLE_CHART", "SCREENSHOT_EVIDENCE"],
    downstream: "evidence_only",
    minimumIdentity: ["asin", "keyword", "sourceUrl", "capturedAt"],
  },
  {
    id: "variation",
    label: "父子变体 / Variation",
    evidenceKind: "v3_variation_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/source-layer/enrich/batch-variation", "POST /api/source-layer/acquire/browser-visible", "POST /api/source-layer/acquire/module"],
    preferredAcquisitionModes: ["DOM_DIRECT", "EXTENSION_RENDERED", "SCREENSHOT_EVIDENCE"],
    downstream: "evidence_only",
    minimumIdentity: ["parentAsin", "asin", "sourceUrl", "capturedAt"],
  },
  {
    id: "review_voc",
    label: "Review / VOC",
    evidenceKind: "v3_review_voc_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/tasks/[id]/review-evidence action=collect-confirm", "POST /api/source-layer/acquire/browser-visible"],
    preferredAcquisitionModes: ["DOM_DIRECT", "USER_ASSISTED_SESSION", "SCREENSHOT_EVIDENCE"],
    downstream: "evidence_only",
    minimumIdentity: ["asin", "sourceUrl", "capturedAt"],
  },
  {
    id: "historical_trend",
    label: "历史趋势 / 竞争结构",
    evidenceKind: "v3_historical_trend_v1",
    productionEntrypoints: ["POST /api/source-layer/orchestrate/module", "POST /api/source-layer/acquire/browser-visible", "POST /api/source-layer/acquire/module"],
    preferredAcquisitionModes: ["VISIBLE_CHART", "DOM_DIRECT", "EXTENSION_RENDERED", "SCREENSHOT_EVIDENCE"],
    downstream: "evidence_only",
    minimumIdentity: ["asin", "sourceUrl", "capturedAt"],
  },
]);

export type V3ModuleOnlineInput = {
  realProductionEntry: boolean;
  realDataValidated: boolean;
  evidencePersisted: boolean;
  provenanceComplete: boolean;
  downstreamReadable: boolean;
  limitationExplicit: boolean;
  testsPass: boolean;
  final3010Pass: boolean;
};

export type V3ModuleOnlineResult = V3ModuleOnlineInput & {
  online: boolean;
  blockers: string[];
};

export function evaluateV3ModuleOnline(input: V3ModuleOnlineInput): V3ModuleOnlineResult {
  const checks: Array<[keyof V3ModuleOnlineInput, string]> = [
    ["realProductionEntry", "REAL_PRODUCTION_ENTRY"],
    ["realDataValidated", "REAL_DATA_VALIDATED"],
    ["evidencePersisted", "EVIDENCE_PERSISTED"],
    ["provenanceComplete", "PROVENANCE_COMPLETE"],
    ["downstreamReadable", "DOWNSTREAM_READABLE"],
    ["limitationExplicit", "LIMITATION_EXPLICIT"],
    ["testsPass", "TESTS"],
    ["final3010Pass", "FINAL_3010"],
  ];
  const blockers = checks.filter(([key]) => input[key] !== true).map(([, label]) => label);
  return { ...input, online: blockers.length === 0, blockers };
}

export function getV3ModuleRegistryEntry(moduleId: V3ModuleId): V3ModuleRegistryEntry {
  const entry = V3_MODULE_REGISTRY.find((item) => item.id === moduleId);
  if (!entry) throw new Error("V3_MODULE_REGISTRY_ENTRY_MISSING");
  return entry;
}
