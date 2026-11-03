import "server-only";

import { hashJson } from "@/lib/server/v5CanonicalHash";
import {
  parseSourceEvidenceAttachment,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";
import {
  type FactField,
  type FactFieldEvidenceRef,
  type ProductFact,
  type ProductFactSourceConflict,
  type ProductFactVariationStructure,
  type ProductItemDimensions,
  type ProductPrice,
} from "@/lib/sourceLayer/fact/types";
import { parseV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { projectVariationEvidence } from "@/lib/server/research/variationEvidenceProjection";
import { projectSellerSpriteSupplement } from "@/lib/sourceLayer/sellerSpriteSupplementProjection";
import {
  AMAZON_DETAIL_FIELD_REGISTRY_VERSION,
  AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION,
  AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION,
  getAmazonDetailFieldRule,
} from "@/tools/collectors/amazon/detail-page-field-registry";

type RegisteredField = {
  readonly canonicalField: string;
  readonly priority: string;
  readonly fieldNature: string;
  readonly status: string;
  readonly value: unknown;
  readonly reason: string | null;
  readonly sourceTrace: Record<string, unknown>;
  readonly candidateDiagnosticsTruncatedCount?: number;
};

type ValidDetail = {
  readonly attachment: SourceEvidenceAttachment;
  readonly fields: Readonly<Record<string, RegisteredField>>;
};

const SUBJECT_PATTERN = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/u;
const ITEM_WEIGHT_UNITS = new Set(["kg", "lb", "oz", "g"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isoEqual(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function latestAttachment(attachments: readonly SourceEvidenceAttachment[], kind: string): SourceEvidenceAttachment | null {
  const candidates = attachments.filter((item) => item.kind === kind);
  if (candidates.length === 0) return null;
  if (candidates.some((item) => !Number.isFinite(Date.parse(item.capturedAt)))) return null;
  return [...candidates].sort((left, right) => {
    const order = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
    return order || right.attachmentId.localeCompare(left.attachmentId);
  })[0] ?? null;
}

function validateDetailAttachment(
  raw: unknown,
  expectedSubject: string,
  expectedAsin: string,
  expectedMarketplace: string,
): ValidDetail | null {
  const attachment = parseSourceEvidenceAttachment(raw);
  if (!attachment
    || attachment.kind !== "v3_amazon_detail_v1"
    || attachment.sourceType !== "amazon_dom"
    || attachment.subjectKey !== expectedSubject) return null;
  const parsed = parseV3ModuleEvidence(attachment.payload);
  if (!parsed
    || parsed.module !== "amazon_detail"
    || parsed.subjectKey !== expectedSubject
    || parsed.marketplace !== expectedMarketplace
    || parsed.identity.asin !== expectedAsin
    || parsed.metricNature !== "source_observed"
    || parsed.status !== "VALIDATED_AVAILABLE"
    || parsed.evidenceOnly !== true
    || parsed.acquisitionMode !== "DOM_DIRECT"
    || parsed.provider !== "Amazon"
    || typeof parsed.sourceUrl !== "string"
    || parsed.sourceUrl !== attachment.sourceUrl
    || !/^https:\/\/(?:www\.)?amazon\.com\//iu.test(parsed.sourceUrl)
    || !isoEqual(parsed.capturedAt, attachment.capturedAt)) return null;

  const data = parsed.data;
  if (!isRecord(data.registeredFields)) return null;
  const fields: Record<string, RegisteredField> = {};
  for (const [name, rawField] of Object.entries(data.registeredFields)) {
    if (!isRecord(rawField) || !isRecord(rawField.sourceTrace)) continue;
    fields[name] = rawField as unknown as RegisteredField;
  }
  return { attachment, fields };
}

function fieldValue(detail: ValidDetail, name: string): unknown | null {
  const field = detail.fields[name];
  const rule = getAmazonDetailFieldRule(name);
  if (!field || !rule || rule.targetStorage === null || rule.priority === "BLOCKED"
    || !["DIRECT_FACT", "DERIVED_FACT", "CONDITIONAL_FACT"].includes(rule.fieldNature)
    || field.canonicalField !== name
    || field.priority !== rule.priority
    || field.fieldNature !== rule.fieldNature
    || field.status !== (rule.fieldNature === "DERIVED_FACT" ? "derived" : "observed")
    || field.reason !== null
    || field.sourceTrace.ruleId !== name
    || field.sourceTrace.registryVersion !== AMAZON_DETAIL_FIELD_REGISTRY_VERSION
    || field.sourceTrace.region !== rule.pageRegion) return null;

  const expectedRuleVersion = name === "primaryBsr" ? AMAZON_DETAIL_PRIMARY_BSR_RULE_VERSION
    : name === "subCategoryBsr" ? AMAZON_DETAIL_SUB_CATEGORY_BSR_RULE_VERSION
      : name === "fulfillment" ? "fulfillment.v1" : null;
  if (expectedRuleVersion !== null && field.sourceTrace.ruleVersion !== expectedRuleVersion) return null;
  if (expectedRuleVersion === null && field.sourceTrace.ruleVersion !== null) return null;
  if (field.candidateDiagnosticsTruncatedCount !== undefined
    && (!Number.isSafeInteger(field.candidateDiagnosticsTruncatedCount) || Number(field.candidateDiagnosticsTruncatedCount) > 0)) return null;
  return field.value;
}

function textField(detail: ValidDetail, name: string): string | null {
  const value = fieldValue(detail, name);
  return nonEmptyText(value) ? value.trim() : null;
}

function textListField(detail: ValidDetail, name: string, maxItems = 30): readonly string[] | null {
  const value = fieldValue(detail, name);
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems
    || !value.every((item) => nonEmptyText(item, 1_000))) return null;
  return value.map((item) => (item as string).trim());
}

function reviewCountField(detail: ValidDetail): number | null {
  const value = fieldValue(detail, "reviewCount");
  return isNonNegativeInteger(value) ? value : null;
}

function bsrRanksField(detail: ValidDetail): readonly { rank: number; category: string }[] | null {
  const value = fieldValue(detail, "bsrRanks");
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) return null;
  const ranks: { rank: number; category: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isPositiveNumber(entry.rank) || !Number.isSafeInteger(entry.rank)
      || !nonEmptyText(entry.category, 240)) return null;
    ranks.push({ rank: entry.rank, category: entry.category.trim() });
  }
  return ranks;
}

function derivedRankField(detail: ValidDetail, name: "primaryBsr" | "subCategoryBsr", ranks: readonly { rank: number; category: string }[] | null): { rank: number; category: string } | null {
  const value = fieldValue(detail, name);
  if (!isRecord(value) || !isPositiveNumber(value.rank) || !Number.isSafeInteger(value.rank)
    || !nonEmptyText(value.category, 240)) return null;
  const matchingRank = ranks?.some((rank) => rank.rank === value.rank && rank.category === value.category);
  if (!matchingRank) return null;
  return { rank: value.rank, category: value.category.trim() };
}

function dimensionsField(detail: ValidDetail): ProductItemDimensions | null {
  const value = fieldValue(detail, "itemDimensions");
  if (!isRecord(value) || !nonEmptyText(value.rawText, 180)
    || !Array.isArray(value.dimensions) || ![2, 3].includes(value.dimensions.length)
    || !value.dimensions.every(isPositiveNumber)
    || (value.unit !== "cm" && value.unit !== "in")) return null;
  return {
    length: value.dimensions[0] as number,
    width: value.dimensions[1] as number,
    ...(value.dimensions.length > 2 ? { height: value.dimensions[2] as number } : {}),
    unit: value.unit,
  };
}

function itemWeightField(detail: ValidDetail): { value: number; unit: "kg" | "lb" | "oz" | "g" } | null {
  const value = fieldValue(detail, "itemWeight");
  if (!isRecord(value) || !nonEmptyText(value.rawText, 180) || !isPositiveNumber(value.amount)
    || typeof value.unit !== "string" || !ITEM_WEIGHT_UNITS.has(value.unit)) return null;
  return { value: value.amount, unit: value.unit as "kg" | "lb" | "oz" | "g" };
}

function listPriceField(detail: ValidDetail, productFact: ProductFact): ProductPrice | null {
  const value = fieldValue(detail, "listPrice");
  if (!isRecord(value) || !isPositiveNumber(value.amount) || value.currency !== "USD") return null;
  const currentCurrency = productFact.basic.price.value?.currency;
  if (currentCurrency && currentCurrency.toUpperCase() !== value.currency) return null;
  return { amount: value.amount, currency: value.currency };
}

function galleryImagesField(detail: ValidDetail): readonly string[] | null {
  const values = textListField(detail, "galleryImages", 40);
  if (!values || !values.every((url) => amazonImageUrl(url) !== null)) return null;
  return values;
}

function mainImageField(detail: ValidDetail): string | null {
  const value = textField(detail, "mainImage");
  if (!value) return null;
  return amazonImageUrl(value) ? value : null;
}

function fulfillmentField(detail: ValidDetail, seller: string | null, shipsFrom: string | null): string | null {
  const value = fieldValue(detail, "fulfillment");
  if (!seller || !shipsFrom || !isRecord(value) || !nonEmptyText(value.value, 80)
    || value.ruleVersion !== "fulfillment.v1"
    || !Array.isArray(value.derivedFrom)
    || value.derivedFrom.join(",") !== "seller,shipsFrom") return null;
  return value.value.trim();
}

function attachmentRef(attachment: SourceEvidenceAttachment): FactFieldEvidenceRef {
  return {
    refId: `attachment:${attachment.attachmentId}`,
    source: "amazon_dom",
    captureId: attachment.attachmentId,
    evidenceId: attachment.attachmentId,
    subjectKey: attachment.subjectKey,
    capturedAt: new Date(attachment.capturedAt).toISOString(),
    contentHash: attachment.contentHash,
    sourceUrl: attachment.sourceUrl,
  };
}

function productProofRef(productFact: ProductFact): FactFieldEvidenceRef {
  const proof = productFact.sourceProof;
  return {
    refId: `evidence:${proof.evidenceId}`,
    source: proof.source,
    captureId: proof.captureId,
    evidenceId: proof.evidenceId,
    subjectKey: proof.subjectKey,
    capturedAt: proof.capturedAt,
    contentHash: proof.contentHash,
    sourceUrl: proof.sourceUrl,
  };
}

function uniqueRefs(refs: readonly FactFieldEvidenceRef[]): FactFieldEvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.refId}|${ref.contentHash}|${ref.capturedAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function amazonImageUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isAmazonImageHost = hostname === "media-amazon.com"
      || hostname.endsWith(".media-amazon.com")
      || hostname === "images-amazon.com"
      || hostname.endsWith(".images-amazon.com");
    return url.protocol === "https:" && isAmazonImageHost ? url : null;
  } catch {
    return null;
  }
}

function amazonImageAssetIdentity(value: unknown): string | null {
  const url = amazonImageUrl(value);
  return url?.pathname.replace(/\._AC_[a-z0-9,_-]+(?=\.[^./]+$)/iu, "") ?? null;
}

function sameAmazonImageAsset(left: unknown, right: unknown): boolean {
  const leftIdentity = amazonImageAssetIdentity(left);
  return leftIdentity !== null && leftIdentity === amazonImageAssetIdentity(right);
}

function projectedField<T>(input: {
  readonly value: T;
  readonly fieldNature: "DIRECT_FACT" | "DERIVED_FACT" | "CONDITIONAL_FACT";
  readonly attachment: SourceEvidenceAttachment;
}): FactField<T> {
  return {
    value: input.value,
    status: "present",
    metricNature: input.fieldNature === "DERIVED_FACT" ? "derived" : "snapshot",
    source: "amazon_dom",
    confidence: 1,
    capturedAt: input.attachment.capturedAt,
    rawProofHash: input.attachment.contentHash,
    evidenceRefs: [attachmentRef(input.attachment)],
  };
}

function mergeField<T>(input: {
  readonly fieldPath: string;
  readonly current: FactField<T> | undefined;
  readonly incoming: FactField<T>;
  readonly proof: FactFieldEvidenceRef;
  readonly equivalent?: (left: T, right: T) => boolean;
}): { field: FactField<T>; conflict: ProductFactSourceConflict | null } {
  const { current, incoming, proof, fieldPath, equivalent } = input;
  if (!current || current.status === "missing" || current.value === null) return { field: incoming, conflict: null };

  const existingRefs = current.evidenceRefs?.length ? [...current.evidenceRefs] : [proof];
  const incomingRef = incoming.evidenceRefs?.[0];
  const equivalentValues = current.value !== null && incoming.value !== null
    && Boolean(equivalent?.(current.value, incoming.value));
  if (hashJson(current.value) === hashJson(incoming.value) || equivalentValues) {
    return { field: { ...current, evidenceRefs: uniqueRefs([...existingRefs, ...(incomingRef ? [incomingRef] : [])]) }, conflict: null };
  }

  const refs = uniqueRefs([...existingRefs, ...(incomingRef ? [incomingRef] : [])]);
  const conflict: ProductFactSourceConflict = {
    field: fieldPath,
    code: "SOURCE_CONFLICT_UNRESOLVED",
    resolved: false,
    candidates: [
      { source: current.source, value: current.value, capturedAt: current.capturedAt, evidenceRefs: existingRefs },
      { source: incoming.source, value: incoming.value, capturedAt: incoming.capturedAt, evidenceRefs: incoming.evidenceRefs ?? [] },
    ],
  };
  return {
    field: {
      value: null,
      status: "missing",
      metricNature: "unknown",
      source: incoming.source,
      confidence: 0,
      capturedAt: incoming.capturedAt,
      rawProofHash: incoming.rawProofHash,
      evidenceRefs: refs,
    },
    conflict,
  };
}

function parseVariation(attachments: readonly SourceEvidenceAttachment[], subjectKey: string, asin: string): ProductFactVariationStructure | null {
  const rawLatest = latestAttachment(attachments, "v3_variation_v1");
  if (!rawLatest) return null;
  const latest = parseSourceEvidenceAttachment(rawLatest);
  if (!latest) return null;
  const projection = projectVariationEvidence([latest], subjectKey);
  if (projection.subjectAsin !== asin
    || !["complete", "no_variation_with_evidence"].includes(projection.outcome)
    || projection.completeness === "unavailable"
    || projection.evidenceRefs.length !== 1) return null;
  const refs = projection.evidenceRefs.map((ref) => ({
    refId: ref.refId,
    source: ref.source,
    captureId: ref.captureId,
    evidenceId: ref.evidenceId,
    subjectKey: ref.subjectKey,
    capturedAt: ref.capturedAt,
    contentHash: ref.contentHash,
    sourceUrl: ref.sourceUrl,
  }));
  return {
    schemaVersion: "product-fact-variation-structure.v1",
    subjectKey,
    subjectAsin: asin,
    outcome: projection.outcome as "complete" | "no_variation_with_evidence",
    completeness: projection.completeness as "complete" | "none",
    parentAsin: projection.parentAsin,
    memberAsins: projection.memberAsins,
    members: projection.members.map(({ asin: memberAsin, options }) => ({ asin: memberAsin, options })),
    relations: projection.relations.map(({ fromAsin, toAsin, relation }) => ({ fromAsin, toAsin, relation })),
    evidenceRefs: refs,
    limitation: projection.limitation,
  };
}

/** Merge only validated, same-subject Amazon detail and variation attachments into a verified ProductFact. */
export function projectProductFactEvidence(
  productFact: ProductFact,
  rawAttachments: readonly SourceEvidenceAttachment[],
): ProductFact {
  const subject = SUBJECT_PATTERN.exec(productFact.subjectKey);
  const asin = productFact.basic.asin.value?.toUpperCase();
  if (!subject || subject[2] !== asin || subject[1] !== subject[1].toUpperCase()) return productFact;
  const proofRef = productProofRef(productFact);
  const attachments = rawAttachments.filter((attachment) => attachment.subjectKey === productFact.subjectKey
    || attachment.kind === "v3_amazon_detail_v1" || attachment.kind === "v3_variation_v1");
  const latestRawDetail = latestAttachment(attachments, "v3_amazon_detail_v1");
  const detail = latestRawDetail
    ? validateDetailAttachment(latestRawDetail, productFact.subjectKey, asin, subject[1]!)
    : null;
  const conflicts: ProductFactSourceConflict[] = [...(productFact.sourceConflicts ?? [])];
  const basic: Record<string, unknown> = { ...productFact.basic };
  const market: Record<string, unknown> = { ...productFact.market };
  const profit: Record<string, unknown> = { ...productFact.profit };
  const extended: Record<string, unknown> = { ...(productFact.extended ?? {}) };

  const apply = <T>(
    group: Record<string, unknown>,
    key: string,
    path: string,
    incoming: FactField<T>,
    equivalent?: (left: T, right: T) => boolean,
  ) => {
    const merged = mergeField({ fieldPath: path, current: group[key] as FactField<T> | undefined, incoming, proof: proofRef, equivalent });
    group[key] = merged.field;
    if (merged.conflict) conflicts.push(merged.conflict);
    return merged.field;
  };

  if (detail) {
    const ranks = bsrRanksField(detail);
    const primaryBsr = derivedRankField(detail, "primaryBsr", ranks);
    const subCategoryBsr = derivedRankField(detail, "subCategoryBsr", ranks);
    const seller = textField(detail, "seller");
    const shipsFrom = textField(detail, "shipsFrom");
    const fulfillment = fulfillmentField(detail, seller, shipsFrom);
    const brand = textField(detail, "brand");
    const reviewCount = reviewCountField(detail);
    const categoryPath = textListField(detail, "categoryPath", 16);
    const bulletPoints = textListField(detail, "bulletPoints", 20);
    const material = textField(detail, "material");
    const itemDimensions = dimensionsField(detail);
    const itemWeight = itemWeightField(detail);
    const galleryImages = galleryImagesField(detail);
    const mainImage = mainImageField(detail);
    const rawListPrice = listPriceField(detail, productFact);
    const values = [
      ["brand", brand], ["reviewCount", reviewCount], ["categoryPath", categoryPath], ["bulletPoints", bulletPoints],
      ["material", material], ["itemDimensions", itemDimensions], ["itemWeight", itemWeight], ["seller", seller],
      ["shipsFrom", shipsFrom], ["fulfillment", fulfillment], ["galleryImages", galleryImages], ["mainImage", mainImage],
      ["listPrice", rawListPrice], ["bsrRanks", ranks], ["primaryBsr", primaryBsr], ["subCategoryBsr", subCategoryBsr],
    ] as const;
    for (const [name, value] of values) {
      if (value === null) continue;
      const sourceField = detail.fields[name];
      if (!sourceField) continue;
      const nature = sourceField.fieldNature as "DIRECT_FACT" | "DERIVED_FACT" | "CONDITIONAL_FACT";
      const incoming = projectedField({ value, fieldNature: nature, attachment: detail.attachment });
      switch (name) {
        case "brand": apply(basic, "brand", "basic.brand", incoming); break;
        case "reviewCount": apply(basic, "reviewCount", "basic.reviewCount", incoming); break;
        case "categoryPath": apply(extended, "categoryPath", "extended.categoryPath", incoming); break;
        case "bulletPoints": apply(basic, "bulletPoints", "basic.bulletPoints", incoming); break;
        case "material": apply(extended, "material", "extended.material", incoming); break;
        case "itemDimensions": {
          const merged = apply(profit, "itemDimensions", "profit.itemDimensions", incoming);
          extended.itemDimensions = merged;
          break;
        }
        case "itemWeight": {
          const merged = apply(profit, "itemWeight", "profit.itemWeight", incoming);
          extended.itemWeight = merged;
          break;
        }
        case "seller": apply(extended, "seller", "extended.seller", incoming); break;
        case "shipsFrom": apply(extended, "shipsFrom", "extended.shipsFrom", incoming); break;
        case "fulfillment": apply(extended, "fulfillment", "extended.fulfillment", incoming); break;
        case "galleryImages": apply(extended, "galleryImageUrls", "extended.galleryImageUrls", incoming); break;
        case "mainImage": apply(basic, "image", "basic.image", incoming, sameAmazonImageAsset); break;
        case "listPrice": apply(extended, "listPrice", "extended.listPrice", incoming); break;
        case "bsrRanks": apply(extended, "bsrRanks", "extended.bsrRanks", incoming); break;
        case "primaryBsr": {
          apply(market, "bsr", "market.bsr", projectedField({ value: (value as { rank: number }).rank, fieldNature: nature, attachment: detail.attachment }));
          apply(basic, "category", "basic.category", projectedField({ value: (value as { category: string }).category, fieldNature: nature, attachment: detail.attachment }));
          break;
        }
        case "subCategoryBsr": apply(market, "subCategoryBsr", "market.subCategoryBsr", projectedField({ value: (value as { rank: number }).rank, fieldNature: nature, attachment: detail.attachment })); break;
      }
    }
  }

  const supplement = latestAttachment(attachments.filter((a) => a.subjectKey === productFact.subjectKey), "v3_sellersprite_product_market_v1");
  const estimatedFee = supplement ? projectSellerSpriteSupplement(supplement)?.fbaFee : null;
  if (supplement && estimatedFee) {
    const incoming: FactField<ProductPrice> = {
      value: estimatedFee, status: "present", metricNature: "estimate", source: "sellersprite_plugin", confidence: 1,
      capturedAt: supplement.capturedAt, rawProofHash: supplement.contentHash,
      evidenceRefs: [{ refId: `attachment:${supplement.attachmentId}`, source: "sellersprite_plugin", captureId: supplement.attachmentId, evidenceId: supplement.attachmentId, subjectKey: supplement.subjectKey, capturedAt: supplement.capturedAt, contentHash: supplement.contentHash, sourceUrl: supplement.sourceUrl ?? null }],
    };
    apply(profit, "fbaFee", "profit.fbaFee", incoming);
  }

  const variation = parseVariation(attachments, productFact.subjectKey, asin);
  if (variation) {
    extended.variationStructure = variation;
    if (variation.parentAsin) {
      const parentRef = variation.evidenceRefs[0]!;
      const parentField: FactField<string> = {
        value: variation.parentAsin,
        status: "present",
        metricNature: "snapshot",
        source: "amazon_dom",
        confidence: 1,
        capturedAt: parentRef.capturedAt,
        rawProofHash: parentRef.contentHash,
        evidenceRefs: [parentRef],
      };
      apply(extended, "parentAsin", "extended.parentAsin", parentField);
    }
  }

  return {
    ...productFact,
    ...(conflicts.length ? { sourceConflicts: conflicts } : {}),
    basic: basic as ProductFact["basic"],
    market: market as ProductFact["market"],
    profit: profit as ProductFact["profit"],
    extended: Object.keys(extended).length ? extended as ProductFact["extended"] : productFact.extended,
  };
}
