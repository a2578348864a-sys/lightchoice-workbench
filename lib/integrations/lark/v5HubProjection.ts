import { canonicalJson } from "@/lib/server/v5CanonicalHash";
import { createHash } from "node:crypto";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import {
  CUSTOMER_VOICE_ATTACHMENT_KIND,
  parseCustomerVoiceAttachmentPayload,
} from "@/lib/sourceLayer/customerVoice";
import { V5_RESEARCH_PACKET_SCHEMA, type V5ResearchPacket } from "@/lib/server/research/researchPacketBuilder";
import type { MonitoringEvidenceReference } from "@/lib/server/continuousMonitoringDiff";
import type { MonitoringRunRecord } from "@/lib/server/continuousMonitoringRepository";
import type { ProductConceptSnapshot, ProductConceptSourceBinding } from "@/lib/marketOpportunity/concept";
import { adaptV3KeywordAttachment } from "@/lib/server/research/v3EvidenceResearchAdapter";
import {
  mapHubFieldsToFeishuDisplayNames,
  v5HubLogicalKeyFromDisplayFields,
} from "./v5HubSchema";
import type { V5HubProjectionRow } from "./v5HubProjectionService";

function jsonText(value: unknown): string {
  return canonicalJson(value);
}

function canonicalEvidenceRefs(productFact: ProductFact): readonly string[] {
  const proof = productFact.sourceProof;
  return [`evidence:${proof.evidenceId}`];
}

/**
 * P1-HUB-02：「下一步动作」= 单商品级确定性中文建议（由该商品的决策状态推导）。
 * 只作看板提示，不驱动任何自动化行为。
 */
export function nextActionForDecisionStatus(decisionStatus: string | null | undefined): string {
  switch (decisionStatus) {
    case "PROCEED":
      return "生成并复核产品开发需求单（Product Brief）";
    case "VALIDATE_MORE":
      return "继续验证：补齐缺失证据后重新研究";
    case "PAUSE":
      return "已暂停：等待时机成熟后重启";
    case "DROP":
      return "已放弃：可归档该商品记录";
    default:
      return "完成人工决策（四态选择并填写理由）";
  }
}

/** Project only allowlisted, already-authoritative ProductFact fields into T01. */
export function mapProductFactToV5HubFields(input: {
  readonly productFact: ProductFact;
  readonly packet: V5ResearchPacket;
  readonly projectedAt: string;
  readonly researchStatus?: string;
  readonly decisionStatus?: string;
}): Record<string, unknown> {
  const { productFact, packet } = input;
  if (productFact.subjectKey !== packet.subjectKey || productFact.basic.asin.value !== packet.asin) {
    throw new Error("V5_HUB_PRODUCT_IDENTITY_MISMATCH");
  }
  const projectedAt = Date.parse(input.projectedAt);
  if (!Number.isFinite(projectedAt)) throw new Error("V5_HUB_PROJECTED_AT_INVALID");
  return mapHubFieldsToFeishuDisplayNames("T01", {
    subjectKey: productFact.subjectKey,
    asin: packet.asin,
    marketplace: packet.marketplace,
    productTitle: productFact.basic.title.value,
    category: productFact.basic.category.value,
    productFactSnapshot: jsonText(productFact),
    factHash: packet.factHash,
    packetHash: packet.packetHash,
    metricNature: jsonText(packet.economics.metricNatureByField),
    provenanceRefs: jsonText(canonicalEvidenceRefs(productFact)),
    researchStatus: input.researchStatus ?? packet.packetStatus,
    decisionStatus: input.decisionStatus ?? "PENDING_HUMAN_REVIEW",
    nextAction: nextActionForDecisionStatus(input.decisionStatus ?? "PENDING_HUMAN_REVIEW"),
    projectedAt,
  });
}

/** Project one immutable, versioned Packet into T02; AI advisory fields are never written. */
export function mapResearchPacketToV5HubFields(packet: V5ResearchPacket): Record<string, unknown> {
  if (packet.schemaVersion !== V5_RESEARCH_PACKET_SCHEMA) {
    throw new Error("V5_HUB_PACKET_SCHEMA_INVALID");
  }
  const generatedAt = Date.parse(packet.generatedAt);
  if (!Number.isFinite(generatedAt)) throw new Error("V5_HUB_PACKET_GENERATED_AT_INVALID");
  return mapHubFieldsToFeishuDisplayNames("T02", {
    schemaVersion: packet.schemaVersion,
    subjectKey: packet.subjectKey,
    asin: packet.asin,
    marketplace: packet.marketplace,
    taskId: packet.taskId,
    revision: packet.revision,
    generatedAt,
    factHash: packet.factHash,
    evidenceHash: packet.evidenceHash,
    packetHash: packet.packetHash,
    price: packet.economics.price?.amount ?? null,
    currency: packet.economics.currency,
    fbaFee: packet.economics.fbaFee?.amount ?? null,
    landedCost: packet.economics.landedCost,
    netProfit: packet.economics.netProfit?.amount ?? null,
    breakEvenPrice: packet.economics.breakEvenPrice?.amount ?? null,
    stressMargin: packet.economics.stressMargin,
    riskGate: packet.riskGate,
    riskCoverage: jsonText(packet.riskCoverage),
    evidenceSufficiency: jsonText(packet.evidenceSufficiency),
    vocSummary: jsonText(packet.vocSummary),
    keywordSummary: jsonText(packet.keywordSummary),
    assumptions: jsonText(packet.assumptions),
    evidenceRefs: jsonText(packet.evidenceRefs),
    missingFields: jsonText(packet.missingFields),
    packetStatus: packet.packetStatus,
  });
}

/** Project a current Research-bound ProductConcept; Human Decision inputs are never emitted. */
export function mapProductConceptToV5HubFields(input: {
  readonly concept: ProductConceptSnapshot;
  readonly taskId: string;
  readonly currentBinding: ProductConceptSourceBinding;
  readonly expectedPacketHash: string;
  readonly projectedAt: string;
}): Record<string, unknown> {
  const { concept } = input;
  const binding = concept.sourceBinding;
  const current = input.currentBinding;
  if (concept.status !== "READY" || concept.opportunityId !== null || !binding
    || binding.sourceType !== "research_v5"
    || binding.researchTaskId !== input.taskId
    || binding.sourceType !== current.sourceType
    || binding.subjectKey !== current.subjectKey
    || binding.researchTaskId !== current.researchTaskId
    || binding.researchRevision !== current.researchRevision
    || binding.reportHash !== current.reportHash
    || binding.factHash !== current.factHash
    || binding.evidenceHash !== current.evidenceHash
    || !Number.isSafeInteger(binding.researchRevision) || binding.researchRevision < 1
    || !/^[a-f0-9]{64}$/u.test(binding.reportHash)
    || !/^[a-f0-9]{64}$/u.test(binding.factHash)
    || !/^[a-f0-9]{64}$/u.test(binding.evidenceHash)
    || !/^[a-f0-9]{64}$/u.test(input.expectedPacketHash)) {
    throw new Error("V5_HUB_CONCEPT_SOURCE_BINDING_INVALID");
  }
  const projectedAt = Date.parse(input.projectedAt);
  if (!Number.isFinite(projectedAt)) throw new Error("V5_HUB_PROJECTED_AT_INVALID");
  const humanDecisionLabels = {
    UNREVIEWED: "未审核",
    APPROVE: "通过",
    VALIDATE_MORE: "需补充验证",
    PAUSE: "暂缓",
    DROP: "放弃",
  } as const;
  const evidenceRefs = [...new Set(concept.traceableItems?.flatMap((item) => item.evidenceRefs) ?? [])].sort();
  return mapHubFieldsToFeishuDisplayNames("T05", {
    conceptId: concept.conceptId,
    subjectKey: binding.subjectKey,
    taskId: binding.researchTaskId,
    revision: concept.revision,
    reportHash: binding.reportHash,
    factHash: binding.factHash,
    evidenceHash: binding.evidenceHash,
    targetCustomer: concept.targetCustomer,
    useCases: jsonText(concept.useCases),
    primaryPainPoints: jsonText(concept.primaryPainPoints),
    specs: jsonText(concept.recommendedSpecs),
    differentiation: jsonText(concept.differentiation),
    priceRange: jsonText(concept.targetPriceRange),
    costRange: jsonText(concept.targetCostRange),
    marginAssumptions: concept.marginAssumptions,
    risks: jsonText(concept.risks),
    missingValidations: jsonText(concept.missingValidation),
    evidenceRefs: jsonText(evidenceRefs),
    confirmedFacts: jsonText(concept.confirmedFacts),
    aiSummary: concept.aiSummary,
    humanDecision: humanDecisionLabels[concept.humanDecision.status],
    expectedPacketHash: input.expectedPacketHash,
    projectedAt,
  });
}

/** Map only validated SellerSprite keyword rows; monthly search volume stays an estimate. */
export function mapV3KeywordAttachmentsToV5HubRows(input: {
  readonly subjectKey: string;
  readonly attachments: readonly SourceEvidenceAttachment[];
}): readonly V5HubProjectionRow[] {
  const identity = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(input.subjectKey);
  if (!identity) throw new Error("V5_HUB_KEYWORD_SUBJECT_INVALID");
  const marketplace = identity[1];
  const rowsByLogicalKey = new Map<string, {
    readonly row: V5HubProjectionRow;
    readonly capturedAt: number;
    readonly contentHash: string;
  }>();
  const attachments = [...input.attachments].sort((left, right) =>
    left.attachmentId.localeCompare(right.attachmentId));

  for (const attachment of attachments) {
    const adapted = adaptV3KeywordAttachment(attachment, input.subjectKey);
    if (!adapted) continue;
    const source = attachment.kind === "v3_reverse_asin_v1"
      ? "SellerSprite 反查"
      : "SellerSprite 关键词挖掘";
    for (const row of adapted.rows) {
      const metricNature = "provider_estimate";
      const keywordHash = createHash("sha256").update(canonicalJson({
        subjectKey: input.subjectKey,
        marketplace,
        source,
        keyword: row.keyword,
        searchVolume: row.monthlySearches,
        metricNature,
        evidenceRef: adapted.evidenceRef,
        contentHash: adapted.contentHash,
      }), "utf8").digest("hex");
      const capturedAt = Date.parse(adapted.capturedAt);
      if (!Number.isFinite(capturedAt)) throw new Error("V5_HUB_KEYWORD_CAPTURED_AT_INVALID");
      const fields = mapHubFieldsToFeishuDisplayNames("T04", {
        subjectKey: input.subjectKey,
        keyword: row.keyword,
        marketplace,
        source,
        observedAt: Date.parse(adapted.capturedAt),
        window: `月度（${new Date(capturedAt).toISOString().slice(0, 7)}）`,
        searchVolume: row.monthlySearches,
        volumeUnit: "次/月",
        rank: null,
        trend: null,
        competition: null,
        metricNature,
        provenanceRefs: jsonText([adapted.evidenceRef]),
        keywordHash,
      });
      const logicalKey = v5HubLogicalKeyFromDisplayFields("T04", fields);
      const existing = rowsByLogicalKey.get(logicalKey);
      if (existing && existing.capturedAt === capturedAt && existing.contentHash !== adapted.contentHash) {
        throw new Error("V5_HUB_KEYWORD_SAME_WINDOW_CONFLICT");
      }
      if (!existing || capturedAt > existing.capturedAt) {
        rowsByLogicalKey.set(logicalKey, {
          row: { logicalKey, fields },
          capturedAt,
          contentHash: adapted.contentHash,
        });
      }
    }
  }
  return [...rowsByLogicalKey.values()]
    .map(({ row }) => row)
    .sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
}

/**
 * Project a deterministic, count-only view of validated Customer Voice evidence.
 * Raw text, titles, authors and external content identifiers never cross this boundary.
 * Pain-point labels and frequency are intentionally unavailable until a versioned
 * classification rule exists.
 */
export function mapCustomerVoiceAttachmentsToV5HubRows(input: {
  readonly subjectKey: string;
  readonly attachments: readonly SourceEvidenceAttachment[];
}): readonly V5HubProjectionRow[] {
  const identity = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(input.subjectKey);
  if (!identity) throw new Error("V5_HUB_VOC_SUBJECT_INVALID");
  const marketplace = identity[1];
  const sourceLabels = {
    amazon_review: "亚马逊商品评论",
    reddit_post: "Reddit 帖子",
    reddit_comment: "Reddit 评论",
    manual_voc: "手工导入买家声音",
  } as const;
  const identityLabels = {
    EXACT: "精确匹配",
    VARIANT: "变体匹配",
    FAMILY: "系列匹配",
    PROBABLE: "可能匹配",
    UNRESOLVED: "尚未确认",
  } as const;
  type Group = {
    source: keyof typeof sourceLabels;
    identityMatch: keyof typeof identityLabels;
    contentHashes: Set<string>;
    dedupeKeys: Set<string>;
    evidenceRefs: Set<string>;
    publishedOrCapturedAt: number[];
    capturedAt: number[];
  };
  const groups = new Map<string, Group>();
  const attachments = [...input.attachments]
    .filter((attachment) => attachment.kind === CUSTOMER_VOICE_ATTACHMENT_KIND)
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));

  for (const attachment of attachments) {
    if (attachment.subjectKey !== input.subjectKey) throw new Error("V5_HUB_VOC_ATTACHMENT_SUBJECT_MISMATCH");
    const payload = parseCustomerVoiceAttachmentPayload(attachment.payload, input.subjectKey);
    if (!payload) throw new Error("V5_HUB_VOC_ATTACHMENT_INVALID");
    for (const observation of payload.observations) {
      const groupKey = `${observation.source}:${observation.identityMatch}`;
      const group = groups.get(groupKey) ?? {
        source: observation.source,
        identityMatch: observation.identityMatch,
        contentHashes: new Set<string>(),
        dedupeKeys: new Set<string>(),
        evidenceRefs: new Set<string>(),
        publishedOrCapturedAt: [],
        capturedAt: [],
      };
      const dedupeKey = `${observation.externalContentId}:${observation.contentHash}`;
      if (!group.dedupeKeys.has(dedupeKey)) {
        group.dedupeKeys.add(dedupeKey);
        group.contentHashes.add(observation.contentHash);
        const eventAt = Date.parse(observation.publishedAt ?? observation.capturedAt);
        const capturedAt = Date.parse(observation.capturedAt);
        if (!Number.isFinite(eventAt) || !Number.isFinite(capturedAt)) {
          throw new Error("V5_HUB_VOC_TIMESTAMP_INVALID");
        }
        group.publishedOrCapturedAt.push(eventAt);
        group.capturedAt.push(capturedAt);
      }
      group.evidenceRefs.add(`attachment:${attachment.attachmentId}`);
      for (const evidenceRef of observation.evidenceRefs) group.evidenceRefs.add(evidenceRef);
      groups.set(groupKey, group);
    }
  }

  const rows = [...groups.entries()].map(([groupKey, group]) => {
    const evidenceRefs = [...group.evidenceRefs].sort();
    const sourceContentHash = createHash("sha256").update(canonicalJson({
      schema: "source-identity-counts.v1",
      subjectKey: input.subjectKey,
      groupKey,
      dedupeKeys: [...group.dedupeKeys].sort(),
      contentHashes: [...group.contentHashes].sort(),
      evidenceRefs,
    }), "utf8").digest("hex");
    const start = Math.min(...group.publishedOrCapturedAt);
    const end = Math.max(...group.publishedOrCapturedAt);
    const aggregatedAt = Math.max(...group.capturedAt);
    const fields = mapHubFieldsToFeishuDisplayNames("T03", {
      subjectKey: input.subjectKey,
      aggregationKey: `${sourceLabels[group.source]}·${identityLabels[group.identityMatch]}`,
      aggregationVersion: `仅统计未分类-v1-${sourceContentHash.slice(0, 16)}`,
      marketplace,
      sourceType: sourceLabels[group.source],
      timeWindowStart: start,
      timeWindowEnd: end,
      failureMode: null,
      painPointTag: null,
      frequency: null,
      sampleCount: group.dedupeKeys.size,
      coverageStatus: "仅统计，未分类",
      representativeSnippet: null,
      evidenceRefs: jsonText(evidenceRefs),
      contentHash: sourceContentHash,
      aggregatedAt,
    });
    return { logicalKey: v5HubLogicalKeyFromDisplayFields("T03", fields), fields };
  });
  return rows.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
}

/** Project only finalized append-only MonitoringRun records; never triggers monitoring. */
export function mapMonitoringRunToV5HubRow(input: {
  readonly subjectKey: string;
  readonly watchTargetId: string;
  readonly run: MonitoringRunRecord;
}): V5HubProjectionRow | null {
  const identity = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/u.exec(input.subjectKey);
  if (!identity) throw new Error("V5_HUB_MONITORING_SUBJECT_INVALID");
  if (input.run.watchTargetId !== input.watchTargetId) {
    throw new Error("V5_HUB_MONITORING_WATCH_IDENTITY_MISMATCH");
  }
  if (input.run.status === "RUNNING" || !input.run.finishedAt) return null;
  const runAt = Date.parse(input.run.startedAt);
  const finalizedAt = Date.parse(input.run.finishedAt);
  if (!Number.isFinite(runAt) || !Number.isFinite(finalizedAt)) {
    throw new Error("V5_HUB_MONITORING_TIMESTAMP_INVALID");
  }

  const evidenceRefs = [input.run.previousEvidenceRef, input.run.currentEvidenceRef]
    .filter((reference): reference is MonitoringEvidenceReference => reference !== null)
    .map((reference) => {
      if (reference.module !== "amazon_detail"
        || reference.subjectKey !== input.subjectKey
        || !reference.attachmentId.trim()
        || !/^[a-f0-9]{64}$/u.test(reference.contentHash)
        || !Number.isFinite(Date.parse(reference.capturedAt))
        || !reference.rawArtifactId.trim()
        || !/^[a-f0-9]{64}$/u.test(reference.rawArtifactHash)) {
        throw new Error("V5_HUB_MONITORING_EVIDENCE_REFERENCE_INVALID");
      }
      return reference;
    })
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId))
    .map((reference) => ({
      subjectKey: reference.subjectKey,
      module: reference.module,
      attachmentId: reference.attachmentId,
      contentHash: reference.contentHash,
      capturedAt: reference.capturedAt,
      rawArtifactId: reference.rawArtifactId,
      rawArtifactHash: reference.rawArtifactHash,
    }));
  const eventKey = input.run.outcome ?? input.run.status;
  const fields = mapHubFieldsToFeishuDisplayNames("T06", {
    watchTargetId: input.watchTargetId,
    monitoringRunId: input.run.id,
    eventKey,
    subjectKey: input.subjectKey,
    runAt,
    changeSummary: input.run.changeSummary === null ? null : jsonText(input.run.changeSummary),
    severity: null,
    eventStatus: eventKey,
    evidenceRefs: jsonText(evidenceRefs),
    packetHash: null,
    // The source finalization time is stable across replays of this immutable run.
    projectedAt: finalizedAt,
  });
  return { logicalKey: v5HubLogicalKeyFromDisplayFields("T06", fields), fields };
}
