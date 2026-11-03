import "server-only";

import { resolveProductPresentationIdentity } from "@/lib/product/productPresentationIdentity";
import type { V3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import {
  AMAZON_DETAIL_FIELD_REGISTRY_VERSION,
  AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION,
  AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION,
  getAmazonDetailFieldRule,
} from "@/tools/collectors/amazon/detail-page-field-registry";

/**
 * 监控卡的商品身份投影（只读）。
 *
 * 原则：
 * - 只读既有 EvidenceStore 附件，不触发采集、不写任何事实库；
 * - 英文原标题照抄来源，不改写、不拼接；
 * - 图片只接受 https + Amazon 图片主机白名单，且必须来自同一份已校验附件（不跨 ASIN）；
 * - 中文名复用既有零付费展示层推导（`resolveProductPresentationIdentity`），
 *   推导结果只作辅助展示，绝不冒充 Amazon 确认事实，也绝不写回 EvidenceStore。
 */

/** 标题来源，便于前端如实说明「这个标题是从哪里来的」。 */
export type MonitoringProductTitleSource = "evidence_title" | "image_alt_text" | "database_snapshot";

export type MonitoringChineseTitleStatus = "AUTHORITATIVE_CHINESE_TITLE" | "DERIVED_FROM_CATEGORY" | "UNAVAILABLE";

export type MonitoringProductIdentity = {
  /** Amazon 英文原标题（来源事实，原样照抄）；无法确认时为 null。 */
  title: string | null;
  /** 标题来源；null 表示没有任何可用标题。 */
  titleSource: MonitoringProductTitleSource | null;
  /** 标题来源的中文说明（例如「标题字段本次未确认，取自商品主图 alt 文本」）。 */
  titleNote: string | null;
  /** 可信主图 URL（已过 https + Amazon 图片主机白名单）。 */
  image: string | null;
  /** 图片来源说明（例如「取自 Amazon 详情页主图证据」）。 */
  imageNote: string | null;
  brand: string | null;
  category: string | null;
  /** 中文商品展示名；仅 AUTHORITATIVE_CHINESE_TITLE 时代表来源页面里的中文名。 */
  chineseTitle: string | null;
  /** 中文类目（展示层辅助）。 */
  chineseCategory: string | null;
  chineseTitleStatus: MonitoringChineseTitleStatus;
  /** 中文名的性质说明（中文，给用户看）。 */
  chineseTitleNote: string | null;
};

type RegisteredField = {
  canonicalField?: string;
  priority?: string;
  fieldNature?: string;
  status?: string;
  reason?: string | null;
  value?: unknown;
  sourceTrace?: {
    ruleId?: string;
    registryVersion?: string;
    ruleVersion?: string | null;
    region?: string;
    selector?: string | null;
    label?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(value: unknown, maxLength = 600): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * 严格读取一个已登记字段：字段本身必须与 Amazon 详情页字段登记表一致
 * （规范名、优先级、事实性质、观测状态、来源规则、区域、规则版本全部对得上），
 * 否则视为不可用——不猜测、不降级为「看起来像」的字段。
 */
function readRegisteredField(
  fields: Record<string, RegisteredField>,
  name: string,
): { value: unknown; field: RegisteredField } | null {
  const field = fields[name];
  const rule = getAmazonDetailFieldRule(name);
  if (!field || !rule || rule.targetStorage === null || rule.priority === "BLOCKED") return null;
  if (!["DIRECT_FACT", "DERIVED_FACT", "CONDITIONAL_FACT"].includes(rule.fieldNature)) return null;
  if (field.canonicalField !== name) return null;
  if (field.priority !== rule.priority) return null;
  if (field.fieldNature !== rule.fieldNature) return null;
  if (field.status !== (rule.fieldNature === "DERIVED_FACT" ? "derived" : "observed")) return null;
  if (field.reason !== null && field.reason !== undefined) return null;
  const trace = field.sourceTrace;
  if (!isRecord(trace)) return null;
  if (trace.ruleId !== name) return null;
  if (trace.registryVersion !== AMAZON_DETAIL_FIELD_REGISTRY_VERSION) return null;
  if (trace.region !== rule.pageRegion) return null;
  const expectedRuleVersion = name === "primaryBsr" ? AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION
    : name === "subCategoryBsr" ? AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION
      : name === "fulfillment" ? "fulfillment.v1" : null;
  if (expectedRuleVersion !== null && trace.ruleVersion !== expectedRuleVersion) return null;
  if (expectedRuleVersion === null && trace.ruleVersion !== null && trace.ruleVersion !== undefined) return null;
  return { value: field.value, field };
}

/** 只接受 https + Amazon 图片主机；与 03 深研的既有白名单保持一致。 */
export function trustedAmazonImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const isAmazonImageHost = hostname === "media-amazon.com"
      || hostname.endsWith(".media-amazon.com")
      || hostname === "images-amazon.com"
      || hostname.endsWith(".images-amazon.com");
    return url.protocol === "https:" && isAmazonImageHost ? url.toString() : null;
  } catch {
    return null;
  }
}

function chineseTitleNote(status: MonitoringChineseTitleStatus): string | null {
  if (status === "AUTHORITATIVE_CHINESE_TITLE") return "中文名来自来源页面原文。";
  if (status === "DERIVED_FROM_CATEGORY") return "中文名为展示层推导（品牌 + 中文类目 + 关键规格），不是 Amazon 确认名。";
  return null;
}

/**
 * 从一份已校验的 Amazon 详情页证据里投影商品身份。
 * 任何字段缺失或不可信都返回 null，绝不用别的字段冒充。
 */
export function projectMonitoringProductIdentity(evidence: V3ModuleEvidence): MonitoringProductIdentity {
  const registeredFields = isRecord(evidence.data?.registeredFields)
    ? evidence.data.registeredFields as Record<string, RegisteredField>
    : {};

  const titleField = readRegisteredField(registeredFields, "title");
  const mainImageField = readRegisteredField(registeredFields, "mainImage");
  const brandField = readRegisteredField(registeredFields, "brand");
  const categoryPathField = readRegisteredField(registeredFields, "categoryPath");
  const primaryBsrField = readRegisteredField(registeredFields, "primaryBsr");

  let title: string | null = null;
  let titleSource: MonitoringProductTitleSource | null = null;
  let titleNote: string | null = null;

  const observedTitle = nonEmptyText(titleField?.value);
  if (observedTitle) {
    title = observedTitle;
    titleSource = "evidence_title";
  } else {
    // 标题字段不可用时（例如采集器判定多个标题候选冲突且拒绝裁决），
    // 只回退到同一份证据里商品主图的 alt 文本，并如实说明来源。
    const altText = nonEmptyText(mainImageField?.field?.sourceTrace?.label);
    if (altText) {
      title = altText;
      titleSource = "image_alt_text";
      titleNote = registeredFields.title?.status === "ambiguous"
        ? "本次页面存在多个标题候选、采集器未裁决；此处显示的是商品主图 alt 文本。"
        : "标题字段本次未确认；此处显示的是商品主图 alt 文本。";
    }
  }

  const image = mainImageField ? trustedAmazonImageUrl(mainImageField.value) : null;
  const brand = nonEmptyText(brandField?.value, 120);
  const categoryPath = Array.isArray(categoryPathField?.value)
    ? categoryPathField.value.map((item) => nonEmptyText(item, 120)).filter((item): item is string => Boolean(item))
    : [];
  const primaryBsrCategory = isRecord(primaryBsrField?.value)
    ? nonEmptyText(primaryBsrField.value.category, 120)
    : null;
  const category = categoryPath[0] ?? primaryBsrCategory;

  const chinese = resolveProductPresentationIdentity({
    title,
    brand,
    category,
    asin: evidence.identity?.asin ?? null,
  });

  return {
    title,
    titleSource,
    titleNote,
    image,
    imageNote: image ? "取自 Amazon 详情页主图证据。" : "暂无可信商品图。",
    brand,
    category,
    chineseTitle: chinese.chineseTitle,
    chineseCategory: chinese.chineseCategory,
    chineseTitleStatus: chinese.status,
    chineseTitleNote: chineseTitleNote(chinese.status),
  };
}

/** 证据之外的历史快照兜底：只保留英文标题，不推断中文名、不推断图片。 */
export function monitoringTitleFromDatabaseSnapshot(value: string | null | undefined): MonitoringProductIdentity {
  const title = nonEmptyText(value);
  return {
    title,
    titleSource: title ? "database_snapshot" : null,
    titleNote: title ? "取自既有批次快照，非本次采集证据。" : null,
    image: null,
    imageNote: "暂无可信商品图。",
    brand: null,
    category: null,
    chineseTitle: null,
    chineseCategory: null,
    chineseTitleStatus: "UNAVAILABLE",
    chineseTitleNote: null,
  };
}
