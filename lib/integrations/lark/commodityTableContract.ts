import type { ProductFact, FactField, ProductItemDimensions, ProductPackageDimensions, ProductPackageWeight } from "@/lib/sourceLayer/fact/types";
import type { BitableFieldDefinition } from "./tableContract";
import type { LarkFieldMeta, LarkIncompatibleField } from "./types";

/**
 * Phase B 商品池的唯一字段权威。
 *
 * 这里的字段名就是飞书真实表头；同步服务不得再维护第二份隐式字段清单。
 * `expectedTypes` 使用飞书 Bitable 类型：1 文本、2 数字、3 单选、5 日期、
 * 15 超链接。决策字段提前纳入同一张商品池，但批量事实更新时不会覆盖它们。
 */
export const COMMODITY_POOL_TABLE_FIELDS: readonly BitableFieldDefinition[] = [
  // 业务主键与展示
  { name: "subjectKey", description: "跨站点商品业务主键，例如 amazon:US:B0XXXXXXXX", expectedTypes: [1], requiredForSync: true },
  { name: "marketplace", description: "站点，例如 US", expectedTypes: [1], requiredForSync: true },
  { name: "ASIN", description: "Amazon ASIN", expectedTypes: [1], requiredForSync: true },
  { name: "商品主图", description: "商品主图 URL", expectedTypes: [1, 15], requiredForSync: false },
  { name: "商品标题", description: "商品标题", expectedTypes: [1], requiredForSync: true },
  { name: "品牌", description: "品牌快照", expectedTypes: [1], requiredForSync: false },
  { name: "类目", description: "商品类目快照", expectedTypes: [1], requiredForSync: false },
  { name: "商品链接", description: "来源商品链接", expectedTypes: [1, 15], requiredForSync: false },

  // 价格与第三方估算：字段名显式保留「预估」语义
  { name: "当前售价", description: "来源快照价格", expectedTypes: [2], requiredForSync: false },
  { name: "售价币种", description: "价格币种", expectedTypes: [1, 3], requiredForSync: false },
  { name: "预估月销量", description: "SellerSprite provider estimate", expectedTypes: [2], requiredForSync: false },
  { name: "预估月销售额", description: "SellerSprite provider estimate", expectedTypes: [2], requiredForSync: false },
  { name: "预估FBA费", description: "SellerSprite provider estimate", expectedTypes: [2], requiredForSync: false },
  { name: "预估毛利率", description: "SellerSprite provider estimate，百分比点", expectedTypes: [2], requiredForSync: false },
  { name: "LQS评分", description: "SellerSprite provider estimate", expectedTypes: [2], requiredForSync: false },

  // 来源快照
  { name: "大类BSR", description: "来源快照大类排名", expectedTypes: [2], requiredForSync: false },
  { name: "小类BSR", description: "来源快照小类排名", expectedTypes: [2], requiredForSync: false },
  { name: "评分", description: "来源快照评分", expectedTypes: [2], requiredForSync: false },
  { name: "评论数", description: "来源快照评论数", expectedTypes: [2], requiredForSync: false },
  { name: "上架时间", description: "来源快照上架时间", expectedTypes: [1, 5], requiredForSync: false },
  { name: "包装尺寸", description: "来源快照包装尺寸，保留原单位", expectedTypes: [1], requiredForSync: false },
  { name: "包装重量", description: "来源快照包装重量，保留原单位", expectedTypes: [1], requiredForSync: false },
  { name: "商品尺寸", description: "来源快照商品尺寸，保留原单位", expectedTypes: [1], requiredForSync: false },
  { name: "商品重量", description: "来源快照商品重量，保留原单位", expectedTypes: [1], requiredForSync: false },

  // 溯源与工作台状态
  { name: "数据来源", description: "来源权威，例如 sellersprite_xlsx，不升级为 Amazon confirmed", expectedTypes: [1], requiredForSync: true },
  { name: "采集时间", description: "Evidence 捕获时间", expectedTypes: [1, 5], requiredForSync: true },
  { name: "数据质量状态", description: "来源验证质量状态", expectedTypes: [1, 3], requiredForSync: true },
  { name: "工作台链接", description: "返回轻选工作台的链接", expectedTypes: [1, 15], requiredForSync: false },

  // Research / Human Confirm：属于同一商品行，但由后续阶段局部更新
  { name: "研究状态", description: "未研究 / 研究中 / 已完成", expectedTypes: [1, 3], requiredForSync: true },
  { name: "人工决策", description: "未决策 / 可做 / 不做 / 待观察", expectedTypes: [1, 3], requiredForSync: true },
  { name: "决策理由", description: "人工确认的真实理由", expectedTypes: [1], requiredForSync: false },
  { name: "下一步动作", description: "人工确认后的下一步动作", expectedTypes: [1, 3], requiredForSync: false },
  { name: "决策时间", description: "人工决策保存时间", expectedTypes: [1, 5], requiredForSync: false },
  { name: "Report Hash", description: "当前不可变研报指纹", expectedTypes: [1], requiredForSync: false },
  { name: "最近同步时间", description: "最近一次轻选写入时间", expectedTypes: [1, 5], requiredForSync: false },
] as const;

export const COMMODITY_POOL_FACT_FIELDS = [
  "subjectKey",
  "marketplace",
  "ASIN",
  "商品主图",
  "商品标题",
  "品牌",
  "类目",
  "商品链接",
  "当前售价",
  "售价币种",
  "预估月销量",
  "预估月销售额",
  "预估FBA费",
  "预估毛利率",
  "LQS评分",
  "大类BSR",
  "小类BSR",
  "评分",
  "评论数",
  "上架时间",
  "包装尺寸",
  "包装重量",
  "商品尺寸",
  "商品重量",
  "数据来源",
  "采集时间",
  "数据质量状态",
  "工作台链接",
] as const;

export const COMMODITY_POOL_DECISION_FIELDS = [
  "研究状态",
  "人工决策",
  "决策理由",
  "下一步动作",
  "决策时间",
  "Report Hash",
  "最近同步时间",
] as const;

export type CommodityPoolFieldName = (typeof COMMODITY_POOL_TABLE_FIELDS)[number]["name"];
export type CommodityPoolRow = Partial<Record<CommodityPoolFieldName, unknown>>;

export type CommodityPoolFieldValidation = {
  readonly isValid: boolean;
  readonly missingRequiredFields: readonly string[];
  readonly missingOptionalFields: readonly string[];
  readonly missingWriteFields: readonly string[];
  readonly incompatibleFields: readonly LarkIncompatibleField[];
  readonly fieldMapping: Record<string, LarkFieldMeta>;
};

export function validateCommodityPoolFields(
  remoteFields: readonly LarkFieldMeta[],
): CommodityPoolFieldValidation {
  const remoteMap = new Map(remoteFields.map((field) => [field.fieldName.trim(), field]));
  const missingRequiredFields: string[] = [];
  const missingOptionalFields: string[] = [];
  const incompatibleFields: LarkIncompatibleField[] = [];
  const fieldMapping: Record<string, LarkFieldMeta> = {};

  for (const definition of COMMODITY_POOL_TABLE_FIELDS) {
    const remote = remoteMap.get(definition.name);
    if (!remote) {
      (definition.requiredForSync ? missingRequiredFields : missingOptionalFields).push(definition.name);
      continue;
    }
    fieldMapping[definition.name] = remote;
    if (!definition.expectedTypes.includes(remote.type)) {
      incompatibleFields.push({
        fieldName: definition.name,
        expectedType: definition.expectedTypes.join(" | "),
        actualType: `${remote.type} (${remote.uiType})`,
      });
    }
  }

  const missingWriteFields = [...missingRequiredFields, ...missingOptionalFields];
  return {
    isValid: missingWriteFields.length === 0 && incompatibleFields.length === 0,
    missingRequiredFields,
    missingOptionalFields,
    missingWriteFields,
    incompatibleFields,
    fieldMapping,
  };
}

function valueOf<T>(field: FactField<T> | undefined): T | null {
  return field?.status === "present" ? field.value : null;
}

function textOf(field: FactField<string> | undefined): string {
  const value = valueOf(field);
  return typeof value === "string" ? value : "";
}

function numberOf(field: FactField<number> | undefined): number | null {
  const value = valueOf(field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dimensionText(value: ProductPackageDimensions | ProductItemDimensions | null): string {
  return value
    ? `${[value.length, value.width, value.height].filter((dimension): dimension is number => typeof dimension === "number").join(" × ")} ${value.unit}`
    : "";
}

function weightText(value: ProductPackageWeight | null): string {
  return value ? `${value.value} ${value.unit}` : "";
}

function marketplaceOf(subjectKey: string): string {
  const parts = subjectKey.split(":");
  return parts.length === 3 ? parts[1] : "";
}

function baseLink(baseUrl: string | undefined, subjectKey: string): string {
  const path = `/source-layer?subjectKey=${encodeURIComponent(subjectKey)}`;
  return baseUrl?.trim() ? `${baseUrl.trim().replace(/\/+$/, "")}${path}` : path;
}

export type MapProductFactOptions = {
  readonly baseUrl?: string;
  readonly qualityStatus?: string;
};

/** ProductFact → 商品池完整新建行。只读取事实字段，不做推断或单位换算。 */
export function mapProductFactToCommodityRow(
  productFact: ProductFact,
  options: MapProductFactOptions = {},
): CommodityPoolRow {
  const asin = textOf(productFact.basic.asin);
  const price = valueOf(productFact.basic.price);
  const revenue = valueOf(productFact.market.monthlyRevenueEstimate);
  const fbaFee = valueOf(productFact.profit.fbaFee);
  const grossMargin = numberOf(productFact.market.estimatedGrossMargin);
  const dimensions = valueOf(productFact.profit.packageDimensions);
  const weight = valueOf(productFact.profit.packageWeight);
  const itemDimensions = valueOf(productFact.profit.itemDimensions);
  const itemWeight = valueOf(productFact.profit.itemWeight);

  return {
    subjectKey: productFact.subjectKey,
    marketplace: marketplaceOf(productFact.subjectKey),
    ASIN: asin,
    商品主图: textOf(productFact.basic.image),
    商品标题: textOf(productFact.basic.title),
    品牌: textOf(productFact.basic.brand),
    类目: textOf(productFact.basic.category),
    商品链接: productFact.sourceProof.sourceUrl ?? "",
    当前售价: price?.amount ?? null,
    售价币种: price?.currency ?? "",
    预估月销量: numberOf(productFact.market.monthlySalesEstimate),
    预估月销售额: revenue?.amount ?? null,
    预估FBA费: fbaFee?.amount ?? null,
    预估毛利率: grossMargin,
    LQS评分: numberOf(productFact.market.listingQualityScore),
    大类BSR: numberOf(productFact.market.bsr),
    小类BSR: numberOf(productFact.market.subCategoryBsr),
    评分: numberOf(productFact.basic.rating),
    评论数: numberOf(productFact.basic.reviewCount),
    上架时间: textOf(productFact.market.dateFirstAvailable ?? productFact.market.launchedDate),
    包装尺寸: dimensionText(dimensions),
    包装重量: weightText(weight),
    商品尺寸: dimensionText(itemDimensions),
    商品重量: weightText(itemWeight),
    数据来源: productFact.sourceProof.source,
    采集时间: productFact.sourceProof.capturedAt,
    数据质量状态: options.qualityStatus ?? "passed",
    工作台链接: baseLink(options.baseUrl, productFact.subjectKey),
    研究状态: "未研究",
    人工决策: "未决策",
    决策理由: "",
    下一步动作: "待定",
    决策时间: "",
    "Report Hash": "",
    最近同步时间: "",
  };
}

export type CommodityDecisionRow = {
  readonly researchStatus: "已完成";
  readonly decision: "可做" | "不做" | "待观察";
  readonly reason: string;
  readonly nextAction?: string | null;
  readonly decidedAt: string;
  readonly reportHash: string;
  readonly syncedAt: string;
};

export function mapCommodityDecisionToRow(input: CommodityDecisionRow): CommodityPoolRow {
  return {
    研究状态: input.researchStatus,
    人工决策: input.decision,
    决策理由: input.reason,
    下一步动作: input.nextAction ?? "",
    决策时间: input.decidedAt,
    "Report Hash": input.reportHash,
    最近同步时间: input.syncedAt,
  };
}
