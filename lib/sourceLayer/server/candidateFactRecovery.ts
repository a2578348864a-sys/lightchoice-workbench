import "server-only";

import { prisma } from "@/lib/server/db";
import type { AccessContext } from "@/lib/server/accessPassword";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import {
  adaptEvidenceToProductFact,
  productFactSourceFromCaptureSource,
  type ProductFact,
} from "@/lib/sourceLayer/fact";
import { V5_MARKET_CANDIDATE_V3_SCHEMA } from "@/lib/marketScan/candidateContract";

export class CandidateFactRecoveryError extends Error {
  constructor(
    public readonly code:
      | "candidate_not_found"
      | "owner_only_required"
      | "asin_missing"
      | "evidence_not_found"
      | "evidence_binding_stale"
      | "evidence_not_passed",
    message: string,
  ) {
    super(message);
    this.name = "CandidateFactRecoveryError";
  }
}

export type CandidateFactRecoveryResult = {
  readonly candidateId: string;
  readonly asin: string;
  readonly productFact: ProductFact;
  readonly alreadyAttached: boolean;
};

/**
 * 将 EvidenceStore 中真实存在的 Evidence 投影为 ProductFact 并安全附加到已有 Candidate。
 *
 * 严格遵守以下准则：
 * 1. 只复用 ProductFactAdapter，不手工映射事实；
 * 2. 事实完全来自 EvidenceStore，严禁 AI 生成事实；
 * 3. 严格不创建新的 Candidate（杜绝重复商品）；
 * 4. 幂等执行（相同 contentHash 不重复覆盖）；
 * 5. 不改动 Prisma Schema。
 */
export async function attachProductFactToExistingCandidate(input: {
  readonly candidateId: string;
  readonly context: AccessContext;
}): Promise<CandidateFactRecoveryResult> {
  if (input.context.mode !== "owner") {
    throw new CandidateFactRecoveryError(
      "owner_only_required",
      "只有 Owner 可以恢复正式 Candidate 商品事实。",
    );
  }

  const candidate = await prisma.opportunityCandidate.findUnique({
    where: { id: input.candidateId },
  });
  if (!candidate) {
    throw new CandidateFactRecoveryError(
      "candidate_not_found",
      `Candidate ${input.candidateId} 不存在。`,
    );
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(candidate.sourceMetaJson);
  } catch {
    meta = {};
  }

  const asin: string | null =
    (typeof (meta?.identity as Record<string, unknown> | undefined)?.asin === "string"
      ? (meta.identity as Record<string, unknown>).asin as string
      : null) ||
    (candidate.link ? (candidate.link.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] : null) ||
    null;

  if (!asin) {
    throw new CandidateFactRecoveryError(
      "asin_missing",
      `Candidate ${input.candidateId} 缺少有效 ASIN。`,
    );
  }

  const identity = meta.identity as Record<string, unknown> | undefined;
  const marketplace = (typeof identity?.marketplace === "string" ? identity.marketplace : typeof meta.marketplace === "string" ? meta.marketplace : "US").trim().toUpperCase();
  const bindingSubjectKey = typeof (meta.evidenceBinding as Record<string, unknown> | undefined)?.subjectKey === "string" && (meta.evidenceBinding as Record<string, unknown>).subjectKey
    ? String((meta.evidenceBinding as Record<string, unknown>).subjectKey).trim()
    : null;
  const subjectKey = bindingSubjectKey || `amazon:${marketplace}:${asin.trim().toUpperCase()}`;
  const store = createEvidenceStore("owner:v1");
  const subject = await store.getSubject(subjectKey);
  if (!subject || subject.versions.length === 0) {
    throw new CandidateFactRecoveryError(
      "evidence_not_found",
      `商品 ${subjectKey} 在 EvidenceStore 中未找到证据。`,
    );
  }

  // 优先匹配 evidenceBinding / sourceLayerCapture 中的版本与证据 ID，否则使用最新 passed 版本
  const evidenceBinding = meta?.evidenceBinding as Record<string, unknown> | undefined;
  const sourceLayerCapture = meta?.sourceLayerCapture as Record<string, unknown> | undefined;

  const targetVersion = typeof evidenceBinding?.evidenceVersion === "number"
    ? evidenceBinding.evidenceVersion
    : typeof sourceLayerCapture?.version === "number"
    ? sourceLayerCapture.version
    : null;

  const targetContentHash = typeof evidenceBinding?.contentHash === "string" && evidenceBinding.contentHash.trim()
    ? evidenceBinding.contentHash.trim()
    : typeof sourceLayerCapture?.contentHash === "string" && sourceLayerCapture.contentHash.trim()
    ? sourceLayerCapture.contentHash.trim()
    : null;

  const targetEvidenceId = typeof evidenceBinding?.evidenceId === "string" && evidenceBinding.evidenceId.trim()
    ? evidenceBinding.evidenceId.trim()
    : typeof sourceLayerCapture?.evidenceId === "string" && sourceLayerCapture.evidenceId.trim()
    ? sourceLayerCapture.evidenceId.trim()
    : null;

  let versionEvidence = targetVersion !== null
    ? subject.versions.find((v) => v.version === targetVersion && (!targetEvidenceId || v.evidenceId === targetEvidenceId))
    : null;
  if (!versionEvidence && targetVersion !== null) {
    versionEvidence = subject.versions.find((v) => v.version === targetVersion) ?? null;
  }
  if (!versionEvidence && targetEvidenceId) {
    versionEvidence = subject.versions.find((v) => v.evidenceId === targetEvidenceId) ?? null;
  }

  if ((targetVersion !== null || targetContentHash !== null) && (!versionEvidence
    || (targetContentHash !== null && versionEvidence.contentHash !== targetContentHash))) {
    throw new CandidateFactRecoveryError("evidence_binding_stale", "绑定的证据版本已缺失或变化，未回退到另一份证据，请重新确认来源。");
  }
  const passedEvidences = subject.versions.filter(
    (v) => v.validation?.verdict === "passed" && v.validation?.readyForResearch === true,
  );
  const evidence = (targetVersion !== null || targetEvidenceId !== null)
    ? (versionEvidence?.validation.verdict === "passed" && versionEvidence.validation.readyForResearch ? versionEvidence : undefined)
    : passedEvidences.at(-1);

  if (!evidence) {
    throw new CandidateFactRecoveryError(
      "evidence_not_passed",
      `商品 ${subjectKey} 没有已通过校验的有效 Evidence。`,
    );
  }

  const productFact = adaptEvidenceToProductFact({
    evidence,
    source: productFactSourceFromCaptureSource(evidence.sourceType),
  });

  // 幂等性检查：若已有相同 contentHash 的 productFact，无需更新
  const existingFact = meta.productFact as ProductFact | undefined;
  if (existingFact && existingFact.sourceProof?.contentHash === productFact.sourceProof.contentHash) {
    return {
      candidateId: candidate.id,
      asin,
      productFact: existingFact,
      alreadyAttached: true,
    };
  }

  meta.productFact = productFact;
  meta.productFactRecovery = { strategy: targetVersion === null && targetEvidenceId === null ? "latest_passed_unbound" : "exact_binding",
    requestedVersion: targetVersion, resolvedVersion: evidence.version, resolvedContentHash: evidence.contentHash,
    integrityIssues: subject.integrityIssues ?? [],
  };

  meta.evidenceBinding = {
    ...(typeof meta.evidenceBinding === "object" && meta.evidenceBinding !== null ? meta.evidenceBinding : {}),
    subjectKey: evidence.subjectKey,
    evidenceId: evidence.evidenceId,
    captureId: evidence.captureId,
    evidenceVersion: evidence.version,
    contentHash: evidence.contentHash,
    evidenceRefs: [
      `evidence:${evidence.evidenceId}`,
      ...(Array.isArray(evidenceBinding?.evidenceRefs)
        ? (evidenceBinding!.evidenceRefs as unknown[]).filter((r): r is string => typeof r === "string" && r !== `evidence:${evidence.evidenceId}`)
        : []),
    ],
    readiness: "READY",
  };

  meta.evidenceRefs = [
    `evidence:${evidence.evidenceId}`,
    ...(Array.isArray(meta.evidenceRefs)
      ? (meta.evidenceRefs as unknown[]).filter((r): r is string => typeof r === "string" && r !== `evidence:${evidence.evidenceId}`)
      : []),
  ];

  if (sourceLayerCapture) {
    meta.sourceLayerCapture = {
      ...sourceLayerCapture,
      version: evidence.version,
      evidenceId: evidence.evidenceId,
      contentHash: evidence.contentHash,
      subjectKey: evidence.subjectKey,
    };
  }

  await prisma.opportunityCandidate.update({
    where: { id: candidate.id },
    data: {
      sourceMetaJson: JSON.stringify(meta),
      lastActionAt: new Date(),
    },
  });

  return {
    candidateId: candidate.id,
    asin,
    productFact,
    alreadyAttached: false,
  };
}
