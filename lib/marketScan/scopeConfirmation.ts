/**
 * 市场研究范围「人工确认」合同（P3 持久化版）。
 *
 * 语义边界：
 * - 人工确认与 `archivedAt` 严格分离：archive 是「是否参与市场统计」，scope 是「是否符合本次研究范围」；
 * - `UNREVIEWED` 表示「尚未人工核对」或「已撤销」，不是采集失败，也不等于不符合范围；
 * - 系统标题子类型只是辅助，永不写入人工状态；
 * - 过期确认（样本快照或研究目标变化）保留原始记录，但**不计入当前有效范围内/外**；
 * - 本模块不参与 `validSampleCount`、Market Gate、代表商品与 Research Handoff 的任何判定。
 *
 * 并发：人工确认使用独立 `scopeRevision` 做 CAS（与样本 `expectedVersion`、批次 `expectedScanHash` 并存）。
 */

export const SCOPE_CONFIRMATION_SCHEMA = "market-sample-scope-confirmation.v1" as const;
/** API 允许提交的操作 */
export const SCOPE_REVIEW_DECISIONS = ["IN_SCOPE", "OUT_OF_SCOPE", "UNREVIEWED"] as const;
/** 持久化状态（null = 从未确认；REVOKED = 用户主动撤销） */
export const PERSISTED_SCOPE_STATUSES = ["IN_SCOPE", "OUT_OF_SCOPE", "REVOKED"] as const;
export const SCOPE_REASON_MAX_LENGTH = 500 as const;

export type ScopeReviewDecision = (typeof SCOPE_REVIEW_DECISIONS)[number];
export type PersistedScopeStatus = (typeof PERSISTED_SCOPE_STATUSES)[number];
export type ScopeReviewStatus = "IN_SCOPE" | "OUT_OF_SCOPE" | "UNREVIEWED";
export type ScopeStaleReason = "SAMPLE_SNAPSHOT_CHANGED" | "RESEARCH_SCOPE_CHANGED";

export type ScopeConfirmationRecord = {
  readonly marketSampleKey: string;
  readonly status: PersistedScopeStatus;
  readonly reason: string | null;
  readonly sampleHash: string | null;
  readonly nicheHash: string | null;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
  readonly scopeRevision: number;
};

export type ScopeConfirmationRow = {
  readonly marketSampleKey: string;
  readonly asin: string;
  readonly subjectKey: string;
  readonly title: string | null;
  /** P2 系统推断子类型，仅作人工参考 */
  readonly systemSubtype: { readonly id: string; readonly label: string } | null;
  readonly reviewStatus: ScopeReviewStatus;
  /** 已保存确认是否过期（过期不计入有效范围） */
  readonly reviewStale: boolean;
  readonly staleReason: ScopeStaleReason | null;
  /** 用户主动撤销过（区别于「从未确认」） */
  readonly revoked: boolean;
  readonly review: ScopeConfirmationRecord | null;
  readonly currentVersion: string;
  readonly scopeRevision: number;
};

export type ScopeConfirmationSummary = {
  readonly total: number;
  /** 当前有效（未过期）人工确认 */
  readonly inScope: number;
  readonly outOfScope: number;
  /** 从未确认 + 已撤销（revoked 为其子集） */
  readonly unreviewed: number;
  readonly revoked: number;
  /** 有确认但已过期，需要重新核对；不计入 inScope/outOfScope，也不计入 unreviewed */
  readonly stale: number;
};

export type ScopeConfirmationInput = {
  readonly marketSampleKey: string;
  readonly asin: string;
  readonly subjectKey: string;
  readonly status: ScopeReviewDecision;
  readonly reason: string;
  readonly expectedVersion: string;
  readonly expectedScopeRevision: number;
};

export type ScopeConfirmationErrorCode =
  | "MARKET_SNAPSHOT_STALE"
  | "SAMPLE_KEY_INVALID"
  | "SAMPLE_NOT_IN_SCAN"
  | "SAMPLE_ASIN_MISMATCH"
  | "SAMPLE_SUBJECT_MISMATCH"
  | "SCOPE_STATUS_INVALID"
  | "SCOPE_REASON_REQUIRED"
  | "SAMPLE_VERSION_CONFLICT"
  | "SCOPE_REVISION_CONFLICT"
  | "DUPLICATE_SAMPLE_IN_BATCH"
  | "BATCH_EMPTY"
  | "BATCH_TOO_LARGE";

export type ScopeConfirmationError = {
  readonly marketSampleKey: string | null;
  readonly code: ScopeConfirmationErrorCode;
  readonly message: string;
};

export type ScopeConfirmationValidation =
  | {
    readonly ok: true;
    readonly normalized: readonly ScopeConfirmationInput[];
    readonly idempotent: boolean;
  }
  | { readonly ok: false; readonly errors: readonly ScopeConfirmationError[] };

const MAX_BATCH = 200;

function normalizedAsin(value: string): string {
  return value.trim().toUpperCase();
}

/** 过期判定：样本快照或研究目标任一变化，旧确认即失效（保留历史，不计入有效范围）。 */
export function scopeConfirmationStaleReason(input: {
  readonly record: ScopeConfirmationRecord | null;
  readonly currentSampleHash: string;
  readonly currentNicheHash: string;
}): ScopeStaleReason | null {
  const { record } = input;
  if (!record) return null;
  // 已撤销不是「确认」，不参与过期判定；它直接计入未确认（revoked 子集）
  if (record.status === "REVOKED") return null;
  if (record.sampleHash !== input.currentSampleHash) return "SAMPLE_SNAPSHOT_CHANGED";
  if (record.nicheHash !== input.currentNicheHash) return "RESEARCH_SCOPE_CHANGED";
  return null;
}

/**
 * 逐样本投影：合并当前样本快照与已保存确认。
 * 未确认一律 UNREVIEWED；过期确认保留记录但 reviewStale=true 且不计入有效统计。
 */
export function buildScopeConfirmationRows(input: {
  readonly scanId: string;
  readonly sampleHash: string;
  readonly nicheHash: string;
  readonly samples: ReadonlyArray<{
    asin: string;
    subjectKey: string;
    title?: string | null;
    systemSubtype?: { id: string; label: string } | null;
    currentVersion: string;
  }>;
  readonly confirmations?: readonly ScopeConfirmationRecord[];
}): ScopeConfirmationRow[] {
  const byKey = new Map<string, ScopeConfirmationRecord>();
  for (const record of input.confirmations ?? []) byKey.set(record.marketSampleKey, record);

  return input.samples.map((sample) => {
    const marketSampleKey = `${input.scanId}:${normalizedAsin(sample.asin)}`;
    const record = byKey.get(marketSampleKey) ?? null;
    const staleReason = scopeConfirmationStaleReason({
      record,
      currentSampleHash: input.sampleHash,
      currentNicheHash: input.nicheHash,
    });
    const stale = staleReason !== null;
    const persisted = record?.status ?? null;
    const reviewStatus: ScopeReviewStatus = stale
      ? "UNREVIEWED"
      : persisted === "IN_SCOPE" || persisted === "OUT_OF_SCOPE"
        ? persisted
        : "UNREVIEWED";
    return {
      marketSampleKey,
      asin: normalizedAsin(sample.asin),
      subjectKey: sample.subjectKey,
      title: sample.title ?? null,
      systemSubtype: sample.systemSubtype ?? null,
      reviewStatus,
      reviewStale: stale,
      staleReason,
      revoked: persisted === "REVOKED" && !stale,
      review: record,
      currentVersion: sample.currentVersion,
      scopeRevision: record?.scopeRevision ?? 0,
    };
  });
}

/**
 * 范围统计：只统计当前有效的人工确认。
 * 不变式：total = inScope + outOfScope + unreviewed + stale（revoked ⊂ unreviewed）。
 */
export function summarizeScopeConfirmations(
  rows: readonly ScopeConfirmationRow[],
): ScopeConfirmationSummary {
  let inScope = 0;
  let outOfScope = 0;
  let unreviewed = 0;
  let revoked = 0;
  let stale = 0;
  for (const row of rows) {
    if (row.reviewStale) {
      stale += 1;
      continue;
    }
    if (row.reviewStatus === "IN_SCOPE") inScope += 1;
    else if (row.reviewStatus === "OUT_OF_SCOPE") outOfScope += 1;
    else {
      unreviewed += 1;
      if (row.revoked) revoked += 1;
    }
  }
  return { total: rows.length, inScope, outOfScope, unreviewed, revoked, stale };
}

/**
 * 批量保存前的服务端校验（纯函数）。任一错误整批拒绝，不做部分写入。
 * 三个版本维度必须同时成立：批次 expectedScanHash、样本 expectedVersion、人工确认 expectedScopeRevision。
 */
export function validateScopeConfirmationBatch(input: {
  readonly scanId: string;
  readonly sampleHash: string;
  readonly expectedScanHash: string;
  readonly rows: readonly ScopeConfirmationRow[];
  readonly items: readonly ScopeConfirmationInput[];
}): ScopeConfirmationValidation {
  if (input.expectedScanHash !== input.sampleHash) {
    return {
      ok: false,
      errors: [{ marketSampleKey: null, code: "MARKET_SNAPSHOT_STALE", message: "市场样本快照已变化，请刷新后重新核对。" }],
    };
  }
  if (input.items.length === 0) {
    return { ok: false, errors: [{ marketSampleKey: null, code: "BATCH_EMPTY", message: "没有需要保存的确认项。" }] };
  }
  if (input.items.length > MAX_BATCH) {
    return { ok: false, errors: [{ marketSampleKey: null, code: "BATCH_TOO_LARGE", message: `一次最多保存 ${MAX_BATCH} 条确认。` }] };
  }

  const rowByKey = new Map(input.rows.map((row) => [row.marketSampleKey, row]));
  const seen = new Set<string>();
  const errors: ScopeConfirmationError[] = [];
  const normalized: ScopeConfirmationInput[] = [];
  let allIdempotent = true;

  for (const item of input.items) {
    const key = typeof item.marketSampleKey === "string" ? item.marketSampleKey.trim() : "";
    if (!key) {
      errors.push({ marketSampleKey: null, code: "SAMPLE_KEY_INVALID", message: "缺少 marketSampleKey。" });
      continue;
    }
    if (seen.has(key)) {
      errors.push({ marketSampleKey: key, code: "DUPLICATE_SAMPLE_IN_BATCH", message: "同一批次不能重复确认同一个样本。" });
      continue;
    }
    seen.add(key);

    const row = rowByKey.get(key);
    if (!row) {
      errors.push({ marketSampleKey: key, code: "SAMPLE_NOT_IN_SCAN", message: "该样本不属于当前市场快照。" });
      continue;
    }
    if (!(SCOPE_REVIEW_DECISIONS as readonly string[]).includes(item.status)) {
      errors.push({ marketSampleKey: key, code: "SCOPE_STATUS_INVALID", message: "确认结果必须是 IN_SCOPE、OUT_OF_SCOPE 或 UNREVIEWED。" });
      continue;
    }
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    if (item.status !== "UNREVIEWED" && (!reason || reason.length > SCOPE_REASON_MAX_LENGTH)) {
      errors.push({
        marketSampleKey: key,
        code: "SCOPE_REASON_REQUIRED",
        message: `必须填写 1～${SCOPE_REASON_MAX_LENGTH} 字符的确认理由。`,
      });
      continue;
    }
    if (reason.length > SCOPE_REASON_MAX_LENGTH) {
      errors.push({ marketSampleKey: key, code: "SCOPE_REASON_REQUIRED", message: `理由不能超过 ${SCOPE_REASON_MAX_LENGTH} 字符。` });
      continue;
    }
    if (normalizedAsin(item.asin) !== row.asin) {
      errors.push({ marketSampleKey: key, code: "SAMPLE_ASIN_MISMATCH", message: "ASIN 与该样本不一致，拒绝跨商品确认。" });
      continue;
    }
    if (item.subjectKey.trim() !== row.subjectKey) {
      errors.push({ marketSampleKey: key, code: "SAMPLE_SUBJECT_MISMATCH", message: "证据主体与该样本不一致，拒绝跨商品确认。" });
      continue;
    }
    if (item.expectedVersion !== row.currentVersion) {
      errors.push({
        marketSampleKey: key,
        code: "SAMPLE_VERSION_CONFLICT",
        message: "该样本已变化，请刷新后重新核对（旧确认不会静默覆盖）。",
      });
      continue;
    }
    if (!Number.isSafeInteger(item.expectedScopeRevision) || item.expectedScopeRevision !== row.scopeRevision) {
      errors.push({
        marketSampleKey: key,
        code: "SCOPE_REVISION_CONFLICT",
        message: "该样本的人工确认已被其他操作更新，请刷新后重试。",
      });
      continue;
    }

    const sameAsStored = item.status === "UNREVIEWED"
      ? row.reviewStatus === "UNREVIEWED" && !row.revoked && !row.reviewStale
      : row.reviewStatus === item.status
        && !row.reviewStale
        && (row.review?.reason ?? null) === reason;
    if (!sameAsStored) allIdempotent = false;

    normalized.push({
      marketSampleKey: key,
      asin: row.asin,
      subjectKey: row.subjectKey,
      status: item.status,
      reason,
      expectedVersion: row.currentVersion,
      expectedScopeRevision: row.scopeRevision,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, normalized, idempotent: allIdempotent };
}
