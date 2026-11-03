import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { newSpanId, newTraceId } from "@/lib/sourceLayer/diagnostics";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { recordDiagnosticEvent } from "@/lib/sourceLayer/server/diagnosticService";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import { amazonDetailHistoryOriginsOf } from "@/lib/sourceLayer/amazonDetailFieldHistory";
import { parseCustomerVoiceAttachmentPayload } from "@/lib/sourceLayer/customerVoice";
import { productFactSourceFromCaptureSource } from "@/lib/sourceLayer/fact/productFactAdapter";
import {
  RESEARCH_INPUT_BUNDLE_SCHEMA,
  type ResearchInputBundle,
  type ResearchInputBundleEvidenceRef,
  type ResearchVariationEvidenceProjection,
  type TrendObservation,
} from "@/lib/sourceLayer/v2/contracts";
import { buildResearchEngineInput } from "@/lib/server/research/researchInput";
import type { ResearchEngineInput } from "@/lib/research/researchContracts";
import { projectVariationEvidence } from "@/lib/server/research/variationEvidenceProjection";
import { bindProviderMetricEvidence } from "@/lib/server/research/providerMetricEvidenceBinding";
import { bindProviderProductMarketEvidence } from "@/lib/server/research/providerProductMarketEvidence";
import {
  adaptV3HistoricalTrendAttachment,
  adaptV3KeywordAttachment,
  adaptV3ProductMarketAttachment,
  adaptV3ReviewAttachment,
  deduplicateKeywordEvidence,
  deduplicateReviewEvidence,
  deduplicateTrendObservations,
} from "@/lib/server/research/v3EvidenceResearchAdapter";
import type { ResearchProviderProductMarketEvidence } from "@/lib/server/research/providerProductMarketEvidence";

type ResearchInputBundleWithProviderMarket = ResearchInputBundle & {
  readonly providerProductMarketEvidence?: readonly ResearchProviderProductMarketEvidence[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function missingProductFactFields(productFact: ProductFact): string[] {
  const missing: string[] = [];
  for (const [groupName, group] of Object.entries(productFact)) {
    if (!isRecord(group) || groupName === "sourceProof" || groupName === "schema" || groupName === "subjectKey" || groupName === "amazonDetailHistory") continue;
    for (const [fieldName, field] of Object.entries(group)) {
      if (isRecord(field) && field.status === "missing") missing.push(`${groupName}.${fieldName}`);
    }
  }
  return missing.sort();
}

export function conflictProductFactFields(productFact: ProductFact): string[] {
  const conflicts: string[] = [];
  for (const [groupName, group] of Object.entries(productFact)) {
    if (!isRecord(group)) continue;
    for (const [fieldName, field] of Object.entries(group)) {
      if (isRecord(field) && field.status === "conflict") conflicts.push(`${groupName}.${fieldName}`);
    }
  }
  if (productFact.amazonDetailHistory?.fields.title.status === "conflict") conflicts.push("basic.title");
  if (productFact.amazonDetailHistory?.fields.price.status === "conflict") conflicts.push("basic.price");
  for (const conflict of productFact.sourceConflicts ?? []) conflicts.push(conflict.field);
  return [...new Set(conflicts)].sort();
}

function daysBetween(now: Date, capturedAt: string): number | null {
  const captured = new Date(capturedAt);
  if (Number.isNaN(captured.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - captured.getTime()) / 86_400_000));
}

function bindVariationProjectionRefs(
  projection: ReturnType<typeof projectVariationEvidence>,
  refs: readonly ResearchInputBundleEvidenceRef[],
): ResearchVariationEvidenceProjection {
  const attachments = new Map(refs.filter((ref) => ref.kind === "attachment").map((ref) => [ref.refId, ref]));
  const sourceIds = projection.evidenceRefs.map((ref) => ref.refId);
  const missingRef = sourceIds.some((id) => !attachments.has(id));
  const evidenceRefs = missingRef ? [] : sourceIds.map((id) => attachments.get(id)!);
  const asBundleRefs = (original: readonly { refId: string }[]) => missingRef ? [] : original.flatMap(({ refId }) => {
    const ref = attachments.get(refId);
    return ref ? [ref] : [];
  });
  if (missingRef) {
    return {
      ...projection,
      outcome: "status_conflict",
      completeness: "unavailable",
      parentAsin: null,
      memberAsins: [],
      members: [],
      relations: [],
      evidenceRefs: [],
      limitation: "variation_attachment_reference_missing_from_research_bundle",
    };
  }
  return {
    ...projection,
    evidenceRefs,
    members: projection.members.map((member) => ({ ...member, evidenceRefs: asBundleRefs(member.evidenceRefs) })),
    relations: projection.relations.map((relation) => ({ ...relation, evidenceRefs: asBundleRefs(relation.evidenceRefs) })),
  };
}

/**
 * 从现有正式 Research Task + Candidate ProductFact + 同一 EvidenceStore 只读组装。
 * 不浏览、不调用外部 provider、不写数据库，也不修改 Research 生命周期。
 */
export async function buildResearchInputBundle(input: {
  context: AccessContext;
  taskId: string;
  traceId?: string | null;
  /** Reuse the caller's already-verified input to keep time-sensitive projections stable. */
  engineInput?: ResearchEngineInput;
  /** Disable the default audit diagnostic for read-only projection/verification callers. */
  recordDiagnostic?: boolean;
}): Promise<ResearchInputBundleWithProviderMarket> {
  const engineInput = input.engineInput ?? await buildResearchEngineInput({
    context: input.context,
    taskId: input.taskId,
  });
  const productFact = engineInput.productFact;
  const store = createEvidenceStore(sourceLayerOperator(input.context));
  const subject = await store.getSubject(productFact.subjectKey);
  const evidence = subject?.versions.find((item) => item.evidenceId === productFact.sourceProof.evidenceId
    && item.captureId === productFact.sourceProof.captureId
    && item.subjectKey === productFact.sourceProof.subjectKey
    && item.contentHash === productFact.sourceProof.contentHash
    && productFactSourceFromCaptureSource(item.sourceType) === productFact.sourceProof.source) ?? null;
  if (!subject || !evidence || subject.subjectKey !== productFact.subjectKey) {
    throw new Error("RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING");
  }
  if (evidence.validation && (evidence.validation.verdict !== "passed" || evidence.validation.readyForResearch !== true)) {
    throw new Error("RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING: Evidence validation did not pass or is not ready for research.");
  }
  const refs: ResearchInputBundleEvidenceRef[] = [{
    refId: `evidence:${evidence.evidenceId}`,
    kind: "product_evidence",
    subjectKey: productFact.subjectKey,
    evidenceId: evidence.evidenceId,
    captureId: evidence.captureId,
    version: evidence.version,
    contentHash: evidence.contentHash,
    capturedAt: evidence.capturedAt,
  }];
  for (const origin of amazonDetailHistoryOriginsOf(productFact)) {
    const matches = subject.versions.filter((item) => item.subjectKey === productFact.subjectKey
      && item.evidenceId === origin.evidenceId && item.captureId === origin.captureId
      && item.version === origin.version && item.contentHash === origin.contentHash
      && item.capturedAt === origin.capturedAt && item.sourceType === "amazon_dom"
      && item.factAuthority === "evidence_only"
      && item.sourceUrl === origin.sourceUrl
      && item.pkg.sourceProof.sourceType === "amazon_dom"
      && item.pkg.subjectKey === origin.subjectKey
      && item.pkg.captureId === origin.captureId && item.pkg.version === origin.version
      && item.pkg.marketplace.toUpperCase() === productFact.amazonDetailHistory?.marketplace
      && origin.marketplace === productFact.amazonDetailHistory?.marketplace
      && item.pkg.fields.asin === origin.asin
      && item.pkg.sourceProof.capturedAt === origin.capturedAt
      && item.pkg.sourceProof.sourceUrl === origin.sourceUrl
      && item.pkg.sourceProof.entityBinding?.bound === true
      && item.pkg.sourceProof.entityBinding?.expectedAsin === origin.asin
      && item.pkg.sourceProof.entityBinding?.observedAsin === origin.asin
      && item.pkg.sourceProof.entityBinding?.urlAsin === origin.asin
      && item.pkg.sourceProof.entityBinding?.expectedMarketplace === origin.marketplace
      && item.pkg.sourceProof.entityBinding?.observedMarketplace === origin.marketplace
      && item.pkg.sourceProof.entityBinding?.urlMarketplace === origin.marketplace);
    const historyEvidence = matches.length === 1 ? matches[0] : null;
    if (!historyEvidence || historyEvidence.factAuthority !== "evidence_only"
      || historyEvidence.validation.verdict !== "passed" || historyEvidence.validation.readyForResearch !== true) {
      throw new Error("RESEARCH_INPUT_BUNDLE_AMAZON_DETAIL_HISTORY_EVIDENCE_MISSING");
    }
    if (historyEvidence.evidenceId === evidence.evidenceId && historyEvidence.contentHash === evidence.contentHash) continue;
    refs.push({
      refId: `evidence:${historyEvidence.evidenceId}`,
      kind: "product_evidence",
      subjectKey: historyEvidence.subjectKey,
      evidenceId: historyEvidence.evidenceId,
      captureId: historyEvidence.captureId,
      version: historyEvidence.version,
      contentHash: historyEvidence.contentHash,
      capturedAt: historyEvidence.capturedAt,
    });
  }
  for (const attachment of subject.attachments ?? []) {
    refs.push({
      refId: `attachment:${attachment.attachmentId}`,
      kind: "attachment",
      subjectKey: attachment.subjectKey,
      evidenceId: evidence.evidenceId,
      captureId: evidence.captureId,
      version: evidence.version,
      contentHash: attachment.contentHash,
      capturedAt: attachment.capturedAt,
      attachmentId: attachment.attachmentId,
    });
  }
  const rawTrends = await store.listTrendObservations?.(productFact.subjectKey) ?? [];
  const v3HistoricalAttachments = (subject.attachments ?? []).filter(
    (item) => item.kind === "v3_historical_trend_v1"
  );
  const v3Trends: TrendObservation[] = [];
  for (const att of v3HistoricalAttachments) {
    v3Trends.push(...adaptV3HistoricalTrendAttachment(att, productFact.subjectKey));
  }
  const trendObservations = deduplicateTrendObservations(rawTrends, v3Trends);

  for (const trend of trendObservations) {
    refs.push({
      refId: `trend:${trend.observationId}`,
      kind: "trend_observation",
      subjectKey: productFact.subjectKey,
      evidenceId: evidence.evidenceId,
      captureId: evidence.captureId,
      version: evidence.version,
      contentHash: trend.contentHash,
      capturedAt: trend.capturedAt,
    });
  }

  const legacyKeywords = (subject.attachments ?? []).filter((item) => item.kind === "keyword_evidence");
  // 只适配一次：既用于既有附件级去重，也用于 PH3 的 typed provider 字段绑定。
  const adaptedV3Keywords = (subject.attachments ?? []).flatMap((item) => {
    if (item.kind !== "v3_reverse_asin_v1" && item.kind !== "v3_keyword_mining_trend_v1") return [];
    const adapted = adaptV3KeywordAttachment(item, productFact.subjectKey);
    if (!adapted || adapted.rows.length === 0) return [];
    return [{ attachment: item, adapted }];
  });
  const v3Keywords = adaptedV3Keywords.map((entry) => entry.attachment);
  const keywordEvidence = deduplicateKeywordEvidence(legacyKeywords, v3Keywords);
  // PH3：typed provider 字段按**附件级来源**绑定进 bundle；没有对应附件引用的整条丢弃。
  const providerMetricEvidence = bindProviderMetricEvidence({
    adapted: adaptedV3Keywords.map((entry) => entry.adapted),
    refs,
    subjectKey: productFact.subjectKey,
  });
  const adaptedV3ProductMarkets = (subject.attachments ?? []).flatMap((item) => {
    const adapted = adaptV3ProductMarketAttachment(item, productFact.subjectKey);
    return adapted ? [adapted] : [];
  });
  const providerProductMarketEvidence = bindProviderProductMarketEvidence({
    adapted: adaptedV3ProductMarkets,
    refs,
    subjectKey: productFact.subjectKey,
    asin: typeof productFact.basic.asin?.value === "string" ? productFact.basic.asin.value : null,
  });
  const variationEvidence = bindVariationProjectionRefs(
    projectVariationEvidence(subject.attachments ?? [], productFact.subjectKey),
    refs,
  );

  const voiceAttachments = (subject.attachments ?? [])
    .filter((item) => item.kind === "customer_voice_observation_v1")
    .flatMap((item) => {
      const payload = parseCustomerVoiceAttachmentPayload(item.payload, productFact.subjectKey);
      return payload ? [{ attachment: item, payload }] : [];
    });
  const normalizedAmazonSourceIds = new Set(voiceAttachments
    .flatMap(({ payload }) => payload.observations)
    .map((observation) => observation.provenance.sourceAttachmentId)
    .filter((id): id is string => id !== null));

  // F-03 修复：canonical `customer_voice_observation_v1` 已归一某来源附件时，该来源的
  // legacy/v3 review 投影不得再作为独立消费样本进入 reviewEvidence，否则同一批评论会被
  // customerVoiceEvidence 与 reviewEvidence 重复计入。做法：先用**全部** v3 参与既有
  // V3_PRIMARY_LEGACY_COMPAT 行级去重（使 legacy 副本被行签名匹配丢弃），再从结果中移除
  // 已被 canonical 归一的 v3 附件本身。兼容读取保留，但不作为独立消费样本。
  const allV3Reviews = (subject.attachments ?? []).filter((item) => {
    if (item.kind !== "v3_review_voc_v1") return false;
    const adapted = adaptV3ReviewAttachment(item, productFact.subjectKey);
    return adapted !== null && adapted.samples.length > 0;
  });
  const normalizedV3Reviews = allV3Reviews.filter((item) => normalizedAmazonSourceIds.has(item.attachmentId));
  const activeV3Reviews = allV3Reviews.filter((item) => !normalizedAmazonSourceIds.has(item.attachmentId));
  // 用全部 v3（含已被 canonical 归一者）参与去重，避免其 legacy 副本被重复计入。
  const dedupedReviews = deduplicateReviewEvidence(
    (subject.attachments ?? []).filter((item) => item.kind === "review_evidence"),
    allV3Reviews,
  );
  // 结果中排除已被 canonical 归一、以及未通过 v3 样本校验的附件。
  const normalizedIds = new Set(normalizedV3Reviews.map((item) => item.attachmentId));
  const activeV3Ids = new Set(activeV3Reviews.map((item) => item.attachmentId));
  const reviewEvidence = dedupedReviews.filter((item) => {
    if (item.kind === "v3_review_voc_v1") return activeV3Ids.has(item.attachmentId) && !normalizedIds.has(item.attachmentId);
    // legacy 附件：只要它的行已被任一 canonical/v3 覆盖，dedupedReviews 已将其丢弃；
    // 仍留下的即为未被归一、且无对应 v3 的独立 legacy 来源，允许保留。
    return item.kind === "review_evidence";
  });

  const customerVoiceEvidence = voiceAttachments
    .flatMap(({ attachment: item, payload }) => {
      const observations = payload.observations.slice(0, 40).map((observation) => ({
        refId: `attachment:${item.attachmentId}`,
        externalContentId: observation.externalContentId,
        contentHash: observation.contentHash,
        source: observation.source,
        evidenceRefs: observation.evidenceRefs,
        limitations: [...new Set(observation.evidenceRefs.flatMap((ref) => {
          if (!ref.startsWith("attachment:")) return [];
          const sourceAttachmentId = ref.slice("attachment:".length);
          const sourceAttachment = (subject.attachments ?? []).find((candidate) => candidate.attachmentId === sourceAttachmentId);
          if (sourceAttachment?.kind !== "v3_review_voc_v1" || !isRecord(sourceAttachment.payload)) return [];
          return Array.isArray(sourceAttachment.payload.limitations)
            ? sourceAttachment.payload.limitations.filter((limitation): limitation is string => typeof limitation === "string" && limitation.trim().length > 0)
            : [];
        }))],
        parentContentId: observation.parentContentId,
        threadId: observation.threadId,
        subreddit: observation.subreddit,
        depth: observation.depth,
        contentType: observation.contentType,
        title: observation.title,
        // Canonical text is already bounded/validated (5,000 chars). A second
        // prefix cut loses mixed reviews' qualifications and changes meaning.
        // Keep the 40-observation bound; the existing outbound budget gate must
        // reject an oversized input rather than silently cherry-pick its text.
        text: observation.text,
        rating: observation.rating,
        verifiedPurchase: observation.verifiedPurchase,
        publishedAt: observation.publishedAt,
        engagement: observation.engagement,
        authorRef: observation.authorRef,
        provenance: observation.provenance,
        identityMatch: observation.identityMatch,
        ownerExperience: observation.ownerExperience,
      }));
      return [{
        attachmentId: item.attachmentId,
        contentHash: item.contentHash,
        source: payload.observations[0]?.source ?? "manual_voc" as const,
        observationCount: payload.observations.length,
        omittedCount: Math.max(0, payload.observations.length - observations.length),
        observations,
      }];
    });

  const allCapturedAt = [
    evidence.capturedAt,
    ...(subject.attachments ?? []).map((item) => item.capturedAt),
    ...trendObservations.map((item) => item.capturedAt),
  ]
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
  const now = new Date();
  const traceId = input.traceId ?? newTraceId();
  const bundle: ResearchInputBundleWithProviderMarket = {
    schemaVersion: RESEARCH_INPUT_BUNDLE_SCHEMA,
    taskId: engineInput.taskId,
    candidateId: engineInput.candidateId,
    subjectKey: productFact.subjectKey,
    productFact,
    sourceEvidenceRefs: refs,
    keywordEvidence,
    reviewEvidence,
    customerVoiceEvidence,
    variationEvidence,
    trendObservations,
    // PH3：只有真正绑定了附件级来源的 typed provider 证据才出现（空则整键缺省）。
    ...(providerMetricEvidence.length > 0 ? { providerMetricEvidence } : {}),
    ...(providerProductMarketEvidence.length > 0 ? { providerProductMarketEvidence } : {}),
    missingFields: missingProductFactFields(productFact),
    conflicts: conflictProductFactFields(productFact),
    freshness: {
      latestCapturedAt: allCapturedAt,
      ageDays: allCapturedAt ? daysBetween(now, allCapturedAt) : null,
    },
    traceId,
  };
  // Interactive Research handoffs retain their diagnostic audit by default.
  // Read-only projection/verification callers must explicitly disable it.
  if (input.recordDiagnostic !== false) {
    await recordDiagnosticEvent({
      context: input.context,
      event: {
        traceId,
        spanId: newSpanId(),
        parentSpanId: null,
        taskId: bundle.taskId,
        captureId: evidence.captureId,
        subjectKey: bundle.subjectKey,
        module: "RESEARCH_HANDOFF",
        phase: "research",
        eventType: "research_input_bundle_read",
        severity: "info",
        statusBefore: null,
        statusAfter: "succeeded",
        status: "succeeded",
        errorCode: null,
        reason: "ResearchInputBundle read ProductFact and linked EvidenceStore references.",
        retryable: false,
        humanRequired: false,
        sourceType: productFact.sourceProof.source,
        recipeVersion: "research-input-bundle.v1",
        pageTemplateHash: null,
        evidenceRefs: refs.map((ref) => ref.refId),
        contentHash: productFact.sourceProof.contentHash,
        jevRole: "none",
        jevModelVersion: null,
        jevPromptVersion: null,
        jevConfidence: null,
        durationMs: null,
        attempt: 1,
      },
    }).catch(() => undefined);
  }
  return bundle;
}
