import type { ProductFact } from "@/lib/sourceLayer/fact/types";

export const V5_MARKET_CANDIDATE_V1_SCHEMA = "v5-market-candidate.v1" as const;
export const V5_MARKET_CANDIDATE_V2_SCHEMA = "v5-market-candidate.v2" as const;
export const V5_MARKET_CANDIDATE_V3_SCHEMA = "v5-market-candidate.v3" as const;

export type V5MarketCandidateSchema =
  | typeof V5_MARKET_CANDIDATE_V1_SCHEMA
  | typeof V5_MARKET_CANDIDATE_V2_SCHEMA
  | typeof V5_MARKET_CANDIDATE_V3_SCHEMA;

export type V5MarketCandidateEvidenceReadiness = "READY" | "NOT_CAPTURED" | "PENDING_RECOVERY";

export type V5MarketCandidateEvidenceBinding = {
  readonly subjectKey: string;
  readonly evidenceId: string;
  readonly captureId: string | null;
  readonly evidenceVersion: number | null;
  readonly contentHash: string;
  readonly evidenceRefs: readonly string[];
  readonly readiness: V5MarketCandidateEvidenceReadiness;
};

export type V5MarketCandidateLegacyCapture = {
  readonly version?: number | null;
  readonly evidenceId?: string | null;
  readonly contentHash?: string | null;
  readonly subjectKey?: string | null;
};

export type V5MarketCandidateProvenance = {
  readonly scanId: string;
  readonly marketScanId?: string;
  readonly marketSampleKey: string;
  readonly sampleHash: string;
  readonly metricsVersion?: string;
  readonly marketDecisionStatus?: string;
  readonly role?: string;
  readonly representativeNote?: string | null;
  readonly opportunityResearch?: import("./opportunityResearch").OpportunityResearchSnapshot;
};

export type V5MarketCandidateIdentity = {
  readonly asin: string;
  readonly title: string;
  readonly marketplace: string;
};

export type V5MarketCandidateV2Meta = {
  readonly schema: typeof V5_MARKET_CANDIDATE_V2_SCHEMA;
  readonly asin: string;
  readonly identity: V5MarketCandidateIdentity;
  readonly marketplace: string;
  readonly provenance: readonly V5MarketCandidateProvenance[];
  readonly marketProvenance: V5MarketCandidateProvenance;
  readonly sourceLayerCapture?: V5MarketCandidateLegacyCapture;
  readonly factHash: string;
  readonly evidenceHash: string;
  readonly productFact?: ProductFact | null;
  readonly productFactRecovery?: Record<string, unknown>;
  readonly [key: string]: unknown;
};

export type V5MarketCandidateV3Meta = {
  readonly schema: typeof V5_MARKET_CANDIDATE_V3_SCHEMA;
  readonly asin: string;
  readonly identity: V5MarketCandidateIdentity;
  readonly marketplace: string;
  readonly provenance: readonly V5MarketCandidateProvenance[];
  readonly marketProvenance: V5MarketCandidateProvenance;
  readonly sourceLayerCapture: V5MarketCandidateLegacyCapture;
  readonly evidenceBinding: V5MarketCandidateEvidenceBinding;
  readonly evidenceRefs: readonly string[];
  readonly factHash: string;
  readonly evidenceHash: string;
  readonly productFact?: ProductFact | null;
  readonly productFactRecovery?: Record<string, unknown>;
  readonly [key: string]: unknown;
};

export type V5MarketCandidateMeta =
  | V5MarketCandidateV2Meta
  | V5MarketCandidateV3Meta;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isV5MarketCandidateMeta(value: unknown): value is V5MarketCandidateMeta {
  if (!isRecord(value)) return false;
  return (
    value.schema === V5_MARKET_CANDIDATE_V3_SCHEMA ||
    value.schema === V5_MARKET_CANDIDATE_V2_SCHEMA ||
    value.schema === V5_MARKET_CANDIDATE_V1_SCHEMA
  );
}

/**
 * 统一从 Candidate 元数据中提取或规范化 EvidenceBinding。
 * 兼容 v3（优先直接读取 evidenceBinding）与 v2/v1（从 sourceLayerCapture 降级映射）。
 */
export function extractCandidateEvidenceBinding(meta: unknown): V5MarketCandidateEvidenceBinding | null {
  if (!isRecord(meta)) return null;

  if (isRecord(meta.evidenceBinding)) {
    const b = meta.evidenceBinding;
    const subjectKey = typeof b.subjectKey === "string" ? b.subjectKey.trim() : "";
    const evidenceId = typeof b.evidenceId === "string" ? b.evidenceId.trim() : "";
    const captureId = typeof b.captureId === "string" ? b.captureId.trim() : null;
    const evidenceVersion = typeof b.evidenceVersion === "number" ? b.evidenceVersion : null;
    const contentHash = typeof b.contentHash === "string" ? b.contentHash.trim() : "";
    const evidenceRefs = Array.isArray(b.evidenceRefs)
      ? (b.evidenceRefs.filter((r): r is string => typeof r === "string" && r.trim().length > 0) as string[])
      : (evidenceId ? [`evidence:${evidenceId}`] : []);
    const readiness: V5MarketCandidateEvidenceReadiness =
      b.readiness === "READY" || b.readiness === "NOT_CAPTURED" || b.readiness === "PENDING_RECOVERY"
        ? b.readiness
        : (evidenceId ? "READY" : "NOT_CAPTURED");

    if (subjectKey || evidenceId || contentHash) {
      return {
        subjectKey,
        evidenceId,
        captureId,
        evidenceVersion,
        contentHash,
        evidenceRefs,
        readiness,
      };
    }
  }

  // v3 must never downgrade a missing/malformed authoritative binding to legacy fields.
  if (meta.schema === V5_MARKET_CANDIDATE_V3_SCHEMA || "evidenceBinding" in meta) return null;

  // 降级回退兼容 v2 / v1 或仅含 sourceLayerCapture / productFact.sourceProof 的旧候选
  const slc = isRecord(meta.sourceLayerCapture) ? meta.sourceLayerCapture : null;
  const proof = isRecord(meta.productFact) && isRecord(meta.productFact.sourceProof)
    ? (meta.productFact.sourceProof as Record<string, unknown>)
    : null;

  if (slc || proof) {
    const identity = isRecord(meta.identity) ? meta.identity : {};
    const asin = (typeof identity.asin === "string" ? identity.asin : typeof meta.asin === "string" ? meta.asin : "").trim().toUpperCase();
    const marketplace = (typeof identity.marketplace === "string" ? identity.marketplace : typeof meta.marketplace === "string" ? meta.marketplace : "US").trim().toUpperCase();
    const subjectKey = typeof slc?.subjectKey === "string" && slc.subjectKey.trim()
      ? slc.subjectKey.trim()
      : (typeof proof?.subjectKey === "string" && proof.subjectKey.trim()
          ? proof.subjectKey.trim()
          : (asin ? `amazon:${marketplace}:${asin}` : ""));
    const evidenceId = typeof slc?.evidenceId === "string" && slc.evidenceId.trim()
      ? slc.evidenceId.trim()
      : (typeof proof?.evidenceId === "string" && proof.evidenceId.trim() ? proof.evidenceId.trim() : "");
    const captureId = typeof slc?.captureId === "string" && slc.captureId.trim()
      ? slc.captureId.trim()
      : (typeof proof?.captureId === "string" && proof.captureId.trim() ? proof.captureId.trim() : null);
    const evidenceVersion = typeof slc?.version === "number"
      ? slc.version
      : (typeof proof?.evidenceVersion === "number" ? proof.evidenceVersion : null);
    const contentHash = typeof slc?.contentHash === "string" && slc.contentHash.trim()
      ? slc.contentHash.trim()
      : (typeof proof?.contentHash === "string" && proof.contentHash.trim() ? proof.contentHash.trim() : "");
    const evidenceRefs = evidenceId ? [`evidence:${evidenceId}`] : [];

    return {
      subjectKey,
      evidenceId,
      captureId,
      evidenceVersion,
      contentHash,
      evidenceRefs,
      readiness: evidenceId ? "READY" : "NOT_CAPTURED",
    };
  }

  return null;
}

/**
 * 构造标准规范的 EvidenceBinding 结构。
 */
export function buildV5MarketCandidateEvidenceBinding(input: {
  readonly subjectKey: string;
  readonly evidenceId?: string | null;
  readonly captureId?: string | null;
  readonly evidenceVersion?: number | null;
  readonly contentHash?: string | null;
  readonly evidenceRefs?: readonly string[];
  readonly readiness?: V5MarketCandidateEvidenceReadiness;
}): V5MarketCandidateEvidenceBinding {
  const evidenceId = input.evidenceId?.trim() || "";
  const contentHash = input.contentHash?.trim() || "";
  const evidenceRefs = input.evidenceRefs && input.evidenceRefs.length > 0
    ? input.evidenceRefs
    : (evidenceId ? [`evidence:${evidenceId}`] : []);
  const readiness: V5MarketCandidateEvidenceReadiness = input.readiness ?? (evidenceId ? "READY" : "NOT_CAPTURED");

  return {
    subjectKey: input.subjectKey,
    evidenceId,
    captureId: input.captureId ?? null,
    evidenceVersion: typeof input.evidenceVersion === "number" ? input.evidenceVersion : null,
    contentHash,
    evidenceRefs,
    readiness,
  };
}

/**
 * 构造标准规范的 v5-market-candidate.v3 元数据对象。
 * 统一字段映射，保证与 EvidenceStore、ResearchInputBundle 以及历史 v2 数据的无缝兼容。
 */
export function buildV5MarketCandidateV3Meta(input: {
  readonly existingSourceMeta?: Record<string, unknown> | null;
  readonly asin: string;
  readonly title: string;
  readonly marketplace: string;
  readonly provenance?: readonly V5MarketCandidateProvenance[];
  readonly marketProvenance: V5MarketCandidateProvenance;
  readonly sourceLayerCapture?: V5MarketCandidateLegacyCapture;
  readonly evidenceBinding: V5MarketCandidateEvidenceBinding;
  readonly evidenceRefs?: readonly string[];
  readonly factHash: string;
  readonly evidenceHash: string;
}): V5MarketCandidateV3Meta {
  const existing = input.existingSourceMeta ?? {};
  const evidenceRefs = input.evidenceRefs && input.evidenceRefs.length > 0
    ? input.evidenceRefs
    : input.evidenceBinding.evidenceRefs;

  const provenance = input.provenance ?? (Array.isArray(existing.provenance) ? (existing.provenance as V5MarketCandidateProvenance[]) : []);
  const nextProvenance = [
    ...provenance.filter(
      (entry) =>
        !(
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).scanId === input.marketProvenance.scanId &&
          (entry as Record<string, unknown>).marketSampleKey === input.marketProvenance.marketSampleKey
        ),
    ),
    input.marketProvenance,
  ];

  return {
    ...existing,
    schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
    asin: input.asin,
    identity: {
      ...(isRecord(existing.identity) ? existing.identity : {}),
      asin: input.asin,
      title: input.title,
      marketplace: input.marketplace,
    },
    marketplace: input.marketplace,
    provenance: nextProvenance,
    marketProvenance: input.marketProvenance,
    sourceLayerCapture: input.sourceLayerCapture ?? {
      version: input.evidenceBinding.evidenceVersion,
      evidenceId: input.evidenceBinding.evidenceId,
      contentHash: input.evidenceBinding.contentHash,
      subjectKey: input.evidenceBinding.subjectKey,
    },
    evidenceBinding: input.evidenceBinding,
    evidenceRefs,
    factHash: input.factHash,
    evidenceHash: input.evidenceHash,
  };
}

export type CandidateFactBindingVerification =
  | { readonly valid: true; readonly binding: V5MarketCandidateEvidenceBinding | null }
  | { readonly valid: false; readonly code: string; readonly message: string; readonly binding?: V5MarketCandidateEvidenceBinding | null };

/**
 * 校验 Candidate 元数据中绑定的证据契约与其实际携带的 ProductFact 是否严格一致。
 * 1. 旧无 namespace 的 Candidate 可使用 sourceProof 引用，由只读服务回读 EvidenceStore 校验。
 *    v1/v2/v3 声明的 binding 缺失或不完整必须拒绝，不降级到另一引用。
 * 2. 若候选包含 evidenceBinding 或 legacy sourceLayerCapture：
 *    - readiness === "NOT_CAPTURED" → fail-closed (EVIDENCE_NOT_CAPTURED)
 *    - subjectKey 不匹配 → fail-closed (SUBJECT_MISMATCH)
 *    - evidenceId 不匹配 → fail-closed (EVIDENCE_ID_MISMATCH)
 *    - contentHash 不匹配 → fail-closed (CONTENT_HASH_MISMATCH)
 *    - version 不匹配 → fail-closed (VERSION_MISMATCH)
 */
export function verifyCandidateFactBinding(input: {
  readonly meta: unknown;
  readonly productFact: ProductFact;
}): CandidateFactBindingVerification {
  if (isRecord(input.meta) && isRecord(input.meta.evidenceBinding)
    && !["READY", "NOT_CAPTURED", "PENDING_RECOVERY"].includes(String(input.meta.evidenceBinding.readiness))) {
    return { valid: false, code: "EVIDENCE_BINDING_INCOMPLETE", message: "候选证据就绪状态不合法。" };
  }
  const binding = extractCandidateEvidenceBinding(input.meta);
  if (!binding) {
    if (isRecord(input.meta) && (isV5MarketCandidateMeta(input.meta) || "evidenceBinding" in input.meta || "sourceLayerCapture" in input.meta)) {
      return { valid: false, code: "EVIDENCE_BINDING_MISSING", message: "候选证据绑定缺失，必须显式恢复后重试。", binding: null };
    }
    return { valid: true, binding: null };
  }

  if (binding.readiness !== "READY") {
    return {
      valid: false,
      code: "EVIDENCE_NOT_CAPTURED",
      message: "候选商品声明证据尚未采集就绪 (readiness = NOT_CAPTURED)。",
      binding,
    };
  }

  if (!binding.subjectKey || !binding.evidenceId || !binding.contentHash
    || (binding.evidenceVersion !== null && (!Number.isSafeInteger(binding.evidenceVersion) || Number(binding.evidenceVersion) < 1))) {
    return { valid: false, code: "EVIDENCE_BINDING_INCOMPLETE", message: "候选证据绑定不完整。", binding };
  }

  const proof = input.productFact.sourceProof;

  if (binding.subjectKey && input.productFact.subjectKey !== binding.subjectKey) {
    return {
      valid: false,
      code: "SUBJECT_MISMATCH",
      message: `候选证据主体不匹配: 期望 "${binding.subjectKey}", 实际 "${input.productFact.subjectKey}"。`,
      binding,
    };
  }

  if (binding.evidenceId && proof.evidenceId !== binding.evidenceId) {
    return {
      valid: false,
      code: "EVIDENCE_ID_MISMATCH",
      message: `候选证据 ID 不匹配: 期望 "${binding.evidenceId}", 实际 "${proof.evidenceId}"。`,
      binding,
    };
  }

  if (binding.captureId !== null && proof.captureId !== binding.captureId) {
    return { valid: false, code: "CAPTURE_ID_MISMATCH", message: "候选采集绑定不一致。", binding };
  }

  if (binding.contentHash && proof.contentHash !== binding.contentHash) {
    return {
      valid: false,
      code: "CONTENT_HASH_MISMATCH",
      message: `候选证据内容哈希不匹配: 期望 "${binding.contentHash}", 实际 "${proof.contentHash}"。`,
      binding,
    };
  }

  if (
    typeof binding.evidenceVersion === "number" &&
    typeof (proof as Record<string, unknown>).version === "number" &&
    (proof as Record<string, unknown>).version !== binding.evidenceVersion
  ) {
    return {
      valid: false,
      code: "VERSION_MISMATCH",
      message: `候选证据版本不匹配: 期望 "${binding.evidenceVersion}", 实际 "${(proof as Record<string, unknown>).version}"。`,
      binding,
    };
  }

  return { valid: true, binding };
}
