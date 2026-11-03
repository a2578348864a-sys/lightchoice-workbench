/**
 * T04 · 字段级来源的展示映射（presentation-only）。
 *
 * 纪律：
 * - 字段来源只展示服务端已记录的 field/evidenceId/evidenceVersion/contentHash/capturedAt；
 * - 缺失字段不补值、不推断；
 * - 当前证据接口按 subjectKey+module 读取最新模块，未提供按 evidenceVersion 读取历史内容的参数；
 *   因此字段来源元数据可以展示，但不得把最新模块内容冒充该字段的历史版本内容。
 */

export type FieldProvenanceEntry = {
  field: string;
  evidenceId: string;
  evidenceVersion: number;
  contentHash: string;
  capturedAt: string;
};

export const FIELD_LABELS: Record<string, string> = {
  asin: "ASIN",
  title: "商品标题",
  brand: "品牌",
  productUrl: "商品链接",
  marketplace: "站点",
  price: "价格",
  currency: "币种",
  rating: "评分",
  reviewCount: "评论数",
  bsr: "BSR 排名",
  bsrRanks: "BSR 排名",
  primaryBsr: "主类目 BSR",
  subCategoryBsr: "子类目 BSR",
  category: "类目",
  categoryPath: "类目路径",
  chineseCategory: "中文类目",
  dateFirstAvailable: "上架时间",
  launchedDate: "上架时间",
  bulletPoints: "卖点",
  mainImage: "主图",
  images: "图片",
  material: "材质",
  color: "颜色",
  size: "尺寸",
  style: "样式",
  pattern: "图案",
  manufacturer: "制造商",
  modelNumber: "型号",
  packageDimensions: "包装尺寸",
  packageWeight: "包装重量",
  itemDimensions: "商品尺寸",
  itemWeight: "商品重量",
  parentAsin: "父 ASIN",
  variationAsins: "变体 ASIN",
  customerReviews: "评论",
  topReviews: "公开评论摘要",
  estimatedMonthlySales: "月销估算",
  estimatedMonthlyRevenue: "月销估算收入",
  amazonSalesSignal: "Amazon 购买量提示",
  seller: "卖家",
  shipsFrom: "发货地",
  fulfillment: "配送方式",
  galleryImages: "附图",
  ratingDistribution: "评分分布",
  variations: "变体",
  listPrice: "标价",
  coupon: "优惠券",
  boughtPastMonth: "近月购买量",
  rawSpecifications: "规格原文",
  productDescription: "商品描述",
  aPlusPresence: "A+ 内容",
  fbaFee: "FBA 费用",
};

export const FIELD_STATUS_LABELS: Record<string, string> = {
  observed: "已取得",
  derived: "派生值",
  missing: "缺失",
  ambiguous: "待核对",
  invalid: "无效",
  blocked: "受阻",
};

export const FIELD_STATUS_TONES: Record<string, "ok" | "warn" | "fail" | "off" | "info"> = {
  observed: "ok",
  derived: "info",
  missing: "off",
  ambiguous: "warn",
  invalid: "fail",
  blocked: "fail",
};

export const FIELD_REASON_LABELS: Record<string, string> = {
  conflicting_candidates: "页面出现多个候选值，无法确认",
  price_expired: "价格已过期",
  not_found: "页面未找到该字段",
  selector_missing: "页面结构未匹配到该字段",
  page_identity_mismatch: "页面身份与目标商品不匹配",
  empty_value: "页面返回空值",
  invalid_value: "返回值格式无效",
  source_input_required: "需要来源输入或人工处理",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function fieldStatusLabel(status: string | null | undefined): string {
  if (!status) return "未知";
  return FIELD_STATUS_LABELS[status] ?? status;
}

export function fieldStatusTone(status: string | null | undefined): "ok" | "warn" | "fail" | "off" | "info" {
  if (!status) return "off";
  return FIELD_STATUS_TONES[status] ?? "off";
}

export function fieldReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return FIELD_REASON_LABELS[reason] ?? "需要核对（原始原因见高级信息）";
}

/** 字段值格式化：对象/数组/长文本保持可读；缺失值不补 0。 */
export function formatFieldValue(value: unknown, maxLength = 120): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "—";
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    const text = value
      .map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const record = entry as Record<string, unknown>;
          if (typeof record.rank === "number") {
            return `#${record.rank.toLocaleString("en-US")}${typeof record.category === "string" ? ` · ${record.category}` : ""}`;
          }
        }
        return typeof entry === "string" ? entry : JSON.stringify(entry);
      })
      .join("；");
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.amount === "number" && typeof record.currency === "string") {
      const fraction = record.currency === "JPY" || record.currency === "CNY" ? 0 : 2;
      return `${record.currency} ${record.amount.toLocaleString("en-US", {
        minimumFractionDigits: fraction,
        maximumFractionDigits: fraction,
      })}`;
    }
    if (typeof record.rank === "number") {
      return `#${record.rank.toLocaleString("en-US")}${typeof record.category === "string" ? ` · ${record.category}` : ""}`;
    }
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }
  return String(value);
}

export function formatProvenanceTime(value: string | null | undefined): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 字段来源与当前模块最新证据的关系说明。
 * 当前接口不能按 evidenceVersion 读取历史内容，所以只声明「已记录的来源元数据」，
 * 不把最新模块内容当作该字段的历史版本内容。
 */
export function describeFieldProvenanceRelation(entry: FieldProvenanceEntry): string {
  return `字段来源记录：版本 ${entry.evidenceVersion}，采集于 ${formatProvenanceTime(entry.capturedAt)}。`
    + "当前证据接口按商品 + 模块读取最新模块，未提供按版本读取历史内容的参数；"
    + "历史版本内容暂不可直接读取。此处只展示已记录的来源元数据，不把最新模块内容冒充该字段的历史版本内容。";
}
