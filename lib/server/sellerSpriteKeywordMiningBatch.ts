import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  captureSellerSpriteVisibleQuery,
  sellerSpriteKeywordMiningQuerySubjectKey,
  sellerSpriteQueryFingerprint,
  validateSellerSpriteQueryInput,
  type SellerSpriteQueryInput,
} from "@/lib/server/sellerSpriteVisibleQuery";
import {
  attachmentKindForV3Module,
  parseV3ModuleEvidence,
  readV3ModuleEvidence,
  type V3ModuleEvidence,
} from "@/lib/sourceLayer/v3ModuleEvidence";
import {
  sourceEvidenceAttachmentContentHash,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";
import {
  createEvidenceStore,
  type EvidenceSubjectRecord,
} from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";

const KEYWORD_MINING_URL = "https://www.sellersprite.com/v3/keyword-miner/";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_WINDOWS = 8;

export type KeywordMiningQueryExecution = {
  status: "captured" | "blocked" | "human_required" | "failed";
  navigationPerformed: boolean;
  querySubjectKey: string | null;
  queryFingerprint: string | null;
  evidenceAttachmentId: string | null;
  evidenceContentHash: string | null;
  rowsObserved: number;
  errorCode: string | null;
  stopped?: boolean;
};

type KeywordMiningWorkerDeps = {
  captureQuery?: typeof captureSellerSpriteVisibleQuery;
};

export function isSellerSpriteKeywordMiningBcrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOCAL_ACQUISITION_ENABLED === "true"
    && env.SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function execution(
  status: KeywordMiningQueryExecution["status"],
  input: {
    navigationPerformed?: boolean;
    querySubjectKey?: string | null;
    queryFingerprint?: string | null;
    errorCode: string | null;
    stopped?: boolean;
  },
): KeywordMiningQueryExecution {
  return {
    status,
    navigationPerformed: input.navigationPerformed ?? false,
    querySubjectKey: input.querySubjectKey ?? null,
    queryFingerprint: input.queryFingerprint ?? null,
    evidenceAttachmentId: null,
    evidenceContentHash: null,
    rowsObserved: 0,
    errorCode: input.errorCode,
    ...(input.stopped === undefined ? {} : { stopped: input.stopped }),
  };
}

/**
 * 复核已回读的关键词查询附件：来源、主体、模块、指标性质、查询身份与内容哈希
 * 必须全部一致。任何一项不成立即视为证据不可用，绝不放行。
 */
function verifiedKeywordQueryAttachment(input: {
  attachment: SourceEvidenceAttachment | undefined;
  evidence: V3ModuleEvidence | undefined;
  subjectKey: string;
  seedKeyword: string;
  queryFingerprint: string;
}): { rowsObserved: number } | null {
  const { attachment, evidence } = input;
  if (!attachment || !evidence) return null;
  if (attachment.subjectKey !== input.subjectKey
    || attachment.kind !== attachmentKindForV3Module("keyword_mining_trend")
    || attachment.sourceType !== "sellersprite_plugin"
    || !HASH_PATTERN.test(attachment.contentHash)
    || sourceEvidenceAttachmentContentHash({
      kind: attachment.kind,
      sourceType: attachment.sourceType,
      subjectKey: attachment.subjectKey,
      payload: attachment.payload,
    }) !== attachment.contentHash) return null;
  if (evidence.subjectKey !== input.subjectKey
    || evidence.module !== "keyword_mining_trend"
    || evidence.metricNature !== "provider_estimate"
    || evidence.identity.keyword?.normalize("NFC").trim().toLocaleLowerCase()
      !== input.seedKeyword.normalize("NFC").trim().toLocaleLowerCase()) return null;
  const data = evidence.data;
  const queryIdentity = isRecord(data.queryIdentity) ? data.queryIdentity : null;
  if (!queryIdentity
    || queryIdentity.subjectKey !== input.subjectKey
    || queryIdentity.module !== "keyword_mining_trend"
    || queryIdentity.queryFingerprint !== input.queryFingerprint) return null;
  const bindings = Array.isArray(data.rowEvidenceBindings) ? data.rowEvidenceBindings : [];
  const validRowKeys = new Set<string>();
  for (const raw of bindings) {
    if (!isRecord(raw)) continue;
    if (raw.status !== "valid") continue;
    if (typeof raw.rowKey !== "string" || !raw.rowKey.trim()) continue;
    if (typeof raw.rowContentHash !== "string" || !HASH_PATTERN.test(raw.rowContentHash)) continue;
    validRowKeys.add(raw.rowKey);
  }
  return { rowsObserved: validRowKeys.size };
}

/**
 * BCR Keyword Mining 只写 seedKeyword 查询级 Evidence：
 * 主体是 marketplace + seedKeyword + conditions + queryFingerprint，
 * 关键词行保持关键词级来源身份，**不投影到任何 ASIN 商品事实**，
 * 也不会让任何 ASIN×module 单元变为完成。
 */
export async function captureSellerSpriteKeywordMiningQueryForBatch(input: {
  context: AccessContext;
  query: { seedKeyword: string; conditions?: Record<string, string> };
  shouldStop?: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  maxWindows?: number;
}, deps: KeywordMiningWorkerDeps = {}): Promise<KeywordMiningQueryExecution> {
  let queryInput: Extract<SellerSpriteQueryInput, { module: "keyword_mining_trend" }>;
  try {
    const validated = validateSellerSpriteQueryInput({
      module: "keyword_mining_trend",
      seedKeyword: input.query.seedKeyword,
      marketplace: "US",
      conditions: input.query.conditions ?? {},
    }, "keyword_mining_trend");
    if (validated.module !== "keyword_mining_trend") throw new Error("SELLERSPRITE_QUERY_MODULE_MISMATCH");
    const conditions = Object.fromEntries(
      Object.entries(validated.conditions ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    );
    queryInput = {
      ...validated,
      seedKeyword: validated.seedKeyword.normalize("NFC").trim(),
      conditions,
    };
  } catch {
    return execution("failed", { errorCode: "SELLERSPRITE_KEYWORD_QUERY_INVALID" });
  }
  const querySubjectKey = sellerSpriteKeywordMiningQuerySubjectKey(queryInput);
  const queryFingerprint = sellerSpriteQueryFingerprint(queryInput, "bcr");
  if (!isSellerSpriteKeywordMiningBcrEnabled(input.env)) {
    return execution("blocked", {
      querySubjectKey,
      queryFingerprint,
      errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED",
    });
  }
  if (await input.shouldStop?.()) {
    return execution("blocked", {
      querySubjectKey,
      queryFingerprint,
      errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED",
      stopped: true,
    });
  }

  const captureQuery = deps.captureQuery ?? captureSellerSpriteVisibleQuery;
  const maxWindows = Number.isSafeInteger(input.maxWindows)
    ? Math.max(1, Math.min(20, input.maxWindows as number))
    : MAX_WINDOWS;
  let result: Awaited<ReturnType<typeof captureSellerSpriteVisibleQuery>>;
  try {
    result = await captureQuery({
      context: input.context,
      module: "keyword_mining_trend",
      sourceUrl: KEYWORD_MINING_URL,
      subjectKey: querySubjectKey,
      identity: { keyword: queryInput.seedKeyword },
      queryInput,
      attemptGeneration: 1,
      accountAccessFingerprint: "bcr",
      maxWindows,
      shouldStop: input.shouldStop,
    });
  } catch {
    return execution("failed", {
      querySubjectKey,
      queryFingerprint,
      navigationPerformed: true,
      errorCode: "SELLERSPRITE_KEYWORD_MINING_QUERY_FAILED",
    });
  }
  if (result.status === "human_required") {
    return execution("human_required", {
      querySubjectKey,
      queryFingerprint,
      navigationPerformed: true,
      errorCode: result.errorCode ?? "SELLERSPRITE_LOGIN_REQUIRED",
    });
  }
  if (result.status === "unavailable" || result.status === "failed"
    || result.status === "empty" || result.status === "query_error") {
    const code = result.errorCode ?? "SELLERSPRITE_KEYWORD_MINING_QUERY_FAILED";
    const human = /LOGIN|CAPTCHA|STOP|HUMAN/iu.test(code);
    return execution(human ? "human_required" : "failed", {
      querySubjectKey,
      queryFingerprint,
      navigationPerformed: true,
      errorCode: code,
    });
  }

  // captured / limited：以真实写后读回为准，绝不因为 Worker 返回成功就报告 captured。
  const persistedAttachmentId = [...(result.windows ?? [])]
    .reverse()
    .flatMap((window) => (window.capture ? [window.capture.attachment.attachmentId] : []))
    .at(0) ?? null;
  let evidenceStoreSubject: EvidenceSubjectRecord | null = null;
  try {
    const store = createEvidenceStore(sourceLayerOperator(input.context));
    evidenceStoreSubject = await store.getSubject(querySubjectKey);
  } catch {
    return execution("failed", {
      querySubjectKey,
      queryFingerprint,
      navigationPerformed: true,
      errorCode: "SELLERSPRITE_KEYWORD_MINING_EVIDENCE_READBACK_FAILED",
    });
  }
  const readBack = await readV3ModuleEvidence({
    context: input.context,
    subjectKey: querySubjectKey,
    module: "keyword_mining_trend",
  });
  const readBackHasQueryEvidence = readBack.modules.some((module) => {
    const queryIdentity = isRecord(module.data.queryIdentity) ? module.data.queryIdentity : null;
    return module.subjectKey === querySubjectKey
      && module.module === "keyword_mining_trend"
      && queryIdentity?.subjectKey === querySubjectKey
      && queryIdentity.queryFingerprint === queryFingerprint;
  });
  if (!readBackHasQueryEvidence) {
    return execution("failed", {
      querySubjectKey,
      queryFingerprint,
      navigationPerformed: true,
      errorCode: "SELLERSPRITE_KEYWORD_MINING_EVIDENCE_READBACK_FAILED",
    });
  }
  const candidates = (evidenceStoreSubject?.attachments ?? [])
    .filter((attachment) => persistedAttachmentId === null || attachment.attachmentId === persistedAttachmentId)
    .reverse();
  for (const attachment of candidates) {
    const verified = verifiedKeywordQueryAttachment({
      attachment,
      evidence: parseV3ModuleEvidence(attachment.payload) ?? undefined,
      subjectKey: querySubjectKey,
      seedKeyword: queryInput.seedKeyword,
      queryFingerprint,
    });
    if (!verified) continue;
    return {
      status: "captured",
      navigationPerformed: true,
      querySubjectKey,
      queryFingerprint,
      evidenceAttachmentId: attachment.attachmentId,
      evidenceContentHash: attachment.contentHash,
      rowsObserved: verified.rowsObserved,
      errorCode: null,
    };
  }
  return execution("blocked", {
    querySubjectKey,
    queryFingerprint,
    navigationPerformed: true,
    errorCode: result.status === "limited"
      ? (result.errorCode ?? "SELLERSPRITE_KEYWORD_MINING_SOURCE_LIMITED")
      : "SELLERSPRITE_KEYWORD_MINING_EVIDENCE_READBACK_INVALID",
  });
}
