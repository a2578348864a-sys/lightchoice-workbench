/**
 * Product Source Layer V1.2 — Validator（Phase 3）
 *
 * 职责：数据进入研究流程前的最后一道确定性门禁。
 * 检查：字段完整性 / 格式正确性 / 来源可信度 / 数据冲突。
 *
 * 红线（不可协商）：
 * - fail-closed：阻断级错误一律不允许进入 READY_FOR_RESEARCH；
 * - 禁止自动补全缺失事实：本模块只读取与判定，从不写入、从不猜测、从不用默认值填空；
 * - 不调用 LLM、不访问网络、不读写数据库。
 *
 * 纯函数：无 IO / 无随机。now 与上一版本包必须由调用方注入。
 */
import {
  CAPTURE_FIELD_KEYS,
  SOURCE_TYPES,
  defaultCaptureMethodFor,
  deriveRiskFlags,
  sourceAllowsConfirmed,
  sourceTrustLevelOf,
  type CaptureFieldKey,
  type CapturePackage,
  type CaptureSourceType,
} from "@/lib/sourceLayer/capturePackage";
import {
  appendAuditEntries,
  type AuditLogEntry,
} from "@/lib/sourceLayer/auditLog";
import {
  SOURCE_LAYER_ERROR_REGISTRY,
  createSourceLayerError,
  type SourceLayerError,
  type SourceLayerErrorCode,
} from "@/lib/sourceLayer/errorCodes";
import {
  evaluateFieldExpiration,
  type FieldExpiration,
  type FieldExpirationPolicy,
} from "@/lib/sourceLayer/expiration";

export const CAPTURE_VALIDATION_SCHEMA = "source-capture-validation.v1" as const;

export const VALIDATION_VERDICTS = ["passed", "needs_review", "blocked"] as const;
export type ValidationVerdict = (typeof VALIDATION_VERDICTS)[number];

export type ValidationIssue = {
  error: SourceLayerError;
  field: CaptureFieldKey | null;
  /** 人话说明（面向操作者，不暴露内部实现）。 */
  hint: string;
};

export type FieldValidationDetail = {
  field: CaptureFieldKey;
  status: CapturePackage["fieldStates"][CaptureFieldKey]["status"];
  confidence: number;
  expiration: FieldExpiration;
  issues: SourceLayerError["code"][];
};

export type CaptureValidationReport = {
  schemaVersion: typeof CAPTURE_VALIDATION_SCHEMA;
  captureId: string;
  subjectKey: string;
  version: number;
  verdict: ValidationVerdict;
  /** 是否可以进入研究流程（只有 passed 为 true）。 */
  readyForResearch: boolean;
  issues: ValidationIssue[];
  fieldDetails: FieldValidationDetail[];
  checkedAt: string;
  /**
   * 落地用的有效采集包：冲突字段已被标记为 conflict（含并列值）。
   * 校验本身不改动入参，调用方决定是否持久化这一版本。
   */
  effectivePackage: CapturePackage;
};

/** 关键字段：缺失即阻断（无法确认研究对象的身份与基本盘）。 */
export const BLOCKING_FIELDS: readonly CaptureFieldKey[] = ["asin", "title"];

/** 重要但非阻断字段：缺失进入 needs_review。 */
export const REVIEW_FIELDS: readonly CaptureFieldKey[] = [
  "images",
  "price",
  "rating",
  "reviewCount",
];

/**
 * AI 主张：当上游把 AI 结论交回本层时必须声明来源强度。
 * 本层只做零容忍判定，不做语义理解。
 */
export type AiClaim = {
  claimId: string;
  /** 结论文本（仅用于展示与审计摘要，不参与语义推断）。 */
  text: string;
  /** 生成该主张的模型标识；为空表示来源不明。 */
  generatedBy: string | null;
  /** 支撑该主张的 captureId 列表。 */
  evidenceCaptureIds: readonly string[];
  /** 上游是否把它标成了事实（true 即视为违规候选）。 */
  presentedAsFact: boolean;
};

export type CaptureValidationContext = {
  now: Date | number | string;
  /** 同一 subjectKey 的历史采集包（新→旧或旧→新均可，内部会排序）。 */
  previousPackages?: readonly CapturePackage[];
  fieldPolicy?: FieldExpirationPolicy | null;
  /** 可选：交回本层审计的 AI 主张。 */
  aiClaims?: readonly AiClaim[];
  /** 允许的来源类型白名单（缺省为契约内全部可信来源）。 */
  allowedSourceTypes?: readonly CaptureSourceType[];
  /** 采集阶段已经确定的错误；必须进入同一份验证报告与审计。 */
  captureErrorCodes?: readonly SourceLayerErrorCode[];
};

const PLACEHOLDER_VALUES = new Set([
  "-",
  "--",
  "n/a",
  "na",
  "null",
  "none",
  "unknown",
  "未知",
  "暂无",
  "无",
]);

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 图片来源格式：公网 https 直链，或已落库的内联图片
 * （`data:image/jpeg|png;base64,…`）。
 *
 * 内联图片不是「放宽要求」：它是已经校验过魔数与大小的图片字节本身
 * （例如 ProductBatch 缓存的主图），比一个随时可能失效的 HTTPS 链接更可信。
 * 其它协议（http / file / javascript）与其它 MIME 一律拒绝。
 */
const INLINE_IMAGE_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

function isAcceptableImageReference(value: string): boolean {
  return isSafeHttpsUrl(value) || INLINE_IMAGE_PATTERN.test(value);
}

function issue(
  code: Parameters<typeof createSourceLayerError>[0],
  field: CaptureFieldKey | null,
  hint: string,
  options: { detail?: Record<string, string | number | boolean | null>; message?: string } = {},
): ValidationIssue {
  return {
    error: createSourceLayerError(code, {
      ...(field ? { field } : {}),
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.message ? { message: options.message } : {}),
    }),
    field,
    hint,
  };
}

/* ── 1. 字段完整性与格式 ─────────────────────────────────────────── */

function checkFields(
  pkg: CapturePackage,
  now: Date | number | string,
  policy: FieldExpirationPolicy | null | undefined,
): { issues: ValidationIssue[]; details: FieldValidationDetail[] } {
  const issues: ValidationIssue[] = [];
  const details: FieldValidationDetail[] = [];
  const states = pkg.fieldStates;
  const fields = pkg.fields;

  const fieldIssues = new Map<CaptureFieldKey, SourceLayerError["code"][]>();
  const push = (field: CaptureFieldKey, item: ValidationIssue) => {
    issues.push(item);
    const list = fieldIssues.get(field) ?? [];
    list.push(item.error.code);
    fieldIssues.set(field, list);
  };

  // 字段全集直接取自契约常量：手写子集会让新增字段（brand / subCategoryBsr /
  // estimatedMonthlySales / estimatedMonthlyRevenueUsd）静默绕过校验与明细，
  // 出现「字段在包里但没人验证」的漏洞。
  for (const field of CAPTURE_FIELD_KEYS) {
    const expiration = evaluateFieldExpiration({
      field,
      capturedAt: pkg.sourceProof.capturedAt,
      present: states[field].status !== "missing",
      now,
      policy,
    });
    if (expiration.state === "expired") {
      push(field, issue("SOURCE_EXPIRED", field, `「${field}」已超过有效期，需要重新采集。`, {
        detail: { ttlMs: expiration.ttlMs, ageMs: expiration.ageMs },
      }));
    }
    if (states[field].status === "conflict") {
      push(field, issue("FIELD_CONFLICT", field, `「${field}」存在并列冲突值，必须人工裁定。`, {
        detail: {
          alternatives: (states[field].conflictWith ?? [])
            .map((item) => `${item.sourceRef}=${item.value}`)
            .join(" | ")
            .slice(0, 300),
        },
      }));
    }
    if (states[field].status === "missing") {
      if (BLOCKING_FIELDS.includes(field)) {
        push(field, issue("FIELD_MISSING", field, `「${field}」是研究对象身份的必要字段，不能为空。`));
      } else if (REVIEW_FIELDS.includes(field)) {
        push(field, issue("FIELD_MISSING", field, `「${field}」缺失，需人工确认是否继续。`));
      }
    } else if (states[field].status === "estimated" && states[field].confidence < 0.5) {
      push(field, issue("LOW_CONFIDENCE", field, `「${field}」由低可信方式得到，需人工复核。`, {
        detail: { confidence: states[field].confidence, valueOrigin: states[field].valueOrigin },
      }));
    }
    // 非可信来源不得产出 confirmed（防御性：即使包被外部篡改也拦下）。
    if (states[field].status === "confirmed" && !sourceAllowsConfirmed(pkg.sourceProof.sourceType)) {
      push(field, issue("SOURCE_UNTRUSTED", field, `「${field}」被标为 confirmed，但该来源不允许产出确认值。`));
    }
    if (states[field].status === "estimated" && states[field].confidence >= 1) {
      push(field, issue("LOW_CONFIDENCE", field, `「${field}」估算值置信度异常，已按低可信处理。`, {
        detail: { confidence: states[field].confidence },
      }));
    }
    details.push({
      field,
      status: states[field].status,
      confidence: states[field].confidence,
      expiration,
      issues: fieldIssues.get(field) ?? [],
    });
  }

  // 格式专项
  if (fields.asin !== null && !/^[A-Z0-9]{10}$/.test(fields.asin)) {
    push("asin", issue("INVALID_FORMAT", "asin", "ASIN 必须是 10 位大写字母或数字。"));
  }
  if (typeof fields.title === "string" && isPlaceholder(fields.title)) {
    push("title", issue("INVALID_FORMAT", "title", "标题是占位符（如 N/A、未知），不算有效值。"));
  }
  for (const [index, image] of fields.images.entries()) {
    if (!isAcceptableImageReference(image)) {
      push("images", issue("INVALID_FORMAT", "images", `第 ${index + 1} 张图片不是可用的 https 直链或已校验的内联图片。`, {
        detail: { index },
      }));
      break;
    }
  }
  if (fields.price && !/^[A-Z]{3}$/.test(fields.price.currency)) {
    push("price", issue("INVALID_FORMAT", "price", "价格缺少合法的三字母货币代码。"));
  }
  if (fields.rating !== null && (fields.rating < 0 || fields.rating > 5)) {
    push("rating", issue("INVALID_FORMAT", "rating", "评分必须在 0 到 5 之间。"));
  }
  if (fields.reviewCount !== null && fields.reviewCount < 0) {
    push("reviewCount", issue("INVALID_FORMAT", "reviewCount", "评论数不能为负数。"));
  }
  if (fields.bsr !== null && (!Number.isSafeInteger(fields.bsr.rank) || fields.bsr.rank < 1)) {
    push("bsr", issue("INVALID_FORMAT", "bsr", "BSR 排名必须是大于 0 的整数。"));
  }

  return { issues, details };
}

/* ── 2. 来源可信度 ───────────────────────────────────────────────── */

function sourceHostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function amazonSubjectIdentity(subjectKey: string): { marketplace: string; asin: string } | null {
  const match = /^amazon:([A-Z]{2}):([A-Z0-9]{10})$/i.exec(subjectKey);
  return match
    ? { marketplace: match[1].toUpperCase(), asin: match[2].toUpperCase() }
    : null;
}

/** 来源类型 → 允许的 host 后缀（空集合表示不限制 host）。 */
const SOURCE_HOST_ALLOWLIST: Readonly<Record<CaptureSourceType, readonly string[]>> =
  Object.freeze({
    amazon_dom: ["amazon.com"],
    sellersprite_plugin: ["amazon.com", "sellersprite.com"],
    sellersprite_xlsx: ["amazon.com", "sellersprite.com"],
    sellersprite_api: ["amazon.com", "sellersprite.com"],
    keepa_export: ["amazon.com", "keepa.com"],
    manual_entry: [],
    excel_upload: ["amazon.com"],
    public_api: [],
    browser_agent: ["amazon.com"],
  });

function hostAllowed(sourceType: CaptureSourceType, host: string | null): boolean {
  const allowlist = SOURCE_HOST_ALLOWLIST[sourceType] ?? [];
  if (allowlist.length === 0) return true;
  if (!host) return false;
  return allowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function checkSource(
  pkg: CapturePackage,
  now: Date | number | string,
  allowedSourceTypes: readonly CaptureSourceType[] | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const proof = pkg.sourceProof;

  if (!SOURCE_TYPES.includes(proof.sourceType)) {
    issues.push(issue("SOURCE_UNTRUSTED", null, "来源类型不在允许清单内。"));
    return issues;
  }
  if (allowedSourceTypes && !allowedSourceTypes.includes(proof.sourceType)) {
    issues.push(issue("SOURCE_UNTRUSTED", null, "该来源类型未被当前策略允许。", {
      detail: { sourceType: proof.sourceType },
    }));
  }
  const trust = sourceTrustLevelOf(proof.sourceType);
  if (trust === "untrusted") {
    issues.push(issue("SOURCE_UNTRUSTED", null, "该来源被判定为不可信，禁止进入研究流程。"));
  }
  const expectedMethod = defaultCaptureMethodFor(proof.sourceType);
  if (proof.captureMethod !== expectedMethod) {
    issues.push(issue("SOURCE_UNTRUSTED", null, "采集方式与来源类型不匹配。", {
      detail: { captureMethod: proof.captureMethod, expectedMethod },
    }));
  }

  const subjectIdentity = amazonSubjectIdentity(pkg.subjectKey);
  if (subjectIdentity) {
    if (pkg.marketplace.toUpperCase() !== subjectIdentity.marketplace) {
      issues.push(issue(
        "MARKETPLACE_MISMATCH",
        "asin",
        "商品 marketplace 与 subjectKey 不一致，已拒绝写入该主体的证据。",
      ));
    }
    if (pkg.fields.asin !== subjectIdentity.asin) {
      issues.push(issue(
        "ASIN_NOT_FOUND",
        "asin",
        "商品 ASIN 与 subjectKey 不一致，已拒绝写入该主体的证据。",
      ));
    }
  }

  const capturedMs = Date.parse(proof.capturedAt);
  const nowMs = now instanceof Date
    ? now.getTime()
    : typeof now === "number"
      ? now
      : Date.parse(now);
  if (!Number.isFinite(capturedMs)) {
    issues.push(issue("SOURCE_MISSING", null, "采集时间不合法。"));
  } else if (Number.isFinite(nowMs)) {
    // 允许 5 分钟时钟偏差，超出即视为未来时间（数据可信度问题）。
    if (capturedMs - nowMs > 5 * 60 * 1000) {
      issues.push(issue("INVALID_FORMAT", null, "采集时间晚于当前时间，无法采信。"));
    }
  }

  const host = sourceHostOf(proof.sourceUrl);
  const requiresUrl = proof.sourceType !== "manual_entry";
  if (requiresUrl && !proof.sourceUrl) {
    issues.push(issue("SOURCE_MISSING", null, "该来源必须提供可核验的来源 URL。"));
  }
  if (proof.sourceUrl && !isSafeHttpsUrl(proof.sourceUrl)) {
    issues.push(issue("INVALID_FORMAT", null, "来源 URL 必须是公网 https 地址。"));
  }
  if (proof.sourceUrl && !hostAllowed(proof.sourceType, host)) {
    issues.push(issue("SOURCE_UNTRUSTED", null, "来源 URL 的域名与该来源类型不一致。", {
      detail: { host: host ?? "", sourceType: proof.sourceType },
    }));
  }
  if (!proof.operator.trim()) {
    issues.push(issue("SOURCE_MISSING", null, "缺少采集操作者（operator）。"));
  }
  if (proof.sourceType === "manual_entry" && proof.sourceFingerprint) {
    // 人工录入不应伪装成有文件指纹的自动来源。
    issues.push(issue("SOURCE_UNTRUSTED", null, "人工录入不应携带来源文件指纹。"));
  }

  // 新采集包携带实体绑定证明时，证明失败必须阻断；旧包没有该字段时
  // 保持可读兼容，不能把历史数据静默改判为新错误。
  if (proof.entityBinding && proof.sourceType !== "manual_entry") {
    const binding = proof.entityBinding;
    if (!binding.bound
      || binding.expectedAsin === null
      || binding.observedAsin !== binding.expectedAsin
      || binding.urlAsin !== binding.expectedAsin
      || binding.observedMarketplace !== binding.expectedMarketplace
      || binding.urlMarketplace !== binding.expectedMarketplace) {
      issues.push(issue(
        binding.urlMarketplace && binding.urlMarketplace !== binding.expectedMarketplace
          ? "MARKETPLACE_MISMATCH"
          : "ASIN_NOT_FOUND",
        "asin",
        "来源页面没有证明是目标商品，已拒绝把页面字段写入正式 Evidence。",
      ));
    }
  }

  return issues;
}

function captureErrorIssues(codes: readonly SourceLayerErrorCode[] | undefined): ValidationIssue[] {
  return (codes ?? []).map((code) => ({
    error: createSourceLayerError(code),
    field: null,
    hint: createSourceLayerError(code).message,
  }));
}

/* ── 3. 数据冲突（跨版本 + 跨来源） ──────────────────────────────── */

function fieldComparable(pkg: CapturePackage, field: CaptureFieldKey): string | null {
  const state = pkg.fieldStates[field];
  if (state.status === "missing" || state.status === "conflict") return null;
  const value = pkg.fields[field];
  if (value === null) return null;
  return JSON.stringify(value);
}

/**
 * 描述型字段只在同一来源类型、采集方式、采集时刻和来源字段下比较。
 * 不同 Provider 或不同时间的值是独立 Evidence snapshot，不在本层融合或互相阻断。
 * ASIN 是身份字段，跨 Provider / 时间的冲突仍始终 fail-closed。
 */
export const CONFLICT_CHECKED_FIELDS: readonly CaptureFieldKey[] = ["asin", "title", "images", "brand"];

function sameFieldScopeAndTime(
  current: CapturePackage,
  previous: CapturePackage,
  field: CaptureFieldKey,
): boolean {
  if (current.sourceProof.sourceType !== previous.sourceProof.sourceType
    || current.sourceProof.captureMethod !== previous.sourceProof.captureMethod
    || current.fieldStates[field].sourceRef !== previous.fieldStates[field].sourceRef) {
    return false;
  }
  const currentAt = Date.parse(current.sourceProof.capturedAt);
  const previousAt = Date.parse(previous.sourceProof.capturedAt);
  return Number.isFinite(currentAt) && currentAt === previousAt;
}

function checkConflicts(
  pkg: CapturePackage,
  previousPackages: readonly CapturePackage[],
): { issues: ValidationIssue[]; fieldStates: CapturePackage["fieldStates"] } {
  const issues: ValidationIssue[] = [];
  const sameSubject = previousPackages
    .filter((candidate) => candidate.subjectKey === pkg.subjectKey)
    .filter((candidate) => candidate.captureId !== pkg.captureId)
    .sort((left, right) => right.version - left.version);
  if (sameSubject.length === 0) return { issues, fieldStates: pkg.fieldStates };

  const subjectIdentity = amazonSubjectIdentity(pkg.subjectKey);
  const currentAsin = pkg.fields.asin;
  const identityAsinConflicts = sameSubject.filter((candidate) => (
    (currentAsin !== null && candidate.fields.asin !== null && candidate.fields.asin !== currentAsin)
    || (subjectIdentity !== null && candidate.fields.asin !== subjectIdentity.asin)
  ));
  const identityMarketplaceConflicts = sameSubject.filter((candidate) => (
    candidate.marketplace.toUpperCase() !== pkg.marketplace.toUpperCase()
    || (subjectIdentity !== null && candidate.marketplace.toUpperCase() !== subjectIdentity.marketplace)
  ));
  const conflictWith: Partial<Record<CaptureFieldKey, Array<{ value: string; sourceRef: string }>>> = {};

  if (identityAsinConflicts.length > 0) {
    const alternatives = identityAsinConflicts.flatMap((candidate) => {
      return candidate.fields.asin === null ? [] : [{
        value: JSON.stringify(candidate.fields.asin),
        sourceRef: `capture:${candidate.captureId}@v${candidate.version}`,
      }];
    });
    if (alternatives.length > 0) {
      conflictWith.asin = alternatives;
      issues.push(issue("FIELD_CONFLICT", "asin", "同一 subjectKey 下存在不同 ASIN，已阻断身份冲突。", {
        detail: { subjectKey: pkg.subjectKey },
      }));
    }
  }
  if (identityMarketplaceConflicts.length > 0) {
    issues.push(issue("MARKETPLACE_MISMATCH", "asin", "同一 subjectKey 下存在不同 marketplace，已阻断身份冲突。", {
      detail: { subjectKey: pkg.subjectKey },
    }));
  }

  for (const field of ["title", "images", "brand"] as const) {
    const current = fieldComparable(pkg, field);
    if (current === null) continue;
    const comparablePackages = sameSubject.filter((candidate) => sameFieldScopeAndTime(pkg, candidate, field));
    const alternatives = comparablePackages.flatMap((candidate) => {
      const previous = fieldComparable(candidate, field);
      return previous === null || previous === current
        ? []
        : [{ value: previous, sourceRef: `capture:${candidate.captureId}@v${candidate.version}` }];
    });
    if (alternatives.length === 0) continue;
    conflictWith[field] = alternatives;
    issues.push(issue("FIELD_CONFLICT", field, `「${field}」在相同来源、时间与字段范围下存在不兼容值。`, {
      detail: {
        currentCaptureId: pkg.captureId,
        previousCaptureId: comparablePackages[0].captureId,
        previousVersion: comparablePackages[0].version,
      },
    }));
  }

  if (Object.keys(conflictWith).length === 0) return { issues, fieldStates: pkg.fieldStates };
  const merged: CapturePackage["fieldStates"] = { ...pkg.fieldStates };
  for (const [field, alternatives] of Object.entries(conflictWith) as Array<
    [CaptureFieldKey, Array<{ value: string; sourceRef: string }>]
  >) {
    merged[field] = { ...merged[field], status: "conflict", conflictWith: alternatives };
  }
  return { issues, fieldStates: merged };
}

/* ── 4. AI 主张零容忍 ────────────────────────────────────────────── */

function checkAiClaims(
  pkg: CapturePackage,
  claims: readonly AiClaim[] | undefined,
): ValidationIssue[] {
  if (!claims || claims.length === 0) return [];
  const issues: ValidationIssue[] = [];
  for (const claim of claims) {
    const hasEvidence = claim.evidenceCaptureIds.includes(pkg.captureId);
    if (claim.presentedAsFact && (!claim.generatedBy || claim.evidenceCaptureIds.length === 0)) {
      issues.push(issue(
        "AI_GENERATED_AS_FACT",
        null,
        `AI 主张「${claim.claimId}」被标为事实但没有可追溯来源。`,
        { detail: { claimId: claim.claimId } },
      ));
      continue;
    }
    if (claim.evidenceCaptureIds.length === 0) {
      issues.push(issue("NO_EVIDENCE", null, `AI 主张「${claim.claimId}」完全没有证据引用。`, {
        detail: { claimId: claim.claimId },
      }));
      continue;
    }
    if (!hasEvidence) {
      issues.push(issue("UNSUPPORTED_CLAIM", null, `AI 主张「${claim.claimId}」引用了不属于本次采集的证据。`, {
        detail: { claimId: claim.claimId },
      }));
    }
  }
  return issues;
}

/* ── 主入口 ──────────────────────────────────────────────────────── */

export function validateCapturePackage(
  pkg: CapturePackage,
  context: CaptureValidationContext,
): CaptureValidationReport {
  const nowIso = context.now instanceof Date
    ? context.now.toISOString()
    : typeof context.now === "number"
      ? new Date(context.now).toISOString()
      : new Date(Date.parse(context.now)).toISOString();

  // 顺序很重要：先做跨版本冲突判定并落到字段状态，再做字段检查，
  // 这样冲突项才能在 fieldDetails 里被看到（否则冲突结论与字段明细会互相矛盾）。
  const conflictResult = checkConflicts(pkg, context.previousPackages ?? []);
  const effectivePkg: CapturePackage = conflictResult.fieldStates === pkg.fieldStates
    ? pkg
    : { ...pkg, fieldStates: conflictResult.fieldStates };

  const fieldResult = checkFields(effectivePkg, context.now, context.fieldPolicy);
  const sourceIssues = checkSource(effectivePkg, context.now, context.allowedSourceTypes);
  const aiIssues = checkAiClaims(effectivePkg, context.aiClaims);
  const captureIssues = captureErrorIssues(context.captureErrorCodes);

  const issues = [
    ...sourceIssues,
    ...fieldResult.issues,
    ...conflictResult.issues,
    ...aiIssues,
    ...captureIssues,
  ];
  const blocking = issues.filter((item) => item.error.severity === "blocking");
  const warnings = issues.filter((item) => item.error.severity === "warning");

  // fail-closed：只要存在阻断项就不允许进入研究流程。
  const verdict: ValidationVerdict = blocking.length > 0
    ? "blocked"
    : warnings.length > 0
      ? "needs_review"
      : "passed";

  return {
    schemaVersion: CAPTURE_VALIDATION_SCHEMA,
    captureId: pkg.captureId,
    subjectKey: pkg.subjectKey,
    version: pkg.version,
    verdict,
    readyForResearch: verdict === "passed",
    issues,
    fieldDetails: fieldResult.details,
    checkedAt: nowIso,
    effectivePackage: effectivePkg,
  };
}

/** 安全范围内可用的错误码子集（供风险标记派生使用）。 */
function asErrorCodeSubset(codes: readonly string[]): SourceLayerError[] {
  return codes.flatMap((code) => {
    const entry = SOURCE_LAYER_ERROR_REGISTRY[code as SourceLayerErrorCode];
    return entry ? [createSourceLayerError(entry.code)] : [];
  });
}

export type CaptureValidationOutcome = {
  pkg: CapturePackage;
  report: CaptureValidationReport;
};

/**
 * 校验并给出「可落地」的采集包。
 *
 * 这是各 Adapter 唯一应当使用的校验入口：它保证
 * 1. 冲突字段被标成 conflict（含并列值）；
 * 2. 风险标记由归一后的字段状态与本次校验错误**确定性派生**。
 *
 * 早期版本把 riskFlags 留给调用方，结果两条采集路径都没填，
 * 使风险信息在证据里静默为空——风险信息是 V1.2 Phase 2 的必含项，
 * 不能依赖调用方记得调用某个收尾函数。
 */
export function validateCaptureReport(
  pkg: CapturePackage,
  context: CaptureValidationContext,
): CaptureValidationOutcome {
  const report = validateCapturePackage(pkg, context);
  const effective = report.effectivePackage;
  return {
    pkg: {
      ...effective,
      riskFlags: deriveRiskFlags({
        fields: effective.fields,
        fieldStates: effective.fieldStates,
        sourceType: effective.sourceProof.sourceType,
        errors: asErrorCodeSubset(report.issues.map((item) => item.error.code)),
      }),
    },
    report,
  };
}

/** 校验结果 → 审计条目（Phase 4：所有异常进入 Audit Log）。 */
export function validationAuditEntries(input: {
  report: CaptureValidationReport;
  operator: string;
  captureId: string;
  subjectKey: string;
}): AuditLogEntry[] {
  const securityAuditCodes = new Set([
    "AI_GENERATED_AS_FACT",
    "ENTITY_BINDING_FAILED",
    "PROVIDER_PERMISSION_DENIED",
    "PROVIDER_QUOTA_EXHAUSTED",
    "PLAN_LIMIT",
    "LOGIN_REQUIRED",
    "CAPTCHA_DETECTED",
    "AUDIT_REQUIRED",
    "PERSISTENCE_FAILED",
    "HANDOFF_FAILED",
  ] as const);
  const entries = appendAuditEntries([], [
    {
      eventKind: "validation_result" as const,
      reason: `校验结论：${input.report.verdict}`,
      timestamp: input.report.checkedAt,
      captureId: input.captureId,
      subjectKey: input.subjectKey,
      operator: input.operator,
      detail: {
        verdict: input.report.verdict,
        blockingCount: input.report.issues.filter((item) => item.error.severity === "blocking").length,
        warningCount: input.report.issues.filter((item) => item.error.severity === "warning").length,
      },
    },
    ...input.report.issues.map((item) => ({
      eventKind: securityAuditCodes.has(item.error.code as typeof securityAuditCodes extends Set<infer T> ? T : never)
        ? "security_audit" as const
        : "error" as const,
      reason: item.hint,
      timestamp: input.report.checkedAt,
      captureId: input.captureId,
      subjectKey: input.subjectKey,
      error: item.error,
      operator: input.operator,
      detail: item.field ? { field: item.field } : undefined,
    })),
  ]);
  return entries;
}

/** 校验结论 → 目标生命周期状态（供状态机使用，不直接改状态）。 */
export function targetStateForVerdict(
  report: CaptureValidationReport,
): "READY_FOR_RESEARCH" | "RETRYABLE" | "HUMAN_REQUIRED" | "BLOCKED" {
  if (report.verdict === "passed") return "READY_FOR_RESEARCH";
  const blocking = report.issues.filter((item) => item.error.severity === "blocking");
  if (blocking.length === 0) return "HUMAN_REQUIRED";
  if (blocking.every((item) => item.error.retryable)) return "RETRYABLE";
  return "HUMAN_REQUIRED";
}
