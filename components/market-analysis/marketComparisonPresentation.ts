import type { MarketIntelligence, MarketIntelligenceSample } from "@/lib/marketScan/intelligence";

export type ComparisonField = "price" | "material" | "dimensions" | "weight" | "rating" | "reviews";
export type DifferenceState = "different" | "close" | "unknown" | "conflict";
export const DIFFERENCE_LABELS: Record<DifferenceState, string> = { different: "不同", close: "接近", unknown: "未知", conflict: "冲突" };
export const COMPARISON_FIELDS: Record<ComparisonField, { label: string; limit: string; question: string }> = {
  price: { label: "页面标价", limit: "套装数量、配置或币种未对齐时，标价差不等于性价比或利润优势。", question: "03：核实件数与配置，在同等功能和计价单位下验证可接受售价，再询价核实成本。" },
  material: { label: "材质声明", limit: "名称相同不证明配方、耐温、清洁性或耐用性相同；来源声明不是实测结果。", question: "03：拿到样品与材料资料，用同一条件验证与问题相关的性能。" },
  dimensions: { label: "商品尺寸", limit: "长宽高含义、产品/包装规格与使用场景尚需对齐。", question: "03：核实测量对象、方向和使用空间，用同一场景实测适配；不默认更大更好。" },
  weight: { label: "来源重量", limit: "单件、套装或整包的重量口径未确认，不能据此判断轻便、材料厚薄或物流成本。", question: "03：分别称量单件与整包，核对件数和材料，再评估使用与运输影响。" },
  rating: { label: "页面评分", limit: "轻微评分差不证明实物质量优势；样本与评价积累不同。", question: "03：核对具体使用反馈，并用同条件测试验证相关性能。" },
  reviews: { label: "累计评价数", limit: "只比较可复核读数；评价积累不等于销量、进入门槛或痛点发生率。", question: "03：检查父子变体及来源时间，回到具体正反评论寻找待验证问题。" },
};

const aliases: Record<ComparisonField, string[]> = { price: ["price"], material: ["material"], dimensions: ["itemDimensions"], weight: ["itemWeight", "packageWeight"], rating: ["rating"], reviews: ["reviewCount"] };
const num = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const lengthUnits: Record<string, number> = { in: 2.54, inch: 2.54, inches: 2.54, cm: 1, mm: 0.1 };

export function comparisonCell(data: MarketIntelligence, sample: MarketIntelligenceSample, field: ComparisonField) {
  const detail = data.productDetails?.find((item) => item.subjectKey === sample.subjectKey);
  const conflicts = detail?.facts.conflicts.filter((conflict) => aliases[field].some((alias) => conflict.field === alias || conflict.field.endsWith(`.${alias}`))) ?? [];
  let value: number | string | number[] | null = null;
  let display = "未知";
  if (field === "price") { value = sample.price != null && sample.priceCurrency ? sample.price : null; display = sample.price == null ? "未知" : `${num(sample.price)} ${sample.priceCurrency ?? "币种未知"}`; }
  if (field === "material") { value = detail?.facts.material?.trim().toLowerCase() || null; display = detail?.facts.material || "未知"; }
  if (field === "dimensions") {
    const dims = detail?.facts.itemDimensions;
    if (dims) { const parts = [dims.length, dims.width, ...(dims.height == null ? [] : [dims.height])]; display = `${parts.map(num).join(" × ")} ${dims.unit}`; const factor = lengthUnits[dims.unit.toLowerCase().trim()]; value = factor ? parts.map((part) => part * factor) : null; }
  }
  if (field === "weight") { const weight = detail?.facts.itemWeight; display = weight ? `${num(weight.value)} ${weight.unit}（单件 / 整包待核实）` : "未知"; /* Object basis is unknown: never infer a weight advantage. */ }
  if (field === "rating") { value = sample.rating; display = value == null ? "未知" : `${num(value)} / 5`; }
  if (field === "reviews") {
    const caliber = sample.reviewCountCaliber;
    value = caliber?.state === "verified" ? sample.reviewCount : null;
    display = caliber?.state === "conflict" ? `锁定 ${sample.reviewCount == null ? "未知" : num(sample.reviewCount)} / 商品页 ${caliber.productPageValue == null ? "未知" : num(caliber.productPageValue)}（冲突，未采用）` : sample.reviewCount == null ? "未知" : `${num(sample.reviewCount)}（${caliber?.state === "verified" ? "可复核" : "未复核"}）`;
  }
  const conflict = conflicts.length > 0 || (field === "reviews" && sample.reviewCountCaliber?.state === "conflict");
  return { value: conflict ? null : value, display: conflict && field !== "reviews" ? "来源冲突，待核实" : display, conflict, conflicts, detail };
}

/** Presentation comparison only. 5% / 0.1 rating points suppress tiny display differences; neither is a score or business threshold. */
export function compareField(data: MarketIntelligence, samples: MarketIntelligenceSample[], field: ComparisonField): DifferenceState {
  const cells = samples.map((sample) => comparisonCell(data, sample, field));
  if (cells.some((cell) => cell.conflict)) return "conflict";
  if (samples.length < 2 || cells.some((cell) => cell.value === null)) return "unknown";
  if (field === "price" && new Set(samples.map((sample) => sample.priceCurrency)).size !== 1) return "unknown";
  const values = cells.map((cell) => cell.value!);
  if (typeof values[0] === "string") return new Set(values).size === 1 ? "close" : "different";
  if (Array.isArray(values[0])) {
    const arrays = values as number[][];
    if (new Set(arrays.map((parts) => parts.length)).size !== 1) return "unknown";
    return arrays[0].every((_, index) => near(arrays.map((parts) => parts[index]))) ? "close" : "different";
  }
  const numbers = values as number[];
  return field === "rating" ? (Math.max(...numbers) - Math.min(...numbers) <= 0.1 + Number.EPSILON * 4 ? "close" : "different") : near(numbers) ? "close" : "different";
}
function near(values: number[]) { const max = Math.max(...values), min = Math.min(...values); return max === min || max - min <= Math.max(Math.abs(max), Math.abs(min)) * 0.05; }

export function questionFields(question: string): ComparisonField[] {
  if (/重量|轻便|weight|lightweight/iu.test(question)) return ["weight", "dimensions", "price"];
  if (/材质|清洁|耐用|耐温|不粘|material|clean|durab|heat|stick/iu.test(question)) return ["material", "dimensions", "price"];
  if (/评分|评价|评论|review|rating/iu.test(question)) return ["reviews", "rating", "material"];
  return ["dimensions", "material", "price"];
}
