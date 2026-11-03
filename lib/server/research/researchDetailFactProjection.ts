import type {
  FactField,
  FactFieldEvidenceRef,
  ProductFact,
  ProductFactSource,
  ProductFactSourceConflict,
  ProductFactVariationStructure,
  ProductItemDimensions,
  ProductPackageWeight,
  ProductPrice,
} from "@/lib/sourceLayer/fact/types";

export type ResearchDetailFactCitation = Pick<FactFieldEvidenceRef, "refId" | "source" | "capturedAt">;

export type ResearchDetailFactConflict = {
  field: string;
  code: ProductFactSourceConflict["code"];
  resolved: false;
  candidateSources: ProductFactSource[];
  candidates: {
    source: ProductFactSource;
    value: unknown;
    capturedAt: string | null;
    evidenceRefs: ResearchDetailFactCitation[];
  }[];
  evidenceRefs: ResearchDetailFactCitation[];
};

type ResearchDetailFactVariationStructure = Omit<ProductFactVariationStructure, "evidenceRefs"> & {
  evidenceRefs: ResearchDetailFactCitation[];
};

export type ResearchDetailFactProjection = {
  brand: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  bsr: number | null;
  fbaFee: ProductPrice | null;
  fbaFeeNature: "estimate" | "snapshot" | "derived" | "unknown";
  mainCategory: string | null;
  imageUrl: string | null;
  itemDimensions: ProductItemDimensions | null;
  itemWeight: ProductPackageWeight | null;
  material: string | null;
  bulletPoints: string[];
  sourceProof: {
    source: ProductFactSource;
    evidenceId: string;
    subjectKey: string;
    capturedAt: string;
  } | null;
  fieldEvidence: Partial<Record<
    "brand" | "price" | "rating" | "reviewCount" | "bsr" | "fbaFee" | "mainCategory" | "itemDimensions" | "itemWeight" | "material" | "bulletPoints" | "variationStructure",
    ResearchDetailFactCitation[]
  >>;
  conflicts: ResearchDetailFactConflict[];
  variationStructure: ResearchDetailFactVariationStructure | null;
};

const EMPTY_PROJECTION: ResearchDetailFactProjection = {
  brand: null,
  price: null,
  currency: null,
  rating: null,
  reviewCount: null,
  bsr: null,
  fbaFee: null,
  fbaFeeNature: "unknown",
  mainCategory: null,
  imageUrl: null,
  itemDimensions: null,
  itemWeight: null,
  material: null,
  bulletPoints: [],
  sourceProof: null,
  fieldEvidence: {},
  conflicts: [],
  variationStructure: null,
};

function presentValue<T>(field: FactField<T> | undefined): T | null {
  return field?.status === "present" ? field.value : null;
}

function preferredPresentValue<T>(...fields: Array<FactField<T> | undefined>): T | null {
  for (const field of fields) {
    const value = presentValue(field);
    if (value !== null) return value;
  }
  return null;
}

function safeCitation(reference: FactFieldEvidenceRef): ResearchDetailFactCitation | null {
  if (!reference || typeof reference.refId !== "string" || reference.refId.trim().length === 0
    || typeof reference.capturedAt !== "string" || !Number.isFinite(Date.parse(reference.capturedAt))) return null;
  return {
    refId: reference.refId.trim(),
    source: reference.source,
    capturedAt: new Date(reference.capturedAt).toISOString(),
  };
}

function citations(references: readonly FactFieldEvidenceRef[] | undefined): ResearchDetailFactCitation[] {
  if (!Array.isArray(references)) return [];
  const unique = new Map<string, ResearchDetailFactCitation>();
  for (const reference of references) {
    const citation = safeCitation(reference);
    if (citation && !unique.has(citation.refId)) unique.set(citation.refId, citation);
  }
  return [...unique.values()];
}

function uniqueCitations(references: readonly ResearchDetailFactCitation[]): ResearchDetailFactCitation[] {
  const unique = new Map<string, ResearchDetailFactCitation>();
  for (const reference of references) {
    if (reference.refId && !unique.has(reference.refId)) unique.set(reference.refId, reference);
  }
  return [...unique.values()];
}

function isReviewCountConflict(field: string): boolean {
  return field.trim().toLowerCase().replace(/[^a-z0-9]/gu, "").endsWith("reviewcount");
}

type FactDisplayField = keyof ResearchDetailFactProjection["fieldEvidence"];

const FACT_FIELD_ALIASES: Record<FactDisplayField, readonly string[]> = {
  brand: ["brand", "basic.brand"],
  price: ["price", "basic.price"],
  rating: ["rating", "basic.rating"],
  reviewCount: ["reviewCount", "basic.reviewCount"],
  bsr: ["bsr", "market.bsr", "primaryBsr"],
  fbaFee: ["fbaFee", "profit.fbaFee", "estimatedFbaFee"],
  mainCategory: ["category", "basic.category", "mainCategory"],
  itemDimensions: ["itemDimensions", "profit.itemDimensions", "extended.itemDimensions"],
  itemWeight: ["itemWeight", "profit.itemWeight", "extended.itemWeight"],
  material: ["material", "extended.material"],
  bulletPoints: ["bulletPoints", "basic.bulletPoints"],
  variationStructure: ["variationStructure", "extended.variationStructure", "variations"],
};

function conflictsForField(conflicts: readonly ResearchDetailFactConflict[], field: FactDisplayField): ResearchDetailFactConflict[] {
  const aliases = FACT_FIELD_ALIASES[field].map((alias) => alias.toLowerCase());
  return conflicts.filter((conflict) => {
    const name = conflict.field.trim().toLowerCase();
    return aliases.some((alias) => name === alias || name.endsWith(`.${alias}`));
  });
}

function fieldEvidenceFor(
  conflicts: readonly ResearchDetailFactConflict[],
  field: FactDisplayField,
  fieldReferences: readonly FactFieldEvidenceRef[] | undefined,
): ResearchDetailFactCitation[] {
  const matchingConflicts = conflictsForField(conflicts, field);
  if (matchingConflicts.length > 0) {
    return uniqueCitations(matchingConflicts.flatMap((conflict) => conflict.evidenceRefs));
  }
  return citations(fieldReferences);
}

function projectConflicts(productFact: ProductFact): ResearchDetailFactConflict[] {
  return (productFact.sourceConflicts ?? []).filter((conflict) => conflict.code === "SOURCE_CONFLICT_UNRESOLVED" && !conflict.resolved)
    .map((conflict) => ({
      field: conflict.field,
      code: conflict.code,
      resolved: false,
      candidateSources: [...new Set(conflict.candidates.map((candidate) => candidate.source))],
      candidates: conflict.candidates.map((candidate) => ({
        source: candidate.source,
        value: candidate.value,
        capturedAt: candidate.capturedAt && Number.isFinite(Date.parse(candidate.capturedAt))
          ? new Date(candidate.capturedAt).toISOString()
          : null,
        evidenceRefs: citations(candidate.evidenceRefs),
      })),
      evidenceRefs: citations(conflict.candidates.flatMap((candidate) => candidate.evidenceRefs)),
    }));
}

function projectVariationStructure(productFact: ProductFact, conflicts: readonly ResearchDetailFactConflict[]): ResearchDetailFactVariationStructure | null {
  if (conflictsForField(conflicts, "variationStructure").length > 0) return null;
  const structure = productFact.extended?.variationStructure;
  if (!structure || structure.subjectKey !== productFact.subjectKey || structure.subjectAsin !== presentValue(productFact.basic?.asin)) return null;
  const evidenceRefs = citations(structure.evidenceRefs);
  if (evidenceRefs.length === 0) return null;
  return { ...structure, evidenceRefs };
}

/**
 * Read-only ProductFact projection for the research detail response.
 * Item measurements stay separate from package measurements, unresolved values stay unknown,
 * and every displayed citation comes from the corresponding ProductFact field or variation proof.
 */
export function projectResearchDetailFacts(productFact: ProductFact | null | undefined): ResearchDetailFactProjection {
  if (!productFact) return EMPTY_PROJECTION;

  const conflicts = projectConflicts(productFact);
  const price = presentValue(productFact.basic?.price) as ProductPrice | null;
  const hasConflict = (field: FactDisplayField) => conflictsForField(conflicts, field).length > 0;
  const itemDimensions = hasConflict("itemDimensions")
    ? null
    : preferredPresentValue(productFact.extended?.itemDimensions, productFact.profit?.itemDimensions);
  const itemWeight = hasConflict("itemWeight")
    ? null
    : preferredPresentValue(productFact.extended?.itemWeight, productFact.profit?.itemWeight);
  const variationStructure = projectVariationStructure(productFact, conflicts);
  const sourceProof = productFact.sourceProof
    && typeof productFact.sourceProof.evidenceId === "string"
    && typeof productFact.sourceProof.subjectKey === "string"
    && typeof productFact.sourceProof.capturedAt === "string"
    && Number.isFinite(Date.parse(productFact.sourceProof.capturedAt))
    ? {
        source: productFact.sourceProof.source,
        evidenceId: productFact.sourceProof.evidenceId,
        subjectKey: productFact.sourceProof.subjectKey,
        capturedAt: new Date(productFact.sourceProof.capturedAt).toISOString(),
      }
    : null;

  const fieldEvidence: ResearchDetailFactProjection["fieldEvidence"] = {
    brand: fieldEvidenceFor(conflicts, "brand", productFact.basic?.brand?.evidenceRefs),
    price: fieldEvidenceFor(conflicts, "price", productFact.basic?.price?.evidenceRefs),
    rating: fieldEvidenceFor(conflicts, "rating", productFact.basic?.rating?.evidenceRefs),
    reviewCount: fieldEvidenceFor(conflicts, "reviewCount", productFact.basic?.reviewCount?.evidenceRefs),
    bsr: fieldEvidenceFor(conflicts, "bsr", productFact.market?.bsr?.evidenceRefs),
    fbaFee: fieldEvidenceFor(conflicts, "fbaFee", productFact.profit?.fbaFee?.evidenceRefs),
    mainCategory: fieldEvidenceFor(conflicts, "mainCategory", productFact.basic?.category?.evidenceRefs),
    itemDimensions: fieldEvidenceFor(conflicts, "itemDimensions", productFact.extended?.itemDimensions?.status === "present"
      ? productFact.extended.itemDimensions.evidenceRefs
      : productFact.profit?.itemDimensions?.evidenceRefs),
    itemWeight: fieldEvidenceFor(conflicts, "itemWeight", productFact.extended?.itemWeight?.status === "present"
      ? productFact.extended.itemWeight.evidenceRefs
      : productFact.profit?.itemWeight?.evidenceRefs),
    material: fieldEvidenceFor(conflicts, "material", productFact.extended?.material?.evidenceRefs),
    bulletPoints: fieldEvidenceFor(conflicts, "bulletPoints", productFact.basic?.bulletPoints?.evidenceRefs),
    ...(variationStructure ? { variationStructure: variationStructure.evidenceRefs } : conflictsForField(conflicts, "variationStructure").length > 0
      ? { variationStructure: fieldEvidenceFor(conflicts, "variationStructure", undefined) }
      : {}),
  };

  const reviewCountConflicted = hasConflict("reviewCount") || conflicts.some((conflict) => isReviewCountConflict(conflict.field));

  return {
    brand: hasConflict("brand") ? null : presentValue(productFact.basic?.brand),
    price: hasConflict("price") ? null : price?.amount ?? null,
    currency: hasConflict("price") ? null : price?.currency ?? null,
    rating: hasConflict("rating") ? null : presentValue(productFact.basic?.rating),
    reviewCount: reviewCountConflicted ? null : presentValue(productFact.basic?.reviewCount),
    bsr: hasConflict("bsr") ? null : presentValue(productFact.market?.bsr),
    fbaFee: hasConflict("fbaFee") ? null : presentValue(productFact.profit?.fbaFee),
    fbaFeeNature: hasConflict("fbaFee") ? "unknown" : productFact.profit?.fbaFee?.metricNature ?? "unknown",
    mainCategory: hasConflict("mainCategory") ? null : presentValue(productFact.basic?.category),
    imageUrl: presentValue(productFact.basic?.image),
    itemDimensions,
    itemWeight,
    material: hasConflict("material") ? null : presentValue(productFact.extended?.material),
    bulletPoints: hasConflict("bulletPoints") ? [] : [...(presentValue(productFact.basic?.bulletPoints) ?? [])],
    sourceProof,
    fieldEvidence,
    conflicts,
    variationStructure,
  };
}
