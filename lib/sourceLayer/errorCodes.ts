/**
 * Product Source Layer V1.2 — 统一错误码注册表（Phase 4）
 *
 * 设计目标：
 * - 全层唯一错误码来源；Source / Capture / Data / AI 四域各自封闭枚举；
 * - 每个错误码自带 family / severity / retryable，避免调用方各自解释字符串；
 * - fail-closed：未知错误码不得被静默降级，必须显式映射到 INTERNAL_UNEXPECTED。
 *
 * 纯模块：无 IO / 无时间 / 无随机 / 无 DB。
 */

export const SOURCE_ERROR_CODES = [
  "SOURCE_MISSING",
  "SOURCE_UNTRUSTED",
  "SOURCE_EXPIRED",
] as const;

export const CAPTURE_ERROR_CODES = [
  "PAGE_CHANGED",
  "DOM_CHANGED",
  "SELECTOR_FAILED",
  "SELECTOR_MISS",
  "TIMEOUT",
  "CAPTCHA_DETECTED",
  "LOGIN_REQUIRED",
  "PLUGIN_NOT_LOADED",
  "DOWNLOAD_FAILED",
  "ASIN_NOT_FOUND",
  "MARKETPLACE_MISMATCH",
  "AUTOMATION_BLOCKED",
  "LOCALE_MISMATCH",
  "AMAZON_CAPTURE_PROXY_INVALID",
  "AMAZON_CAPTURE_NON_US_EXIT",
  "AMAZON_CAPTURE_PREFLIGHT_FAILED",
  "AMAZON_US_SESSION_CALIBRATION_FAILED",
  "AMAZON_SITE_ERROR",
  "PROVIDER_PERMISSION_DENIED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PLAN_LIMIT",
  "ENTITY_BINDING_FAILED",
] as const;

export const DATA_ERROR_CODES = [
  "FIELD_MISSING",
  "FIELD_CONFLICT",
  "FIELD_AMBIGUOUS",
  "LOW_CONFIDENCE",
  "INVALID_FORMAT",
] as const;

export const AI_ERROR_CODES = [
  "AI_GENERATED_AS_FACT",
  "UNSUPPORTED_CLAIM",
  "NO_EVIDENCE",
] as const;

/** 层内自身错误（契约/状态机/审计），不替代上面四域业务码。 */
export const LAYER_ERROR_CODES = [
  "CONTRACT_INVALID",
  "TRANSITION_FORBIDDEN",
  "AUDIT_REQUIRED",
  "HUMAN_REQUIRED",
  "PERSISTENCE_FAILED",
  "READBACK_FAILED",
  "HANDOFF_FAILED",
  "UI_RENDER_FAILED",
  "INTERNAL_UNEXPECTED",
] as const;

export const SOURCE_LAYER_ERROR_CODES = [
  ...SOURCE_ERROR_CODES,
  ...CAPTURE_ERROR_CODES,
  ...DATA_ERROR_CODES,
  ...AI_ERROR_CODES,
  ...LAYER_ERROR_CODES,
] as const;

export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];
export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];
export type DataErrorCode = (typeof DATA_ERROR_CODES)[number];
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];
export type LayerErrorCode = (typeof LAYER_ERROR_CODES)[number];
export type SourceLayerErrorCode = (typeof SOURCE_LAYER_ERROR_CODES)[number];

export type SourceLayerErrorFamily = "source" | "capture" | "data" | "ai" | "layer";

export type SourceLayerErrorSeverity = "info" | "warning" | "blocking";

export type SourceLayerErrorDefinition = {
  code: SourceLayerErrorCode;
  family: SourceLayerErrorFamily;
  severity: SourceLayerErrorSeverity;
  /** 同一输入重试是否可能成功（决定 RETRYABLE 还是 HUMAN_REQUIRED）。 */
  retryable: boolean;
  /** 面向操作者的中文说明（不含内部实现细节）。 */
  message: string;
};

const FAMILY_OF: Record<SourceLayerErrorCode, SourceLayerErrorFamily> = {
  ...Object.fromEntries(SOURCE_ERROR_CODES.map((code) => [code, "source"])),
  ...Object.fromEntries(CAPTURE_ERROR_CODES.map((code) => [code, "capture"])),
  ...Object.fromEntries(DATA_ERROR_CODES.map((code) => [code, "data"])),
  ...Object.fromEntries(AI_ERROR_CODES.map((code) => [code, "ai"])),
  ...Object.fromEntries(LAYER_ERROR_CODES.map((code) => [code, "layer"])),
} as Record<SourceLayerErrorCode, SourceLayerErrorFamily>;

const DEFINITIONS: Record<SourceLayerErrorCode, Omit<SourceLayerErrorDefinition, "code">> = {
  SOURCE_MISSING: {
    family: FAMILY_OF.SOURCE_MISSING,
    severity: "blocking",
    retryable: false,
    message: "缺少来源信息：没有可核验的来源类型、URL 或采集时间。",
  },
  SOURCE_UNTRUSTED: {
    family: FAMILY_OF.SOURCE_UNTRUSTED,
    severity: "blocking",
    retryable: false,
    message: "来源可信度不足：该来源不在允许清单内，或来源与声明的来源类型不一致。",
  },
  SOURCE_EXPIRED: {
    family: FAMILY_OF.SOURCE_EXPIRED,
    severity: "blocking",
    retryable: true,
    message: "来源已过期：该字段超过其有效期，需要重新采集。",
  },
  PAGE_CHANGED: {
    family: FAMILY_OF.PAGE_CHANGED,
    severity: "blocking",
    retryable: true,
    message: "页面已变化：页面结构与采集时不一致，采集结果不可直接采信。",
  },
  DOM_CHANGED: {
    family: FAMILY_OF.DOM_CHANGED,
    severity: "blocking",
    retryable: true,
    message: "DOM 已变化：解析节点与预期结构不一致。",
  },
  SELECTOR_FAILED: {
    family: FAMILY_OF.SELECTOR_FAILED,
    severity: "blocking",
    retryable: true,
    message: "选择器失败：目标字段未能在页面上定位。",
  },
  SELECTOR_MISS: {
    family: FAMILY_OF.SELECTOR_MISS,
    severity: "blocking",
    retryable: true,
    message: "选择器未命中：目标字段未能在页面上定位。",
  },
  TIMEOUT: {
    family: FAMILY_OF.TIMEOUT,
    severity: "blocking",
    retryable: true,
    message: "采集超时：页面未在预期时间内返回。",
  },
  CAPTCHA_DETECTED: {
    family: FAMILY_OF.CAPTCHA_DETECTED,
    severity: "blocking",
    retryable: false,
    message: "检测到验证码：需要人工介入，系统不会自动绕过。",
  },
  LOGIN_REQUIRED: {
    family: FAMILY_OF.LOGIN_REQUIRED,
    severity: "blocking",
    retryable: false,
    message: "需要登录：该系统不自动登录，请人工完成登录后重新采集。",
  },
  PLUGIN_NOT_LOADED: {
    family: FAMILY_OF.PLUGIN_NOT_LOADED,
    severity: "blocking",
    retryable: true,
    message: "采集插件未加载：请确认人工已启用插件后重试。",
  },
  DOWNLOAD_FAILED: {
    family: FAMILY_OF.DOWNLOAD_FAILED,
    severity: "blocking",
    retryable: true,
    message: "来源文件下载失败：请确认文件仍可用后重试。",
  },
  ASIN_NOT_FOUND: {
    family: FAMILY_OF.ASIN_NOT_FOUND,
    severity: "blocking",
    retryable: false,
    message: "未找到目标 ASIN：不会用其它商品替代。",
  },
  MARKETPLACE_MISMATCH: {
    family: FAMILY_OF.MARKETPLACE_MISMATCH,
    severity: "blocking",
    retryable: false,
    message: "站点与目标 Marketplace 不一致：已拒绝写入。",
  },
  AUTOMATION_BLOCKED: {
    family: FAMILY_OF.AUTOMATION_BLOCKED,
    severity: "blocking",
    retryable: false,
    message: "页面拒绝自动化：需要人工接管，系统不会绕过站点校验。",
  },
  LOCALE_MISMATCH: {
    family: FAMILY_OF.LOCALE_MISMATCH,
    severity: "warning",
    retryable: false,
    message: "页面语言与预期不一致：保留原文，不自动翻译为事实。",
  },
  AMAZON_CAPTURE_PROXY_INVALID: {
    family: FAMILY_OF.AMAZON_CAPTURE_PROXY_INVALID,
    severity: "blocking",
    retryable: false,
    message: "采集浏览器的出口代理配置不合法：已按 fail-closed 停止，不会静默回退为默认网络继续采集。",
  },
  AMAZON_CAPTURE_NON_US_EXIT: {
    family: FAMILY_OF.AMAZON_CAPTURE_NON_US_EXIT,
    severity: "blocking",
    retryable: false,
    message: "采集出口地区不是美国：当前出口无法保证获取 Amazon US 主站数据，已按 fail-closed 拦截，未启动采集浏览器。请将代理节点切换为美国出口后重试。",
  },
  AMAZON_CAPTURE_PREFLIGHT_FAILED: {
    family: FAMILY_OF.AMAZON_CAPTURE_PREFLIGHT_FAILED,
    severity: "blocking",
    retryable: true,
    message: "采集出口网络预检超时或失败：为避免在未知出口网络下误采，已按 fail-closed 拦截，未启动采集浏览器。",
  },
  AMAZON_US_SESSION_CALIBRATION_FAILED: {
    family: FAMILY_OF.AMAZON_US_SESSION_CALIBRATION_FAILED,
    severity: "blocking",
    retryable: true,
    message: "Amazon 美国配送地区校准一次后仍未通过；已停止采集，请检查 Amazon 页面配送设置。",
  },
  AMAZON_SITE_ERROR: {
    family: FAMILY_OF.AMAZON_SITE_ERROR,
    severity: "blocking",
    retryable: false,
    message: "Amazon 站点返回错误页面（Sorry! Something went wrong!）：属于站点会话异常或反爬阻断，已按 fail-closed 停止，未继续采集。",
  },
  PROVIDER_PERMISSION_DENIED: {
    family: FAMILY_OF.PROVIDER_PERMISSION_DENIED,
    severity: "blocking",
    retryable: false,
    message: "来源服务权限不足：不会绕过套餐或权限限制。",
  },
  PROVIDER_QUOTA_EXHAUSTED: {
    family: FAMILY_OF.PROVIDER_QUOTA_EXHAUSTED,
    severity: "blocking",
    retryable: false,
    message: "来源服务额度已用尽：不会通过轮换账号或其它方式绕过限制。",
  },
  PLAN_LIMIT: {
    family: FAMILY_OF.PLAN_LIMIT,
    severity: "blocking",
    retryable: false,
    message: "来源套餐限制：不会绕过套餐或权限限制。",
  },
  ENTITY_BINDING_FAILED: {
    family: FAMILY_OF.ENTITY_BINDING_FAILED,
    severity: "blocking",
    retryable: false,
    message: "实体绑定失败：未能证明页面内容属于目标商品。",
  },
  FIELD_MISSING: {
    family: FAMILY_OF.FIELD_MISSING,
    severity: "blocking",
    retryable: true,
    message: "关键字段缺失：必填字段无来源支持，禁止自动补全。",
  },
  FIELD_CONFLICT: {
    family: FAMILY_OF.FIELD_CONFLICT,
    severity: "blocking",
    retryable: false,
    message: "字段冲突：不同来源对同一字段给出不一致的值，需人工裁定。",
  },
  FIELD_AMBIGUOUS: {
    family: FAMILY_OF.FIELD_AMBIGUOUS,
    severity: "warning",
    retryable: false,
    message: "字段存在多个候选值：需要人工复核，系统不会擅自选择。",
  },
  LOW_CONFIDENCE: {
    family: FAMILY_OF.LOW_CONFIDENCE,
    severity: "warning",
    retryable: false,
    message: "置信度偏低：该字段由低可信方式得到，需人工复核。",
  },
  INVALID_FORMAT: {
    family: FAMILY_OF.INVALID_FORMAT,
    severity: "blocking",
    retryable: false,
    message: "格式不合法：字段值不符合约定格式（ASIN / URL / 数值区间）。",
  },
  AI_GENERATED_AS_FACT: {
    family: FAMILY_OF.AI_GENERATED_AS_FACT,
    severity: "blocking",
    retryable: false,
    message: "AI 生成内容被当作事实：该值来自模型推断，不能作为事实来源。",
  },
  UNSUPPORTED_CLAIM: {
    family: FAMILY_OF.UNSUPPORTED_CLAIM,
    severity: "blocking",
    retryable: false,
    message: "无支撑主张：结论缺少可追溯来源。",
  },
  NO_EVIDENCE: {
    family: FAMILY_OF.NO_EVIDENCE,
    severity: "blocking",
    retryable: true,
    message: "无证据：该结论没有对应的来源证据记录。",
  },
  CONTRACT_INVALID: {
    family: FAMILY_OF.CONTRACT_INVALID,
    severity: "blocking",
    retryable: false,
    message: "契约不合法：数据包结构不满足 Capture Package 契约。",
  },
  TRANSITION_FORBIDDEN: {
    family: FAMILY_OF.TRANSITION_FORBIDDEN,
    severity: "blocking",
    retryable: false,
    message: "状态跃迁被拒绝：当前状态不允许进入目标状态。",
  },
  AUDIT_REQUIRED: {
    family: FAMILY_OF.AUDIT_REQUIRED,
    severity: "blocking",
    retryable: false,
    message: "审计缺失：状态变化未记录审计条目，流程被阻断。",
  },
  HUMAN_REQUIRED: {
    family: FAMILY_OF.HUMAN_REQUIRED,
    severity: "blocking",
    retryable: false,
    message: "需要人工接管：系统不会绕过登录、验证码或套餐限制。",
  },
  PERSISTENCE_FAILED: {
    family: FAMILY_OF.PERSISTENCE_FAILED,
    severity: "blocking",
    retryable: true,
    message: "证据持久化失败：未确认写入成功前不会继续交接。",
  },
  READBACK_FAILED: {
    family: FAMILY_OF.READBACK_FAILED,
    severity: "blocking",
    retryable: true,
    message: "证据回读失败：未确认保存结果，流程已停止。",
  },
  HANDOFF_FAILED: {
    family: FAMILY_OF.HANDOFF_FAILED,
    severity: "blocking",
    retryable: false,
    message: "来源证据交接失败：不会绕过 Source Layer。",
  },
  UI_RENDER_FAILED: {
    family: FAMILY_OF.UI_RENDER_FAILED,
    severity: "warning",
    retryable: true,
    message: "页面显示失败：采集数据仍以服务端证据为准。",
  },
  INTERNAL_UNEXPECTED: {
    family: FAMILY_OF.INTERNAL_UNEXPECTED,
    severity: "blocking",
    retryable: true,
    message: "未预期错误：已按 fail-closed 处理。",
  },
};

export const SOURCE_LAYER_ERROR_REGISTRY: Readonly<
  Record<SourceLayerErrorCode, SourceLayerErrorDefinition>
> = Object.freeze(
  Object.fromEntries(
    SOURCE_LAYER_ERROR_CODES.map((code) => [code, { code, ...DEFINITIONS[code] }]),
  ) as Record<SourceLayerErrorCode, SourceLayerErrorDefinition>,
);

const ERROR_CODE_SET: ReadonlySet<string> = new Set(SOURCE_LAYER_ERROR_CODES);

export function isSourceLayerErrorCode(value: unknown): value is SourceLayerErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/**
 * fail-closed 归一：任何非注册错误码都归入 INTERNAL_UNEXPECTED，
 * 而不是原样透传一个无法解释的字符串。
 */
export function normalizeSourceLayerErrorCode(value: unknown): SourceLayerErrorCode {
  return isSourceLayerErrorCode(value) ? value : "INTERNAL_UNEXPECTED";
}

export function describeSourceLayerError(code: SourceLayerErrorCode): SourceLayerErrorDefinition {
  return SOURCE_LAYER_ERROR_REGISTRY[code];
}

export function sourceLayerErrorLabel(code: SourceLayerErrorCode): string {
  return SOURCE_LAYER_ERROR_REGISTRY[code].message;
}

export type SourceLayerError = {
  code: SourceLayerErrorCode;
  family: SourceLayerErrorFamily;
  severity: SourceLayerErrorSeverity;
  retryable: boolean;
  message: string;
  /** 触发该错误的字段（仅 Data / Capture 域按需提供）。 */
  field?: string | null;
  /** 结构化补充信息（不得包含凭据、Cookie 或完整页面正文）。 */
  detail?: Record<string, string | number | boolean | null> | null;
};

export function createSourceLayerError(
  code: SourceLayerErrorCode,
  options: {
    field?: string | null;
    detail?: Record<string, string | number | boolean | null> | null;
    message?: string;
  } = {},
): SourceLayerError {
  const definition = SOURCE_LAYER_ERROR_REGISTRY[code];
  return {
    code,
    family: definition.family,
    severity: definition.severity,
    retryable: definition.retryable,
    message: options.message?.trim() || definition.message,
    ...(options.field ? { field: options.field } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
  };
}

/** 阻断级错误（进入 NEED_REVIEW / HUMAN_REQUIRED / BLOCKED 的依据） */
export function blockingErrors(errors: readonly SourceLayerError[]): SourceLayerError[] {
  return errors.filter((error) => error.severity === "blocking");
}

/** 仅当所有错误都可重试时，失败才允许进入 RETRYABLE。 */
export function allRetryable(errors: readonly SourceLayerError[]): boolean {
  const blocking = blockingErrors(errors);
  return blocking.length > 0 && blocking.every((error) => error.retryable);
}
