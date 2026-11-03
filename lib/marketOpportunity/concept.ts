export const PRODUCT_CONCEPT_SCHEMA = "product-concept.v1" as const;
export const PRODUCT_PROJECT_EXPORT_SCHEMA = "product-project.v1" as const;

export const CONCEPT_HUMAN_DECISIONS = ["UNREVIEWED", "APPROVE", "VALIDATE_MORE", "PAUSE", "DROP"] as const;
export type ConceptHumanDecisionStatus = (typeof CONCEPT_HUMAN_DECISIONS)[number];
export const CONCEPT_PROJECT_SYNC_STATUSES = ["NOT_SYNCED", "SYNCED", "FAILED"] as const;
export type ConceptProjectSyncStatus = (typeof CONCEPT_PROJECT_SYNC_STATUSES)[number];

export type ConceptRange = {
  readonly status: "CONFIRMED" | "DERIVED" | "MISSING";
  readonly min: number | null;
  readonly max: number | null;
  readonly currency: string | null;
  readonly refs: readonly string[];
};

export type ConceptFactRef = {
  readonly kind: "market_scan" | "research";
  readonly refId: string;
  readonly path: string;
};

export type ProductConceptSourceBinding = {
  readonly sourceType: "research_v5";
  readonly subjectKey: string;
  readonly researchTaskId: string;
  readonly researchRevision: number;
  readonly reportHash: string;
  readonly factHash: string;
  readonly evidenceHash: string;
  readonly generatedAt: string;
};

export type ProductConceptTraceableItem = {
  readonly id: string;
  readonly kind:
    | "confirmed_fact"
    | "research_summary"
    | "research_opportunity"
    | "research_risk"
    | "research_voc_pain"
    | "research_voc_positive"
    | "research_voc_failure"
    | "research_voc_use_case"
    | "research_voc_replacement"
    | "research_voc_switch"
    | "research_voc_ownership"
    | "assumption";
  readonly text: string;
  readonly nature: "confirmed_fact" | "derived" | "recommendation" | "assumption";
  readonly evidenceRefs: readonly string[];
  readonly validationRequired: boolean;
};

export type ProductConceptHumanDecision = {
  readonly status: ConceptHumanDecisionStatus;
  readonly reason: string | null;
  readonly decidedAt: string | null;
  readonly revision: number;
  readonly source?: {
    readonly kind: "feishu_hub";
    readonly baseId: string;
    readonly recordId: string;
    readonly reviewerIdentity: string;
    readonly reviewedAt: string;
    readonly packetHash: string;
  };
};

export type ProductConceptSnapshot = {
  readonly schemaVersion: typeof PRODUCT_CONCEPT_SCHEMA;
  readonly status: "READY" | "FAILED";
  readonly conceptId: string;
  /** V4 concepts bind an opportunity; V5 research concepts deliberately have no opportunity ID. */
  readonly opportunityId: string | null;
  readonly sourceBinding?: ProductConceptSourceBinding;
  readonly researchOpportunities?: readonly string[];
  readonly traceableItems?: readonly ProductConceptTraceableItem[];
  readonly revision: number;
  readonly generatedAt: string;
  readonly targetCustomer: string | null;
  readonly useCases: readonly string[];
  readonly primaryPainPoints: readonly string[];
  readonly recommendedSpecs: readonly string[];
  readonly differentiation: readonly string[];
  readonly targetPriceRange: ConceptRange;
  readonly targetCostRange: ConceptRange;
  readonly marginAssumptions: string | null;
  readonly packagingDirection: readonly string[];
  readonly supplierFeasibility: string | null;
  readonly complianceRequirements: readonly string[];
  readonly risks: readonly string[];
  readonly missingValidation: readonly string[];
  readonly factRefs: readonly ConceptFactRef[];
  readonly researchRefs: readonly ConceptFactRef[];
  readonly assumptions: readonly string[];
  readonly confirmedFacts: readonly string[];
  readonly derived: readonly string[];
  readonly missing: readonly string[];
  readonly aiSummary: string | null;
  readonly model: string | null;
  readonly errorCode?: string;
  readonly humanDecision: ProductConceptHumanDecision;
};

export type ProductProjectSync = {
  readonly status: ConceptProjectSyncStatus;
  readonly exportContractVersion: typeof PRODUCT_PROJECT_EXPORT_SCHEMA;
  readonly conceptId: string | null;
  readonly tableId: string | null;
  readonly recordId: string | null;
  readonly viewUrl: string | null;
  readonly syncedAt: string | null;
  readonly idempotencyKey: string | null;
  readonly errorCode?: string;
};

export class ProductConceptContractError extends Error {
  constructor(public readonly code: "invalid" | "decision_invalid", message: string) {
    super(message);
    this.name = "ProductConceptContractError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,160}$/u;
const LIST_MAX = 80;
const TEXT_MAX = 4_000;
const DECISION_SET = new Set<string>(CONCEPT_HUMAN_DECISIONS);
const SYNC_SET = new Set<string>(CONCEPT_PROJECT_SYNC_STATUSES);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, label: string, max = TEXT_MAX, nullable = false): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new ProductConceptContractError("invalid", `${label} 必须是文本。`);
  }
  if (typeof value !== "string") throw new ProductConceptContractError("invalid", `${label} 必须是文本。`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized && nullable) return null;
  if (!normalized || normalized.length > max) throw new ProductConceptContractError("invalid", `${label} 长度不合法。`);
  return normalized;
}

function iso(value: unknown, label: string): string {
  const result = stringValue(value, label, 80);
  if (!result || Number.isNaN(Date.parse(result))) throw new ProductConceptContractError("invalid", `${label} 必须是合法时间。`);
  return new Date(result).toISOString();
}

function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > LIST_MAX) throw new ProductConceptContractError("invalid", `${label} 必须是有限数组。`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`, 1_000) as string);
}

function ids(value: unknown, label: string): string[] {
  return list(value, label).map((item) => {
    if (!ID.test(item)) throw new ProductConceptContractError("invalid", `${label} 含不合法 ID。`);
    return item;
  });
}

function range(value: unknown, label: string): ConceptRange {
  if (!object(value)) throw new ProductConceptContractError("invalid", `${label} 必须是对象。`);
  if (value.status !== "CONFIRMED" && value.status !== "DERIVED" && value.status !== "MISSING") {
    throw new ProductConceptContractError("invalid", `${label}.status 不受支持。`);
  }
  const min = value.min === null ? null : typeof value.min === "number" && Number.isFinite(value.min) ? value.min : null;
  const max = value.max === null ? null : typeof value.max === "number" && Number.isFinite(value.max) ? value.max : null;
  if (value.min !== null && min === null || value.max !== null && max === null) {
    throw new ProductConceptContractError("invalid", `${label} 范围数值不合法。`);
  }
  if (min !== null && max !== null && min > max) throw new ProductConceptContractError("invalid", `${label} 范围顺序不合法。`);
  return {
    status: value.status,
    min,
    max,
    currency: stringValue(value.currency, `${label}.currency`, 12, true),
    refs: ids(value.refs, `${label}.refs`),
  };
}

function refs(value: unknown, label: string): ConceptFactRef[] {
  if (!Array.isArray(value) || value.length > LIST_MAX) throw new ProductConceptContractError("invalid", `${label} 不合法。`);
  return value.map((raw, index) => {
    if (!object(raw) || (raw.kind !== "market_scan" && raw.kind !== "research")) {
      throw new ProductConceptContractError("invalid", `${label}[${index}] 不合法。`);
    }
    const refId = stringValue(raw.refId, `${label}[${index}].refId`, 160);
    if (!refId || !ID.test(refId)) throw new ProductConceptContractError("invalid", `${label}[${index}].refId 不合法。`);
    return { kind: raw.kind, refId, path: stringValue(raw.path, `${label}[${index}].path`, 240) as string };
  });
}

function sourceBinding(value: unknown): ProductConceptSourceBinding | undefined {
  if (value === undefined || value === null) return undefined;
  if (!object(value) || value.sourceType !== "research_v5") {
    throw new ProductConceptContractError("invalid", "产品概念 Research V5 来源绑定不合法。");
  }
  const subjectKey = stringValue(value.subjectKey, "sourceBinding.subjectKey", 80);
  const researchTaskId = stringValue(value.researchTaskId, "sourceBinding.researchTaskId", 160);
  const researchRevision = value.researchRevision;
  const hash = (raw: unknown, label: string) => {
    const text = stringValue(raw, label, 64);
    if (!text || !/^[a-f0-9]{64}$/u.test(text)) throw new ProductConceptContractError("invalid", `${label} 必须是 SHA-256。`);
    return text;
  };
  if (!/^amazon:[A-Z]{2}:[A-Z0-9]{10}$/u.test(subjectKey ?? "")
    || !researchTaskId || !ID.test(researchTaskId)
    || !Number.isSafeInteger(researchRevision) || (researchRevision as number) < 1) {
    throw new ProductConceptContractError("invalid", "产品概念 Research V5 身份绑定不合法。");
  }
  return {
    sourceType: "research_v5",
    subjectKey: subjectKey as string,
    researchTaskId: researchTaskId as string,
    researchRevision: researchRevision as number,
    reportHash: hash(value.reportHash, "sourceBinding.reportHash"),
    factHash: hash(value.factHash, "sourceBinding.factHash"),
    evidenceHash: hash(value.evidenceHash, "sourceBinding.evidenceHash"),
    generatedAt: iso(value.generatedAt, "sourceBinding.generatedAt"),
  };
}

function traceableItems(value: unknown): ProductConceptTraceableItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 300) throw new ProductConceptContractError("invalid", "traceableItems 必须是有限数组。");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!object(raw)
      || ![
        "confirmed_fact",
        "research_summary",
        "research_opportunity",
        "research_risk",
        "research_voc_pain",
        "research_voc_positive",
        "research_voc_failure",
        "research_voc_use_case",
        "research_voc_replacement",
        "research_voc_switch",
        "research_voc_ownership",
        "assumption",
      ].includes(String(raw.kind))
      || !["confirmed_fact", "derived", "recommendation", "assumption"].includes(String(raw.nature))
      || typeof raw.validationRequired !== "boolean") {
      throw new ProductConceptContractError("invalid", `traceableItems[${index}] 不合法。`);
    }
    const id = stringValue(raw.id, `traceableItems[${index}].id`, 160);
    if (!id || !ID.test(id) || seen.has(id)) throw new ProductConceptContractError("invalid", "traceableItems 含重复或不合法 ID。");
    seen.add(id);
    const evidenceRefs = list(raw.evidenceRefs, `traceableItems[${index}].evidenceRefs`);
    if (evidenceRefs.some((ref) => !/^(?:evidence|attachment|trend):[A-Za-z0-9_-]{1,160}$/u.test(ref))) {
      throw new ProductConceptContractError("invalid", `traceableItems[${index}] 含不合法 evidenceRef。`);
    }
    if (raw.nature !== "assumption" && evidenceRefs.length === 0) {
      throw new ProductConceptContractError("invalid", `traceableItems[${index}] 缺少 evidenceRef。`);
    }
    return {
      id,
      kind: raw.kind as ProductConceptTraceableItem["kind"],
      text: stringValue(raw.text, `traceableItems[${index}].text`, 1_000) as string,
      nature: raw.nature as ProductConceptTraceableItem["nature"],
      evidenceRefs,
      validationRequired: raw.validationRequired,
    };
  });
}

export function parseProductConceptHumanDecision(value: unknown): ProductConceptHumanDecision {
  if (!object(value) || typeof value.status !== "string" || !DECISION_SET.has(value.status)) {
    throw new ProductConceptContractError("decision_invalid", "产品概念人工决策状态不受支持。");
  }
  const revision = value.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new ProductConceptContractError("decision_invalid", "产品概念 revision 不合法。");
  const source = value.source === undefined ? undefined : (() => {
    if (!object(value.source) || value.source.kind !== "feishu_hub"
      || typeof value.source.baseId !== "string" || !ID.test(value.source.baseId)
      || typeof value.source.recordId !== "string" || !ID.test(value.source.recordId)
      || typeof value.source.reviewerIdentity !== "string" || !ID.test(value.source.reviewerIdentity)
      || typeof value.source.packetHash !== "string" || !/^[a-f0-9]{64}$/iu.test(value.source.packetHash)) {
      throw new ProductConceptContractError("decision_invalid", "产品概念人工决策来源无效。");
    }
    return {
      kind: "feishu_hub" as const,
      baseId: value.source.baseId,
      recordId: value.source.recordId,
      reviewerIdentity: value.source.reviewerIdentity,
      reviewedAt: iso(value.source.reviewedAt, "产品概念.humanDecision.source.reviewedAt"),
      packetHash: value.source.packetHash.toLowerCase(),
    };
  })();
  return {
    status: value.status as ConceptHumanDecisionStatus,
    reason: stringValue(value.reason, "产品概念.reason", TEXT_MAX, true),
    decidedAt: value.decidedAt === null ? null : iso(value.decidedAt, "产品概念.decidedAt"),
    revision: revision as number,
    ...(source ? { source } : {}),
  };
}

export function buildInitialProductConceptHumanDecision(): ProductConceptHumanDecision {
  return { status: "UNREVIEWED", reason: null, decidedAt: null, revision: 0 };
}

export function parseProductConcept(value: unknown): ProductConceptSnapshot {
  if (!object(value) || value.schemaVersion !== PRODUCT_CONCEPT_SCHEMA) {
    throw new ProductConceptContractError("invalid", "产品概念版本不受支持。");
  }
  if (value.status !== "READY" && value.status !== "FAILED") throw new ProductConceptContractError("invalid", "产品概念 status 不受支持。");
  const conceptId = stringValue(value.conceptId, "conceptId", 160);
  const opportunityId = value.opportunityId === null || value.opportunityId === undefined
    ? null
    : stringValue(value.opportunityId, "opportunityId", 160);
  const binding = sourceBinding(value.sourceBinding);
  if (!conceptId || !ID.test(conceptId) || opportunityId !== null && !ID.test(opportunityId)
    || opportunityId === null && !binding) throw new ProductConceptContractError("invalid", "产品概念身份不合法。");
  const revision = value.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new ProductConceptContractError("invalid", "产品概念 revision 不合法。");
  return {
    schemaVersion: PRODUCT_CONCEPT_SCHEMA,
    status: value.status,
    conceptId,
    opportunityId,
    ...(binding ? { sourceBinding: binding } : {}),
    ...(value.researchOpportunities === undefined ? {} : { researchOpportunities: list(value.researchOpportunities, "researchOpportunities") }),
    ...(value.traceableItems === undefined ? {} : { traceableItems: traceableItems(value.traceableItems) }),
    revision: revision as number,
    generatedAt: iso(value.generatedAt, "产品概念.generatedAt"),
    targetCustomer: stringValue(value.targetCustomer, "targetCustomer", TEXT_MAX, true),
    useCases: list(value.useCases, "useCases"),
    primaryPainPoints: list(value.primaryPainPoints, "primaryPainPoints"),
    recommendedSpecs: list(value.recommendedSpecs, "recommendedSpecs"),
    differentiation: list(value.differentiation, "differentiation"),
    targetPriceRange: range(value.targetPriceRange, "targetPriceRange"),
    targetCostRange: range(value.targetCostRange, "targetCostRange"),
    marginAssumptions: stringValue(value.marginAssumptions, "marginAssumptions", TEXT_MAX, true),
    packagingDirection: list(value.packagingDirection, "packagingDirection"),
    supplierFeasibility: stringValue(value.supplierFeasibility, "supplierFeasibility", TEXT_MAX, true),
    complianceRequirements: list(value.complianceRequirements, "complianceRequirements"),
    risks: list(value.risks, "risks"),
    missingValidation: list(value.missingValidation, "missingValidation"),
    factRefs: refs(value.factRefs, "factRefs"),
    researchRefs: refs(value.researchRefs, "researchRefs"),
    assumptions: list(value.assumptions, "assumptions"),
    confirmedFacts: list(value.confirmedFacts, "confirmedFacts"),
    derived: list(value.derived, "derived"),
    missing: list(value.missing, "missing"),
    aiSummary: stringValue(value.aiSummary, "aiSummary", TEXT_MAX, true),
    model: stringValue(value.model, "model", 200, true),
    ...(value.errorCode === undefined ? {} : { errorCode: stringValue(value.errorCode, "errorCode", 160) as string }),
    humanDecision: parseProductConceptHumanDecision(value.humanDecision),
  };
}

export function parseProductProjectSync(value: unknown): ProductProjectSync {
  if (!object(value) || typeof value.status !== "string" || !SYNC_SET.has(value.status)) {
    throw new ProductConceptContractError("invalid", "产品项目同步状态不受支持。");
  }
  if (value.exportContractVersion !== PRODUCT_PROJECT_EXPORT_SCHEMA) throw new ProductConceptContractError("invalid", "产品项目导出版本不受支持。");
  return {
    status: value.status as ConceptProjectSyncStatus,
    exportContractVersion: PRODUCT_PROJECT_EXPORT_SCHEMA,
    conceptId: value.conceptId === null ? null : stringValue(value.conceptId, "conceptId", 160, true),
    tableId: stringValue(value.tableId, "tableId", 200, true),
    recordId: stringValue(value.recordId, "recordId", 200, true),
    viewUrl: stringValue(value.viewUrl, "viewUrl", 2_048, true),
    syncedAt: value.syncedAt === null || value.syncedAt === undefined ? null : iso(value.syncedAt, "syncedAt"),
    idempotencyKey: stringValue(value.idempotencyKey, "idempotencyKey", 200, true),
    ...(value.errorCode === undefined ? {} : { errorCode: stringValue(value.errorCode, "errorCode", 160) as string }),
  };
}

export function buildInitialProductProjectSync(): ProductProjectSync {
  return {
    status: "NOT_SYNCED",
    exportContractVersion: PRODUCT_PROJECT_EXPORT_SCHEMA,
    conceptId: null,
    tableId: null,
    recordId: null,
    viewUrl: null,
    syncedAt: null,
    idempotencyKey: null,
  };
}
