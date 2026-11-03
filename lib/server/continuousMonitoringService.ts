import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { LOCAL_OWNER_PRINCIPAL } from "@/lib/server/accessPassword";
import { collectAmazonDetailWithPlaywright } from "@/lib/server/captureRecipeBrowser";
import { explainMonitoringChange, type MonitoringAiExplanation } from "@/lib/server/continuousMonitoringAi";
import { nextMonitoringRunAt } from "@/lib/server/continuousMonitoringContract";
import {
  evaluateMonitoringCapturePair,
  type MonitoringCaptureOutcome,
  type MonitoringComparisonResult,
  type MonitoringEvidenceReference,
  type MonitoringEvidenceSnapshot,
} from "@/lib/server/continuousMonitoringDiff";
import {
  createMonitoringRepository,
  type MonitoringRepository,
  type MonitoringRunRecord,
  type MonitoringTriggerType,
  type MonitoringWatchTarget,
} from "@/lib/server/continuousMonitoringRepository";
import { readV3ModuleEvidence, parseV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { isValidTimeZone } from "@/lib/server/continuousMonitoringContract";

export type MonitoringCaptureClient = (watch: MonitoringWatchTarget) => Promise<MonitoringCaptureOutcome>;
export type MonitoringExplanationClient = (input: Parameters<typeof explainMonitoringChange>[0]) => Promise<MonitoringAiExplanation>;

export type MonitoringServiceDependencies = {
  repository?: MonitoringRepository;
  capture?: MonitoringCaptureClient;
  explain?: MonitoringExplanationClient;
  loadSnapshot?: (reference: MonitoringEvidenceReference) => Promise<MonitoringEvidenceSnapshot | null>;
  now?: () => Date;
};

export type RunMonitoringTargetResult =
  | { status: "STARTED"; run: MonitoringRunRecord }
  | { status: "OVERLAP" | "DISABLED"; run: MonitoringRunRecord }
  | { status: "NOT_DUE" | "NOT_FOUND" };

function canonicalSubjectKey(asin: string): string {
  return `amazon:US:${asin}`;
}

function safeErrorCode(value: unknown): string {
  if (typeof value === "string" && /^[A-Z0-9_:-]{1,80}$/u.test(value)) return value;
  return "CAPTURE_FAILED";
}

function rawEvidenceBytes(evidence: MonitoringEvidenceSnapshot["evidence"]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    acquisitionMode: evidence.acquisitionMode,
    evidence,
  }, null, 2)}\n`);
}

async function loadEvidenceSnapshot(reference: MonitoringEvidenceReference): Promise<MonitoringEvidenceSnapshot | null> {
  const result = await readV3ModuleEvidence({
    context: LOCAL_OWNER_PRINCIPAL,
    subjectKey: reference.subjectKey,
    module: reference.module,
  });
  const evidence = result.modules.find((item) => item.capturedAt === reference.capturedAt);
  const attachment = result.evidenceStore?.attachments?.find((item) => item.attachmentId === reference.attachmentId);
  const artifact = result.evidenceStore?.rawArtifacts?.find((item) => item.artifactId === reference.rawArtifactId);
  if (!evidence || !attachment || !artifact
    || evidence.subjectKey !== reference.subjectKey
    || evidence.module !== reference.module
    || evidence.capturedAt !== reference.capturedAt
    || evidence.provider !== reference.provider
    || evidence.acquisitionMode !== reference.acquisitionMode
    || evidence.metricNature !== reference.metricNature
    || attachment.sourceType !== reference.sourceType
    || attachment.capturedAt !== reference.capturedAt
    || attachment.contentHash !== reference.contentHash
    || artifact.subjectKey !== reference.subjectKey
    || artifact.capturedAt !== reference.capturedAt
    || artifact.sha256 !== reference.rawArtifactHash
    || artifact.provenance.provider !== reference.provider
    || artifact.provenance.sourceRecordRef !== evidence.identity.asin) return null;

  const rawHash = createHash("sha256").update(rawEvidenceBytes(evidence)).digest("hex");
  if (rawHash !== artifact.sha256) return null;
  return { sourceType: attachment.sourceType, evidence, evidenceRef: reference };
}

async function captureAmazonDetail(watch: MonitoringWatchTarget): Promise<MonitoringCaptureOutcome> {
  const match = /^amazon:US:([A-Z0-9]{10})$/u.exec(watch.subjectKey);
  if (!match || watch.captureModule !== "amazon_detail") return { status: "FAILED", errorCode: "WATCH_TARGET_INVALID" };
  const capturedAt = new Date();
  const collection = await collectAmazonDetailWithPlaywright({
    context: LOCAL_OWNER_PRINCIPAL,
    asin: match[1],
    now: capturedAt,
    traceId: `monitor-${randomUUID()}`,
  });
  if (collection.status !== "captured" || !collection.capture || !collection.extraction?.entityBound) {
    const code = safeErrorCode(collection.errorCode);
    const human = collection.status === "human_required"
      || code === "CAPTCHA_DETECTED"
      || code === "LOGIN_REQUIRED"
      || code === "HUMAN_ACTION_REQUIRED";
    return human
      ? { status: "HUMAN_ACTION_REQUIRED", errorCode: code }
      : { status: "FAILED", errorCode: code };
  }

  const readback = await readV3ModuleEvidence({
    context: LOCAL_OWNER_PRINCIPAL,
    subjectKey: watch.subjectKey,
    module: "amazon_detail",
  });
  const matchingAttachments = (readback.evidenceStore?.attachments ?? []).filter((attachment) => {
    if (attachment.sourceType !== "amazon_dom" || attachment.capturedAt !== capturedAt.toISOString()) return false;
    const parsed = parseV3ModuleEvidence(attachment.payload);
    return parsed?.module === "amazon_detail"
      && parsed.subjectKey === watch.subjectKey
      && parsed.capturedAt === capturedAt.toISOString()
      && parsed.identity.asin === match[1];
  });
  if (matchingAttachments.length !== 1) return { status: "FAILED", errorCode: "EVIDENCE_READBACK_MISMATCH" };
  const attachment = matchingAttachments[0];
  const evidence = parseV3ModuleEvidence(attachment.payload);
  if (!evidence) return { status: "FAILED", errorCode: "EVIDENCE_READBACK_INVALID" };
  const expectedRawHash = createHash("sha256").update(rawEvidenceBytes(evidence)).digest("hex");
  const rawArtifacts = (readback.evidenceStore?.rawArtifacts ?? []).filter((artifact) =>
    artifact.subjectKey === watch.subjectKey
      && artifact.sourceType === "amazon_dom"
      && artifact.capturedAt === evidence.capturedAt
      && artifact.sha256 === expectedRawHash
      && artifact.provenance.provider === evidence.provider
      && artifact.provenance.sourceRecordRef === match[1]);
  if (rawArtifacts.length !== 1) return { status: "FAILED", errorCode: "RAW_ARTIFACT_READBACK_MISMATCH" };
  const rawArtifact = rawArtifacts[0];
  const evidenceRef: MonitoringEvidenceReference = {
    subjectKey: evidence.subjectKey,
    module: evidence.module,
    attachmentId: attachment.attachmentId,
    contentHash: attachment.contentHash,
    capturedAt: evidence.capturedAt,
    sourceType: attachment.sourceType,
    provider: evidence.provider,
    acquisitionMode: evidence.acquisitionMode,
    metricNature: evidence.metricNature,
    rawArtifactId: rawArtifact.artifactId,
    rawArtifactHash: rawArtifact.sha256,
  };
  return {
    status: "CAPTURED",
    snapshot: { sourceType: attachment.sourceType, evidence, evidenceRef },
  };
}

function notComparable(reason: string): MonitoringComparisonResult {
  return { status: "NOT_COMPARABLE", reason, diffs: [], uncomparable: [], changeEvent: null };
}

function errorMessageForCode(errorCode: string): string {
  if (errorCode === "CAPTCHA_DETECTED" || errorCode === "LOGIN_REQUIRED" || errorCode === "HUMAN_ACTION_REQUIRED") {
    return "Amazon 当前页面需要人工处理；本次没有生成变化事件。";
  }
  if (errorCode === "LOCAL_ENVIRONMENT_REQUIRED") {
    return "本次未能检查 Amazon 页面：当前本地采集环境未连接。请检查系统诊断中的本地采集状态后重试。";
  }
  if (errorCode === "AMAZON_CAPTURE_NON_US_EXIT") {
    return "本次未能检查 Amazon 页面：当前网络出口不是美国。请检查网络出口状态后重试。";
  }
  if (errorCode === "EVIDENCE_READBACK_MISMATCH" || errorCode === "RAW_ARTIFACT_READBACK_MISMATCH" || errorCode === "EVIDENCE_READBACK_INVALID") {
    return "采集证据回读校验未通过；本次没有生成变化事件。请前往系统诊断查看详情后重试。";
  }
  return "Amazon 商品页面检查未完成；本次没有生成变化事件。请前往系统诊断查看原因后重试。";
}

function defaultRepository(): MonitoringRepository {
  return createMonitoringRepository();
}

export async function runMonitoringTarget(input: {
  watchTargetId: string;
  triggerType: MonitoringTriggerType;
}, dependencies: MonitoringServiceDependencies = {}): Promise<RunMonitoringTargetResult> {
  const repository = dependencies.repository ?? defaultRepository();
  const now = dependencies.now ?? (() => new Date());
  const watch = await repository.getWatch(input.watchTargetId);
  if (!watch) return { status: "NOT_FOUND" };
  if (!isValidTimeZone(watch.timezone)) throw new Error("MONITORING_STORAGE_CORRUPT");
  const startedAt = now();
  const nextRunAt = nextMonitoringRunAt(watch.schedule, watch.timezone, startedAt).toISOString();
  const begun = await repository.beginRun({
    watchTargetId: watch.id,
    runId: randomUUID(),
    triggerType: input.triggerType,
    startedAt: startedAt.toISOString(),
    nextRunAt,
  });
  if (begun.kind === "NOT_FOUND") return { status: "NOT_FOUND" };
  if (begun.kind === "NOT_DUE") return { status: "NOT_DUE" };
  if (begun.kind === "OVERLAP") return { status: "OVERLAP", run: begun.run };
  if (begun.kind === "DISABLED") return { status: "DISABLED", run: begun.run };

  let previousEvidenceRef: MonitoringEvidenceReference | null = null;
  try {
    previousEvidenceRef = await repository.latestBaseline(watch.id);
    const captureClient = dependencies.capture ?? captureAmazonDetail;
    const capture = await captureClient(watch);
    if (capture.status !== "CAPTURED") {
      await repository.failRun({
        runId: begun.run.id,
        watchTargetId: watch.id,
        finishedAt: now().toISOString(),
        errorCode: safeErrorCode(capture.errorCode),
        errorMessage: errorMessageForCode(safeErrorCode(capture.errorCode)),
        previousEvidenceRef,
      });
      return { status: "STARTED", run: (await repository.getRun(begun.run.id)) ?? begun.run };
    }

    let comparison: MonitoringComparisonResult;
    if (previousEvidenceRef) {
      const loadSnapshot = dependencies.loadSnapshot ?? loadEvidenceSnapshot;
      const previous = await loadSnapshot(previousEvidenceRef);
      comparison = previous
        ? evaluateMonitoringCapturePair({ previous, capture, policy: watch.policy })
        : notComparable("previous_evidence_reference_unavailable_or_integrity_mismatch");
    } else {
      comparison = evaluateMonitoringCapturePair({ previous: null, capture, policy: watch.policy });
    }

    const currentEvidenceRef = capture.snapshot.evidenceRef;
    const meaningfulChange = comparison.status === "CHANGE_DETECTED";
    const completedAt = now();
    const cooldownMs = watch.policy.cooldownMinutes * 60_000;
    const lastMeaningfulAt = watch.lastMeaningfulChangeAt ? Date.parse(watch.lastMeaningfulChangeAt) : Number.NaN;
    const cooldownSuppressed = meaningfulChange
      && cooldownMs > 0
      && Number.isFinite(lastMeaningfulAt)
      && completedAt.getTime() - lastMeaningfulAt < cooldownMs;
    const outcome = cooldownSuppressed ? "COOLDOWN_SUPPRESSED" : comparison.status;
    let aiExplanation: MonitoringAiExplanation | null = null;
    if (meaningfulChange) {
      if (cooldownSuppressed) {
        aiExplanation = { status: "SKIPPED_COOLDOWN", code: "MEANINGFUL_CHANGE_COOLDOWN" };
      } else if (comparison.status === "CHANGE_DETECTED" && comparison.changeEvent) {
        try {
          const explain = dependencies.explain ?? explainMonitoringChange;
          aiExplanation = await explain({
            diffs: comparison.changeEvent.diffs,
            evidenceRefs: comparison.changeEvent.evidenceRefs,
          });
        } catch {
          aiExplanation = { status: "UNAVAILABLE", code: "AI_PROVIDER_UNAVAILABLE" };
        }
      }
    }

    const changeSummary: Record<string, unknown> = {
      comparisonStatus: comparison.status,
      eventStatus: outcome,
      diffDetected: "diffDetected" in comparison ? comparison.diffDetected : false,
      meaningfulChange,
      cooldownSuppressed,
      reason: comparison.status === "NOT_COMPARABLE" ? comparison.reason : null,
      diffs: comparison.diffs,
      // Per-field gaps stay visible even when other fields produced a valid change.
      uncomparableFields: "uncomparable" in comparison ? comparison.uncomparable : [],
      evidenceRefs: [previousEvidenceRef, currentEvidenceRef].filter((reference): reference is MonitoringEvidenceReference => reference !== null),
    };
    await repository.completeRun({
      runId: begun.run.id,
      watchTargetId: watch.id,
      finishedAt: completedAt.toISOString(),
      outcome,
      previousEvidenceRef,
      currentEvidenceRef,
      changeSummary,
      aiExplanation,
      meaningfulChange: meaningfulChange && !cooldownSuppressed,
    });
    return { status: "STARTED", run: (await repository.getRun(begun.run.id)) ?? begun.run };
  } catch (error) {
    try {
      await repository.failRun({
        runId: begun.run.id,
        watchTargetId: watch.id,
        finishedAt: now().toISOString(),
        errorCode: error instanceof Error && error.message === "MONITORING_STORAGE_CORRUPT"
          ? "MONITORING_STORAGE_CORRUPT"
          : "MONITORING_RUN_FAILED",
        errorMessage: "监控运行未能完成；未生成变化事件。",
        previousEvidenceRef,
      });
      return { status: "STARTED", run: (await repository.getRun(begun.run.id)) ?? begun.run };
    } catch {
      throw new Error("MONITORING_RUN_FINALIZATION_FAILED");
    }
  }
}
