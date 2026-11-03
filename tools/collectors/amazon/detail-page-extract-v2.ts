import {
  AMAZON_DETAIL_FIELD_REGISTRY,
  AMAZON_DETAIL_FIELD_REGISTRY_VERSION,
  AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION,
  AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION,
  type AmazonDetailFieldNature,
  type AmazonDetailFieldRule,
} from "./detail-page-field-registry";
import {
  normalizeAsin,
  parseAsinFromDetailUrl,
  type AmazonDetailPageExtraction,
  type AmazonDetailPageStatus,
} from "./detail-page-extract";

export type AmazonDetailDomCandidate = {
  selector: string;
  text: string | null;
  label: string | null;
  value: string | null;
  href: string | null;
  src: string | null;
  alt: string | null;
  selected: boolean | null;
  priceContext?: {
    id: string | null;
    className: string | null;
    dataAColor: string | null;
    dataASize: string | null;
    semanticRole?: "current_pay_now" | "list_price" | "unit_price" | "basis_price" | "subscribe_price" | "coupon" | "member_price" | "other_offer" | "unknown";
    purchaseContext?: "one_time" | "subscribe_save" | "unknown" | "not_applicable";
    selected?: boolean | null;
    inPrimaryBuyBox?: boolean;
  } | null;
};

export type AmazonDetailDomSpecificationRow = {
  region: string;
  selector: string;
  label: string | null;
  value: string | null;
  text: string | null;
};

export type AmazonDetailPageDomSnapshot = {
  schemaVersion: "amazon-detail-page-dom-snapshot.v1";
  pageUrl: string;
  pageStatus: AmazonDetailPageStatus;
  productRootSelector: string | null;
  candidates: Record<string, AmazonDetailDomCandidate[]>;
  specificationRows: AmazonDetailDomSpecificationRow[];
};

export type AmazonDetailFieldStatus = "observed" | "derived" | "missing" | "ambiguous" | "invalid" | "blocked";

export type AmazonDetailFieldSourceTrace = {
  ruleId: string;
  registryVersion: typeof AMAZON_DETAIL_FIELD_REGISTRY_VERSION;
  region: string;
  selector: string | null;
  label: string | null;
  ruleVersion: string | null;
};

export type AmazonDetailRegisteredField = {
  canonicalField: string;
  priority: AmazonDetailFieldRule["priority"];
  fieldNature: AmazonDetailFieldNature;
  status: AmazonDetailFieldStatus;
  value: unknown;
  reason: string | null;
  sourceTrace: AmazonDetailFieldSourceTrace;
};

export type AmazonDetailPageExtractionV2 = AmazonDetailPageExtraction & {
  extractorVersion: "amazon-detail-extractor.v2";
  fieldRegistryVersion: typeof AMAZON_DETAIL_FIELD_REGISTRY_VERSION;
  registeredFields: Record<string, AmazonDetailRegisteredField>;
};

export type AmazonDetailPageExtractionV2Options = {
  expectedAsin: string | null;
  capturedAt: string;
  collectorVersion: string;
  marketplace?: "US";
};

export type BoughtPastMonthEstimate = {
  rawText: string;
  lowerBound: number | null;
  upperBound: number | null;
  qualifier: "exact" | "at_least" | "range" | "approximate" | "unknown";
  metricNature: "estimate";
};

export type PhysicalDimensionObservation = {
  rawText: string;
  dimensions: number[];
  unit: "in" | "cm" | null;
};

export type PhysicalWeightObservation = {
  rawText: string;
  amount: number | null;
  unit: "kg" | "lb" | "oz" | "g" | null;
};

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const MAX_SPECIFICATION_ROWS = 40;
const MAX_SPECIFICATION_KEY_LENGTH = 100;
const MAX_SPECIFICATION_VALUE_LENGTH = 300;
const MAX_SPECIFICATION_PAYLOAD_BYTES = 12_000;
const MAX_LIST_ITEMS = 40;
const MAX_FIELD_TEXT_LENGTH = 1_200;
const EXCLUDED_SPEC_LABEL = /sponsored|frequently bought together|customers also (?:viewed|bought)|related products?|recommend(?:ed|ation)|customer reviews?|navigation|\bfba fee\b|estimated monthly (?:sales|revenue)/i;

function cleanText(value: string | null | undefined, maxLength = MAX_FIELD_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\uFEFF\u202A-\u202E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeLabel(value: string | null | undefined): string {
  return (cleanText(value, 120) ?? "")
    .replace(/[:：]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function makeTrace(
  rule: AmazonDetailFieldRule,
  source?: { selector?: string | null; label?: string | null; ruleVersion?: string | null } | null,
): AmazonDetailFieldSourceTrace {
  return {
    ruleId: rule.canonicalField,
    registryVersion: AMAZON_DETAIL_FIELD_REGISTRY_VERSION,
    region: rule.pageRegion,
    selector: source?.selector ? cleanText(source.selector, 180) : null,
    label: source?.label ? cleanText(source.label, 120) : null,
    ruleVersion: source?.ruleVersion ? cleanText(source.ruleVersion, 80) : null,
  };
}

function field(
  rule: AmazonDetailFieldRule,
  status: AmazonDetailFieldStatus,
  value: unknown,
  reason: string | null,
  source?: { selector?: string | null; label?: string | null; ruleVersion?: string | null } | null,
): AmazonDetailRegisteredField {
  return {
    canonicalField: rule.canonicalField,
    priority: rule.priority,
    fieldNature: rule.fieldNature,
    status,
    value,
    reason,
    sourceTrace: makeTrace(rule, source),
  };
}

function ruleFor(canonicalField: string): AmazonDetailFieldRule {
  const rule = AMAZON_DETAIL_FIELD_REGISTRY.find((candidate) => candidate.canonicalField === canonicalField);
  if (!rule) throw new Error(`Amazon detail field registry missing: ${canonicalField}`);
  return rule;
}

function candidatesFor(snapshot: AmazonDetailPageDomSnapshot, rule: AmazonDetailFieldRule): AmazonDetailDomCandidate[] {
  return rule.selectorCandidates.flatMap((selector) => snapshot.candidates[selector] ?? []);
}

function valueFromCandidate(candidate: AmazonDetailDomCandidate): string | null {
  return cleanText(candidate.text ?? candidate.value ?? candidate.alt);
}

function distinctBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = key(value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function specRowsFor(
  snapshot: AmazonDetailPageDomSnapshot,
  aliases: readonly string[],
  allowInlineAlias = false,
): AmazonDetailDomSpecificationRow[] {
  return snapshot.specificationRows.filter((row) => {
    if (allowInlineAlias) return specificationLabelMatch(row, aliases) !== null;
    const normalizedLabel = normalizeLabel(row.label);
    return Boolean(normalizedLabel && aliases.some((alias) => normalizeLabel(alias) === normalizedLabel));
  });
}

function specificationLabelMatch(
  row: AmazonDetailDomSpecificationRow,
  aliases: readonly string[],
): { label: string; inlineValue: string | null } | null {
  const rowLabel = normalizeLabel(row.label);
  const exactAlias = aliases.find((alias) => normalizeLabel(alias) === rowLabel);
  const rowText = cleanText(row.text, MAX_SPECIFICATION_VALUE_LENGTH);
  const orderedAliases = exactAlias ? [exactAlias] : [...aliases].sort((left, right) => right.length - left.length);
  if (exactAlias && (!rowText || normalizeLabel(rowText.slice(0, exactAlias.length)) !== normalizeLabel(exactAlias))) {
    return { label: exactAlias, inlineValue: null };
  }
  for (const alias of orderedAliases) {
    if (!rowText) return exactAlias ? { label: alias, inlineValue: null } : null;
    const prefix = rowText.slice(0, alias.length);
    if (normalizeLabel(prefix) !== normalizeLabel(alias)) continue;
    const remainder = rowText.slice(alias.length);
    if (remainder && !/^[\s:：]/u.test(remainder)) continue;
    const inlineValue = cleanText(remainder.replace(/^[\s:：]+/u, ""), MAX_SPECIFICATION_VALUE_LENGTH);
    return { label: alias, inlineValue };
  }
  return null;
}

function specificationRowValue(
  row: AmazonDetailDomSpecificationRow,
  aliases: readonly string[],
  allowInlineAlias = false,
): string | null {
  if (!allowInlineAlias) return cleanText(row.value, MAX_SPECIFICATION_VALUE_LENGTH);
  const matched = specificationLabelMatch(row, aliases);
  if (!matched) return null;
  return cleanText(row.value, MAX_SPECIFICATION_VALUE_LENGTH) ?? matched.inlineValue;
}

function resolveOne<T>(
  rule: AmazonDetailFieldRule,
  values: Array<{ value: T; source: { selector?: string | null; label?: string | null } }>,
  key: (value: T) => string,
): { status: "observed" | "missing" | "ambiguous"; value: T | null; source: { selector?: string | null; label?: string | null } | null; reason: string | null } {
  const distinct = distinctBy(values, (item) => key(item.value));
  if (distinct.length === 0) return { status: "missing", value: null, source: null, reason: "selector_not_found" };
  if (distinct.length > 1) return { status: "ambiguous", value: null, source: null, reason: "conflicting_candidates" };
  return { status: "observed", value: distinct[0].value, source: distinct[0].source, reason: null };
}

/**
 * title 候选裁决（2026-10-14，真实页面 B0CFTP6JR4 定位）：
 *
 * 真实 Amazon 详情页同一 `#productTitle` 选择器下有两个节点：
 *   1) h1#title 内的**可见**标题（较短，页面实际呈现的文本）；
 *   2) 无障碍/离屏**完整**标题（innerText 为空、textContent 更长，包含全部规格词）。
 * 旧逻辑按「多值即冲突」判 ambiguous，导致详情 title 长期 missing —— 这不是页面缺陷，
 * 而是同一标题的两种呈现（可见短文本 + 完整文本，且短文本是完整文本的前缀）。
 *
 * 规则（确定性、可解释、不编造）：
 * - 0 个候选 → missing（selector_not_found）；
 * - 1 个候选 → observed（与既有行为一致）；
 * - 多个候选 → **仅当**所有候选归一化后其中一个为其余全部的前缀时，取最长的那个
 *   （同一标题的「可见短版 / 完整版」结构），observed；
 * - 其余任何多值情况（真正不同的标题）→ 仍然 ambiguous（conflicting_candidates），
 *   绝不为了凑一个 title 而挑选或拼接文本。
 */
export function resolveTitleCandidates(
  values: Array<{ value: string; source: { selector?: string | null; label?: string | null } }>,
): { status: "observed" | "missing" | "ambiguous"; value: string | null; source: { selector?: string | null; label?: string | null } | null; reason: string | null } {
  const distinct = distinctBy(values, (item) => item.value).filter((item) => item.value.length > 0);
  if (distinct.length === 0) return { status: "missing", value: null, source: null, reason: "selector_not_found" };
  if (distinct.length === 1) return { status: "observed", value: distinct[0].value, source: distinct[0].source, reason: null };
  const prefixSuperset = (candidate: string, other: string): boolean => {
    const left = candidate.toLowerCase();
    const right = other.toLowerCase();
    return left === right || left.startsWith(right);
  };
  // 找到「是其他所有候选前缀」的最长候选（完整版）。
  const supersets = distinct.filter((item) => distinct.every((other) => prefixSuperset(item.value, other.value)));
  if (supersets.length === 1) {
    return { status: "observed", value: supersets[0].value, source: supersets[0].source, reason: null };
  }
  return { status: "ambiguous", value: null, source: null, reason: "conflicting_candidates" };
}

function parsePrice(value: string | null): { amount: number; currency: "USD" } | null {
  const text = cleanText(value, 100);
  if (!text || !/^\s*(?:US\$|\$)/i.test(text)) return null;
  const match = /^\s*(?:US\$|\$)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:USD)?\s*$/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: "USD" } : null;
}

type ResolvedPriceCandidate = {
  value: { amount: number; currency: "USD" };
  source: { selector?: string | null; label?: string | null };
  semanticRole: NonNullable<AmazonDetailDomCandidate["priceContext"]>["semanticRole"];
  purchaseContext: NonNullable<AmazonDetailDomCandidate["priceContext"]>["purchaseContext"];
  selected: boolean | null;
};

function inferredPriceRole(candidate: AmazonDetailDomCandidate): ResolvedPriceCandidate["semanticRole"] {
  const context = candidate.priceContext;
  const metadataRole = context?.semanticRole;
  if (metadataRole && metadataRole !== "unknown") return metadataRole;
  const classes = `${context?.className ?? ""} ${candidate.selector}`.toLowerCase();
  const id = (context?.id ?? "").toLowerCase();
  if (/priceperunit|price-per-unit|apex-priceperunit/.test(`${classes} ${id}`)) return "unit_price";
  if (/basisprice|basis-price|apex-basisprice/.test(`${classes} ${id}`)) return "basis_price";
  if (/coupon/.test(`${classes} ${id}`)) return "coupon";
  if (/member/.test(`${classes} ${id}`)) return "member_price";
  if (/other.?offer|olp.?price/.test(`${classes} ${id}`)) return "other_offer";
  if (/subscribe/.test(`${classes} ${id}`)) return "subscribe_price";
  if (/a-text-price|listprice|list-price/.test(`${classes} ${id}`) || context?.dataAColor === "secondary") return "list_price";
  if (/apex-pricetopay-value|priceblock_(?:our|deal)price/.test(`${classes} ${id}`)) return "current_pay_now";
  if (context?.dataAColor === "price") return "current_pay_now";
  return "unknown";
}

function resolvePrimaryPrice(
  snapshot: AmazonDetailPageDomSnapshot,
  rule: AmazonDetailFieldRule,
) {
  const priceKey = (value: { amount: number; currency: "USD" }) => `${value.amount}|${value.currency}`;
  const currentCandidates = candidatesFor(snapshot, rule).flatMap((candidate): ResolvedPriceCandidate[] => {
    if (candidate.priceContext?.inPrimaryBuyBox === false) return [];
    const value = parsePrice(valueFromCandidate(candidate));
    const semanticRole = inferredPriceRole(candidate);
    if (!value || (semanticRole !== "current_pay_now" && semanticRole !== "subscribe_price")) return [];
    const purchaseContext = candidate.priceContext?.purchaseContext
      ?? (semanticRole === "current_pay_now" ? "not_applicable" : "unknown");
    return [{
      value,
      source: { selector: candidate.selector, label: null },
      semanticRole,
      purchaseContext,
      selected: candidate.priceContext?.selected ?? null,
    }];
  });
  if (currentCandidates.length === 0) return resolveOne<{ amount: number; currency: "USD" }>(rule, [], priceKey);

  const selectedCandidates = currentCandidates.filter((candidate) => candidate.selected === true);
  const selectedContexts = [...new Set(selectedCandidates
    .filter((candidate) => candidate.selected === true && (candidate.purchaseContext === "one_time" || candidate.purchaseContext === "subscribe_save"))
    .map((candidate) => candidate.purchaseContext))];
  if (selectedContexts.length > 1) {
    return { status: "ambiguous" as const, value: null, source: null, reason: "conflicting_candidates" };
  }

  let eligible = currentCandidates.filter((candidate) => candidate.selected !== false);
  if (selectedCandidates.length > 0) {
    const activeContext = selectedContexts[0] ?? null;
    eligible = eligible.filter((candidate) =>
      candidate.selected === true
      || candidate.purchaseContext === "not_applicable"
      || candidate.purchaseContext === "unknown"
      || activeContext === null
      || candidate.purchaseContext === activeContext,
    );
  } else if (eligible.some((candidate) => candidate.purchaseContext !== "not_applicable")) {
    return { status: "ambiguous" as const, value: null, source: null, reason: "conflicting_candidates" };
  }

  return resolveOne(rule, eligible, priceKey);
}

function parseRanks(rawText: string): Array<{ rank: number; category: string }> {
  const result: Array<{ rank: number; category: string }> = [];
  const pattern = /#\s*([0-9][0-9,]*)\s+in\s+(.+?)(?=(?:\s+#\s*[0-9][0-9,]*\s+in\s+)|(?:\s*\(See\b)|$)/gi;
  for (const match of rawText.matchAll(pattern)) {
    const rank = Number(match[1].replace(/,/g, ""));
    const category = cleanText(match[2].replace(/[;,\s]+$/, ""), 160);
    if (Number.isInteger(rank) && rank > 0 && category) result.push({ rank, category });
  }
  return distinctBy(result, (item) => `${item.rank}|${normalizeLabel(item.category)}`);
}

function parseDate(value: string | null): { rawText: string; normalizedDate: string | null } | null {
  const rawText = cleanText(value, 120);
  if (!rawText) return null;
  const match = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})$/i.exec(rawText);
  if (!match) return { rawText, normalizedDate: null };
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  };
  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (day < 1 || day > 31 || year < 1800 || year > 2200) return { rawText, normalizedDate: null };
  return { rawText, normalizedDate: `${match[3]}-${month}-${String(day).padStart(2, "0")}` };
}

function parseDimension(value: string | null): PhysicalDimensionObservation | null {
  const rawText = cleanText(value, 180);
  if (!rawText) return null;
  const numbers = [...rawText.matchAll(/[0-9]+(?:\.[0-9]+)?/g)].map((match) => Number(match[0]));
  const unitMatch = /\b(inches?|in|centimeters?|cm)\b|["″]/i.exec(rawText);
  const unit = unitMatch
    ? (/^(?:cm|centimeters?)$/i.test(unitMatch[0]) ? "cm" : "in")
    : null;
  const hasDimensionSeparator = /[x×]/i.test(rawText);
  if (numbers.length < 2 || numbers.length > 3 || !hasDimensionSeparator || numbers.some((number) => !Number.isFinite(number) || number <= 0)) {
    return { rawText, dimensions: [], unit };
  }
  return { rawText, dimensions: numbers, unit };
}

function parseWeight(value: string | null): PhysicalWeightObservation | null {
  const rawText = cleanText(value, 180);
  if (!rawText) return null;
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(kilograms?|kg|pounds?|lbs?|ounces?|oz|grams?|g)\b/i.exec(rawText);
  if (!match) return { rawText, amount: null, unit: null };
  const amount = Number(match[1]);
  const rawUnit = match[2].toLowerCase();
  const unit: PhysicalWeightObservation["unit"] = rawUnit.startsWith("kg") || rawUnit.startsWith("kilogram")
    ? "kg"
    : rawUnit.startsWith("lb") || rawUnit.startsWith("pound")
      ? "lb"
      : rawUnit.startsWith("oz") || rawUnit.startsWith("ounce")
        ? "oz"
        : "g";
  return { rawText, amount: Number.isFinite(amount) && amount > 0 ? amount : null, unit };
}

function parseBoughtPastMonth(value: string | null): BoughtPastMonthEstimate | null {
  const rawText = cleanText(value, 160);
  if (!rawText || !/bought\s+in\s+past\s+month/i.test(rawText)) return null;
  const rangeMatch = /(?:about|approximately|~)?\s*([0-9][0-9,]*)\s*(?:-|–|to)\s*([0-9][0-9,]*)\s+bought\s+in\s+past\s+month/i.exec(rawText);
  if (rangeMatch) {
    const lowerBound = Number(rangeMatch[1].replace(/,/g, ""));
    const upperBound = Number(rangeMatch[2].replace(/,/g, ""));
    if (Number.isSafeInteger(lowerBound) && Number.isSafeInteger(upperBound) && upperBound >= lowerBound) {
      return { rawText, lowerBound, upperBound, qualifier: "range", metricNature: "estimate" };
    }
  }
  const countMatch = /(about\s+|approximately\s+|~\s*)?([0-9][0-9,.]*\s*[kK]?)\s*(\+)?\s+bought\s+in\s+past\s+month/i.exec(rawText);
  if (!countMatch) return { rawText, lowerBound: null, upperBound: null, qualifier: "unknown", metricNature: "estimate" };
  const numericToken = countMatch[2].replace(/\s+/g, "");
  const hasK = /k$/i.test(numericToken);
  const amount = Number(numericToken.replace(/,/g, "").replace(/k$/i, "")) * (hasK ? 1000 : 1);
  if (!Number.isSafeInteger(amount) || amount < 0) return { rawText, lowerBound: null, upperBound: null, qualifier: "unknown", metricNature: "estimate" };
  if (countMatch[1]) return { rawText, lowerBound: amount, upperBound: null, qualifier: "approximate", metricNature: "estimate" };
  if (countMatch[3]) return { rawText, lowerBound: amount, upperBound: null, qualifier: "at_least", metricNature: "estimate" };
  return { rawText, lowerBound: amount, upperBound: amount, qualifier: "exact", metricNature: "estimate" };
}

function canonicalImageUrl(candidate: AmazonDetailDomCandidate): string | null {
  const value = candidate.src ?? candidate.href;
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function uniqueTextCandidates(snapshot: AmazonDetailPageDomSnapshot, rule: AmazonDetailFieldRule): Array<{ value: string; source: { selector: string; label: string | null } }> {
  return candidatesFor(snapshot, rule)
    .map((candidate) => ({
      value: valueFromCandidate(candidate),
      source: { selector: candidate.selector, label: candidate.label },
    }))
    .filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
}

function normalizedBrand(value: string): string {
  return cleanText(value.replace(/^visit\s+the\s+/i, "").replace(/\s+store$/i, ""), 160) ?? "";
}

function comparableTitle(value: string): string {
  return value
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&")
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/gu, " ")
    .trim();
}

function extractBrand(snapshot: AmazonDetailPageDomSnapshot): AmazonDetailRegisteredField {
  const rule = ruleFor("brand");
  const candidates = uniqueTextCandidates(snapshot, rule).map((item) => ({ value: normalizedBrand(item.value), source: item.source }));
  const spec = specRowsFor(snapshot, rule.labelAliases)
    .map((row) => ({ value: cleanText(row.value, 160), source: { selector: row.selector, label: row.label } }))
    .filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const resolved = resolveOne(rule, [...candidates, ...spec], (value) => normalizeLabel(value));
  return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
}

function extractSpecText(snapshot: AmazonDetailPageDomSnapshot, canonicalField: string): AmazonDetailRegisteredField {
  const rule = ruleFor(canonicalField);
  const allowInlineAlias = canonicalField === "dateFirstAvailable"
    || canonicalField === "itemDimensions"
    || canonicalField === "packageDimensions";
  const candidates = specRowsFor(snapshot, rule.labelAliases, allowInlineAlias)
    .map((row) => ({
      value: cleanText(specificationRowValue(row, rule.labelAliases, allowInlineAlias)),
      source: {
        selector: row.selector,
        label: row.label ?? (allowInlineAlias ? specificationLabelMatch(row, rule.labelAliases)?.label ?? null : null),
      },
    }))
    .filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const resolved = resolveOne(rule, candidates, (value) => normalizeLabel(value));
  if (resolved.status !== "observed") return field(rule, resolved.status, null, resolved.reason, resolved.source);
  if (canonicalField === "dateFirstAvailable") {
    return field(rule, "observed", parseDate(resolved.value), null, resolved.source);
  }
  if (canonicalField === "itemDimensions" || canonicalField === "packageDimensions") {
    return field(rule, "observed", parseDimension(resolved.value), null, resolved.source);
  }
  if (canonicalField === "itemWeight" || canonicalField === "packageWeight") {
    return field(rule, "observed", parseWeight(resolved.value), null, resolved.source);
  }
  return field(rule, "observed", resolved.value, null, resolved.source);
}

function parseParentAsin(snapshot: AmazonDetailPageDomSnapshot, expectedAsin: string): AmazonDetailRegisteredField {
  const rule = ruleFor("parentAsin");
  const specCandidates = specRowsFor(snapshot, rule.labelAliases).map((row) => ({
    value: normalizeAsin(row.value),
    source: { selector: row.selector, label: row.label },
  })).filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const selectorCandidates = uniqueTextCandidates(snapshot, rule).map((item) => ({
    value: /parent\s+asin\s*[:：]?\s*([A-Z0-9]{10})/i.exec(item.value)?.[1]?.toUpperCase() ?? null,
    source: item.source,
  })).filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const resolved = resolveOne(rule, [...specCandidates, ...selectorCandidates], (value) => value);
  if (resolved.status !== "observed" || !resolved.value || resolved.value === expectedAsin) {
    return field(rule, resolved.status === "ambiguous" ? "ambiguous" : "missing", null,
      resolved.status === "ambiguous" ? resolved.reason : "explicit_parent_relation_not_found", resolved.source);
  }
  return field(rule, "observed", resolved.value, null, resolved.source);
}

function collectBsrRanks(snapshot: AmazonDetailPageDomSnapshot): { value: Array<{ rank: number; category: string }>; source: { selector: string | null; label: string | null } | null } {
  const rule = ruleFor("bsrRanks");
  const texts = uniqueTextCandidates(snapshot, rule).filter((item) => /best sellers rank|#\s*[0-9][0-9,]*\s+in\s+/i.test(item.value));
  const rowTexts = snapshot.specificationRows
    .filter((row) => /best sellers rank/i.test(`${row.label ?? ""} ${row.text ?? ""}`))
    .map((row) => ({ value: cleanText(row.text ?? row.value, 500) ?? "", source: { selector: row.selector, label: row.label } }))
    .filter((item) => item.value);
  const all = [...texts, ...rowTexts];
  const ranks = distinctBy(all.flatMap((item) => parseRanks(item.value)), (item) => `${item.rank}|${normalizeLabel(item.category)}`);
  return { value: ranks, source: all.length > 0 ? all[0].source : null };
}

function extractRawSpecifications(snapshot: AmazonDetailPageDomSnapshot, expectedAsin: string): AmazonDetailRegisteredField {
  const rule = ruleFor("rawSpecifications");
  const rows: Array<{ label: string; value: string; source: { selector: string; label: string } }> = [];
  const seen = new Set<string>();
  for (const row of snapshot.specificationRows) {
    if (row.region !== "productSpecifications") continue;
    const label = cleanText(row.label, MAX_SPECIFICATION_KEY_LENGTH);
    const value = cleanText(row.value, MAX_SPECIFICATION_VALUE_LENGTH);
    if (!label || !value || EXCLUDED_SPEC_LABEL.test(label)) continue;
    const referencedAsins = value.match(/(?:^|\b)[A-Z0-9]{10}(?:\b|$)/gi)?.map((asin) => asin.toUpperCase()) ?? [];
    if (referencedAsins.some((asin) => asin !== expectedAsin) && normalizeLabel(label) !== "parent asin") continue;
    const key = `${normalizeLabel(label)}|${normalizeLabel(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { label, value, source: { selector: row.selector, label } };
    const candidate = [...rows, item].map(({ label: candidateLabel, value: candidateValue }) => ({ label: candidateLabel, value: candidateValue }));
    if (rows.length >= MAX_SPECIFICATION_ROWS || new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_SPECIFICATION_PAYLOAD_BYTES) break;
    rows.push(item);
  }
  const value = rows.map(({ label, value: rowValue }) => ({ label, value: rowValue }));
  return field(rule, value.length > 0 ? "observed" : "missing", value, value.length > 0 ? null : "selector_not_found", rows[0]?.source ?? null);
}

function extractTextList(snapshot: AmazonDetailPageDomSnapshot, canonicalField: string): AmazonDetailRegisteredField {
  const rule = ruleFor(canonicalField);
  const values = candidatesFor(snapshot, rule)
    .map((candidate) => ({ value: valueFromCandidate(candidate), source: { selector: candidate.selector, label: candidate.label } }))
    .filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const unique = distinctBy(values, (item) => normalizeLabel(item.value)).slice(0, MAX_LIST_ITEMS);
  return field(rule, unique.length > 0 ? "observed" : "missing", unique.map((item) => item.value), unique.length > 0 ? null : "selector_not_found", unique[0]?.source ?? null);
}

function extractImage(snapshot: AmazonDetailPageDomSnapshot, canonicalField: "mainImage" | "galleryImages"): AmazonDetailRegisteredField {
  const rule = ruleFor(canonicalField);
  const candidates = candidatesFor(snapshot, rule)
    .map((candidate) => ({ value: canonicalImageUrl(candidate), source: { selector: candidate.selector, label: candidate.alt } }))
    .filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const unique = distinctBy(candidates, (item) => item.value);
  if (canonicalField === "mainImage") {
    const resolved = resolveOne(rule, unique, (value) => value);
    return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
  }
  const values = unique.map((item) => item.value).filter((value) => value.length <= 2_048).slice(0, 20);
  return field(rule, values.length > 0 ? "observed" : "missing", values, values.length > 0 ? null : "selector_not_found", unique[0]?.source ?? null);
}

function extractRatingDistribution(snapshot: AmazonDetailPageDomSnapshot): AmazonDetailRegisteredField {
  const rule = ruleFor("ratingDistribution");
  const distribution: Record<string, number> = {};
  const selectorByStar = new Map<string, string>();
  for (const candidate of candidatesFor(snapshot, rule)) {
    const text = valueFromCandidate(candidate) ?? "";
    const star = /([1-5])\s*star/i.exec(text)?.[1];
    const percentageText = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(text)?.[1];
    if (!star || !percentageText) continue;
    const percentage = Number(percentageText);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) continue;
    if (distribution[star] !== undefined && distribution[star] !== percentage) {
      return field(rule, "ambiguous", null, "conflicting_star_values", { selector: candidate.selector, label: null });
    }
    distribution[star] = percentage;
    selectorByStar.set(star, candidate.selector);
  }
  const keys = Object.keys(distribution);
  return field(rule, keys.length > 0 ? "observed" : "missing", distribution, keys.length > 0 ? null : "selector_not_found", keys.length > 0 ? { selector: selectorByStar.get(keys[0]) ?? null } : null);
}

function extractBoughtPastMonth(snapshot: AmazonDetailPageDomSnapshot): AmazonDetailRegisteredField {
  const rule = ruleFor("boughtPastMonth");
  const values = uniqueTextCandidates(snapshot, rule)
    .map((item) => ({ value: parseBoughtPastMonth(item.value), source: item.source }))
    .filter((item): item is { value: BoughtPastMonthEstimate; source: { selector: string; label: string | null } } => Boolean(item.value));
  const resolved = resolveOne(rule, values, (value) => JSON.stringify(value));
  return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
}

function extractSeller(snapshot: AmazonDetailPageDomSnapshot): AmazonDetailRegisteredField {
  const rule = ruleFor("seller");
  const candidates = uniqueTextCandidates(snapshot, rule).map((item) => ({
    value: cleanText(item.value.replace(/^sold\s+by\s*:?\s*/i, ""), 200),
    source: item.source,
  })).filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const resolved = resolveOne(rule, candidates, (value) => normalizeLabel(value));
  return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
}

function extractShipsFrom(snapshot: AmazonDetailPageDomSnapshot): AmazonDetailRegisteredField {
  const rule = ruleFor("shipsFrom");
  const candidates = uniqueTextCandidates(snapshot, rule).map((item) => {
    const match = /ships\s+from\s*:?\s*(.+?)(?=\s+sold\s+by\b|\s+fulfilled\s+by\b|$)/i.exec(item.value);
    return { value: match ? cleanText(match[1], 200) : null, source: item.source };
  }).filter((item): item is { value: string; source: { selector: string; label: string | null } } => Boolean(item.value));
  const resolved = resolveOne(rule, candidates, (value) => normalizeLabel(value));
  return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
}

function extractVariationOptions(snapshot: AmazonDetailPageDomSnapshot): AmazonDetailRegisteredField {
  const rule = ruleFor("variations");
  const candidates = candidatesFor(snapshot, rule)
    .map((candidate) => {
      const value = valueFromCandidate(candidate);
      if (!value) return null;
      return { value: { value, selected: candidate.selected }, source: { selector: candidate.selector, label: candidate.alt } };
    })
    .filter((item): item is { value: { value: string; selected: boolean | null }; source: { selector: string; label: string | null } } => item !== null);
  const unique = distinctBy(candidates, (item) => normalizeLabel(item.value.value)).slice(0, MAX_LIST_ITEMS);
  return field(rule, unique.length > 0 ? "observed" : "missing", unique.map((item) => item.value), unique.length > 0 ? null : "selector_not_found", unique[0]?.source ?? null);
}

function extractCoupon(snapshot: AmazonDetailPageDomSnapshot): AmazonDetailRegisteredField {
  const rule = ruleFor("coupon");
  const values = uniqueTextCandidates(snapshot, rule).map((item) => {
    const amountText = /(?:US\$|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/.exec(item.value)?.[1] ?? null;
    const percentText = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(item.value)?.[1] ?? null;
    return {
      value: {
        text: item.value.slice(0, 160),
        amount: amountText ? Number(amountText) : null,
        percent: percentText ? Number(percentText) : null,
        currency: amountText ? "USD" : null,
      },
      source: item.source,
    };
  });
  const resolved = resolveOne(rule, values, (value) => JSON.stringify(value));
  return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
}

function extractFieldValue(snapshot: AmazonDetailPageDomSnapshot, canonicalField: string, expectedAsin: string): AmazonDetailRegisteredField {
  const rule = ruleFor(canonicalField);
  if (rule.fieldNature === "BLOCKED") return field(rule, "blocked", null, "field_contract_blocked", null);
  switch (canonicalField) {
    case "asin": {
      const value = normalizeAsin(snapshot.candidates["input#ASIN"]?.[0]?.value ?? snapshot.candidates["input[name='ASIN']"]?.[0]?.value)
        ?? normalizeAsin(specRowsFor(snapshot, rule.labelAliases).map((row) => row.value).find((item) => normalizeAsin(item)));
      return value ? field(rule, "observed", value, null, { selector: "input#ASIN", label: "ASIN" }) : field(rule, "missing", null, "page_asin_anchor_not_found");
    }
    case "title": {
      const canonicalTitles = uniqueTextCandidates(snapshot, rule).map((item) => ({
        value: comparableTitle(item.value),
        source: item.source,
      }));
      const resolved = resolveTitleCandidates(canonicalTitles);
      return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
    }
    case "brand": return extractBrand(snapshot);
    case "productUrl": {
      const asin = parseAsinFromDetailUrl(snapshot.pageUrl);
      if (!asin) return field(rule, "missing", null, "amazon_us_product_url_not_bound");
      return field(rule, "observed", `https://www.amazon.com/dp/${asin}`, null, { selector: "@page.url" });
    }
    case "marketplace": {
      return field(rule, "missing", null, "validated_capture_context_required");
    }
    case "price":
    case "currency": {
      const resolved = resolvePrimaryPrice(snapshot, rule);
      if (resolved.status !== "observed" || !resolved.value) return field(rule, resolved.status, null, resolved.reason ?? "format_invalid", resolved.source);
      return field(rule, "observed", canonicalField === "price" ? resolved.value : resolved.value.currency, null, resolved.source);
    }
    case "rating": {
      const parsed = uniqueTextCandidates(snapshot, rule).map((item) => {
        const match = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(item.value);
        const value = match ? Number(match[1]) : null;
        return { value: value !== null && Number.isFinite(value) && value >= 0 && value <= 5 ? value : null, source: item.source };
      }).filter((item): item is { value: number; source: { selector: string; label: string | null } } => item.value !== null);
      const resolved = resolveOne(rule, parsed, (value) => String(value));
      return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
    }
    case "reviewCount": {
      const parsed = uniqueTextCandidates(snapshot, rule).map((item) => {
        const match = /^\s*\(?\s*([0-9][0-9,]*)/.exec(item.value);
        const value = match ? Number(match[1].replace(/,/g, "")) : null;
        return { value: value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null, source: item.source };
      }).filter((item): item is { value: number; source: { selector: string; label: string | null } } => item.value !== null);
      const resolved = resolveOne(rule, parsed, (value) => String(value));
      return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
    }
    case "bsrRanks": {
      const ranks = collectBsrRanks(snapshot);
      return field(rule, ranks.value.length > 0 ? "observed" : "missing", ranks.value, ranks.value.length > 0 ? null : "selector_not_found", ranks.source);
    }
    case "primaryBsr": return field(rule, "missing", null, "derived_after_bsr_ranks", { selector: "@bsrRanks", ruleVersion: AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION });
    case "subCategoryBsr": return field(rule, "missing", null, "derived_after_bsr_ranks", { selector: "@bsrRanks", ruleVersion: AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION });
    case "categoryPath":
    case "bulletPoints":
      return extractTextList(snapshot, canonicalField);
    case "mainImage": return extractImage(snapshot, "mainImage");
    case "galleryImages": return extractImage(snapshot, "galleryImages");
    case "dateFirstAvailable":
    case "material":
    case "packageDimensions":
    case "packageWeight":
    case "itemDimensions":
    case "itemWeight":
      return extractSpecText(snapshot, canonicalField);
    case "seller": return extractSeller(snapshot);
    case "shipsFrom": return extractShipsFrom(snapshot);
    case "fulfillment": return field(rule, "missing", null, "derived_after_source_fields", { selector: "@seller+shipsFrom", ruleVersion: "fulfillment.v1" });
    case "ratingDistribution": return extractRatingDistribution(snapshot);
    case "variations": return extractVariationOptions(snapshot);
    case "parentAsin": return field(rule, "missing", null, "derived_after_entity_binding");
    case "listPrice": {
      const parsed = candidatesFor(snapshot, rule).map((candidate) => ({
        value: parsePrice(valueFromCandidate(candidate)),
        source: { selector: candidate.selector, label: null },
      })).filter((item): item is { value: { amount: number; currency: "USD" }; source: { selector: string; label: null } } => Boolean(item.value));
      const resolved = resolveOne(rule, parsed, (value) => `${value.amount}|${value.currency}`);
      return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
    }
    case "coupon": return extractCoupon(snapshot);
    case "boughtPastMonth": return extractBoughtPastMonth(snapshot);
    case "rawSpecifications": return extractRawSpecifications(snapshot, expectedAsin);
    case "productDescription": {
      const resolved = resolveOne(rule, uniqueTextCandidates(snapshot, rule), (value) => value);
      return field(rule, resolved.status, resolved.value, resolved.reason, resolved.source);
    }
    case "aPlusPresence": {
      const present = candidatesFor(snapshot, rule).length > 0;
      return field(rule, "observed", present, null, present ? { selector: candidatesFor(snapshot, rule)[0]?.selector ?? null } : null);
    }
    case "fbaFee":
    case "estimatedMonthlySales":
    case "estimatedMonthlyRevenue":
      return field(rule, "blocked", null, "field_contract_blocked");
    default:
      return field(rule, "missing", null, "parser_not_implemented");
  }
}

function derivePrimaryBsr(registeredFields: Record<string, AmazonDetailRegisteredField>): void {
  const ranks = registeredFields.bsrRanks?.value;
  const rule = ruleFor("primaryBsr");
  if (!Array.isArray(ranks) || ranks.length === 0) {
    registeredFields.primaryBsr = field(rule, "missing", null, "no_valid_bsr_ranks", { selector: "@bsrRanks", ruleVersion: AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION });
    return;
  }
  const first = ranks[0] as { rank: number; category: string };
  registeredFields.primaryBsr = field(rule, "derived", { ...first, ruleVersion: AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION }, null, {
    selector: "@bsrRanks",
    label: first.category,
    ruleVersion: AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION,
  });
}

/**
 * Amazon 详情页把 Best Sellers Rank 按「根类目 → 小类目」顺序列出（如
 * `#666 in Beauty & Personal Care`、`#27 in Facial Serums`）。
 * `primaryBsr` 只取页面第一条（根类目），小类目排名此前被采集但没有投影；
 * 这里把「页面实际报告的、与根类目不同的第一条排名」派生为 `subCategoryBsr`。
 *
 * 该规则是确定性的：不猜类别、不跨页拼值、不在页面只报告单一排名时编造小类目排名 ——
 * 无小类目排名即 fail-closed 为 `missing`。
 */
function deriveSubCategoryBsr(registeredFields: Record<string, AmazonDetailRegisteredField>): void {
  const ranks = registeredFields.bsrRanks?.value;
  const rule = ruleFor("subCategoryBsr");
  if (!Array.isArray(ranks) || ranks.length === 0) {
    registeredFields.subCategoryBsr = field(rule, "missing", null, "no_valid_bsr_ranks", { selector: "@bsrRanks", ruleVersion: AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION });
    return;
  }
  const primary = ranks[0] as { rank: number; category: string };
  const subCategory = (ranks.slice(1) as Array<{ rank: number; category: string }>).find((item) =>
    typeof item?.category === "string" && item.category !== primary.category,
  );
  if (!subCategory) {
    registeredFields.subCategoryBsr = field(rule, "missing", null, "no_sub_category_rank", { selector: "@bsrRanks", ruleVersion: AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION });
    return;
  }
  registeredFields.subCategoryBsr = field(rule, "derived", { ...subCategory, ruleVersion: AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION }, null, {
    selector: "@bsrRanks",
    label: subCategory.category,
    ruleVersion: AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION,
  });
}

function deriveFulfillment(registeredFields: Record<string, AmazonDetailRegisteredField>): void {
  const rule = ruleFor("fulfillment");
  const seller = registeredFields.seller?.value;
  const shipsFrom = registeredFields.shipsFrom?.value;
  if (typeof seller !== "string" || typeof shipsFrom !== "string") {
    registeredFields.fulfillment = field(rule, "missing", null, "source_fields_unavailable", { selector: "@seller+shipsFrom", ruleVersion: "fulfillment.v1" });
    return;
  }
  const fulfillment = /\bamazon(?:\.com)?\b/i.test(shipsFrom)
    ? "amazon_fulfilled"
    : normalizeLabel(seller) === normalizeLabel(shipsFrom)
      ? "seller_fulfilled"
      : "other_fulfilled";
  registeredFields.fulfillment = field(rule, "derived", {
    value: fulfillment,
    derivedFrom: ["seller", "shipsFrom"],
    ruleVersion: "fulfillment.v1",
  }, null, { selector: "@seller+shipsFrom", label: `${seller} | ${shipsFrom}`, ruleVersion: "fulfillment.v1" });
}

function buildLegacyFields(registeredFields: Record<string, AmazonDetailRegisteredField>): AmazonDetailPageExtraction["fields"] {
  const read = (name: string): unknown => registeredFields[name]?.value;
  const valueFor = (name: string): string | number | null => {
    const value = read(name);
    if (typeof value === "string" || typeof value === "number") return value;
    if (value && typeof value === "object" && "amount" in value && typeof value.amount === "number") return value.amount;
    return null;
  };
  const bsr = read("primaryBsr");
  const primaryRank = bsr && typeof bsr === "object" && "rank" in bsr && typeof bsr.rank === "number" ? bsr.rank : null;
  const toLegacyField = (name: "asin" | "title" | "price" | "bsr" | "rating" | "reviews", canonical: string, value: string | number | null) => ({
    field: name,
    value,
    status: value === null ? "unknown" as const : "correct" as const,
    reason: value === null ? registeredFields[canonical]?.reason ?? "selector_not_found" : null,
  });
  return {
    asin: toLegacyField("asin", "asin", valueFor("asin")),
    title: toLegacyField("title", "title", valueFor("title")),
    price: toLegacyField("price", "price", valueFor("price")),
    bsr: toLegacyField("bsr", "primaryBsr", primaryRank),
    rating: toLegacyField("rating", "rating", valueFor("rating")),
    reviews: toLegacyField("reviews", "reviewCount", valueFor("reviewCount")),
  };
}

export function extractAmazonDetailPageV2(
  snapshot: AmazonDetailPageDomSnapshot,
  options: AmazonDetailPageExtractionV2Options,
): AmazonDetailPageExtractionV2 {
  const expectedAsin = normalizeAsin(options.expectedAsin);
  let pageUrl = snapshot.pageUrl;
  let urlAsin = parseAsinFromDetailUrl(pageUrl);
  let hostname = "";
  try {
    hostname = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    pageUrl = "";
    urlAsin = null;
  }
  const pageAsinCandidates = [
    ...(snapshot.candidates["input#ASIN"] ?? []),
    ...(snapshot.candidates["input[name='ASIN']"] ?? []),
    ...specRowsFor(snapshot, ["ASIN"]).map((row) => ({ selector: row.selector, text: row.text, value: row.value, label: row.label, href: null, src: null, alt: null, selected: null })),
  ].map((candidate) => normalizeAsin(candidate.value ?? candidate.text)).filter((value): value is string => Boolean(value));
  const distinctPageAsins = [...new Set(pageAsinCandidates)];
  const pageAsin = distinctPageAsins.length === 1 ? distinctPageAsins[0] : null;
  const productContainerFound = snapshot.productRootSelector !== null
    && candidatesFor(snapshot, ruleFor("title")).some((candidate) => Boolean(valueFromCandidate(candidate)));
  const urlMatchesExpected = expectedAsin !== null && urlAsin === expectedAsin;
  const pageAnchorMatchesExpected = expectedAsin !== null && pageAsin === expectedAsin && distinctPageAsins.length === 1;
  const safeEntityBound = snapshot.pageStatus === "ok"
    && (hostname === "www.amazon.com" || hostname === "amazon.com")
    && productContainerFound
    && urlMatchesExpected
    && pageAnchorMatchesExpected;
  const bindingReason = !safeEntityBound
    ? snapshot.pageStatus !== "ok"
      ? `page_status_${snapshot.pageStatus}`
      : !productContainerFound
        ? "product_container_not_found"
        : !urlMatchesExpected
          ? "url_asin_mismatch"
          : "page_asin_anchor_mismatch"
    : null;
  const registeredFields: Record<string, AmazonDetailRegisteredField> = {};
  for (const rule of AMAZON_DETAIL_FIELD_REGISTRY) {
    if (rule.fieldNature === "BLOCKED") {
      registeredFields[rule.canonicalField] = field(rule, "blocked", null, "field_contract_blocked");
    } else if (!safeEntityBound) {
      registeredFields[rule.canonicalField] = field(rule, "missing", null, "entity_binding_unproven");
    } else {
      registeredFields[rule.canonicalField] = extractFieldValue(snapshot, rule.canonicalField, expectedAsin ?? "");
    }
  }
  if (safeEntityBound) {
    const marketplaceRule = ruleFor("marketplace");
    registeredFields.marketplace = options.marketplace === "US"
      ? field(marketplaceRule, "observed", "US", null, { selector: "@us_preflight+amazon_com_host" })
      : field(marketplaceRule, "missing", null, "validated_capture_context_required");
    derivePrimaryBsr(registeredFields);
    deriveSubCategoryBsr(registeredFields);
    deriveFulfillment(registeredFields);
    registeredFields.parentAsin = parseParentAsin(snapshot, expectedAsin ?? "");
  }

  const fields = buildLegacyFields(registeredFields);
  return {
    schemaVersion: "amazon-detail-page-extraction.v1",
    extractorVersion: "amazon-detail-extractor.v2",
    fieldRegistryVersion: AMAZON_DETAIL_FIELD_REGISTRY_VERSION,
    expectedAsin,
    urlAsin,
    pageAsin,
    entityBound: safeEntityBound,
    bindingProof: {
      urlMatchesExpected,
      pageAnchorMatchesExpected,
      productContainerFound,
    },
    pageStatus: snapshot.pageStatus,
    fields,
    registeredFields,
    capturedAt: options.capturedAt,
    collectorVersion: options.collectorVersion,
  };
}
