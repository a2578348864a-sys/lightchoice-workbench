/**
 * Jev Research Readiness — 生产接入策略（默认全关 + 费用前置门禁参数）。
 *
 * 本模块只做 env → 策略解析：零网络、零存储、零副作用。
 * 任何未明确允许的值一律解析为 unavailable —— 正式模式绝不自动退回 Mock；
 * 离线桩必须同时满足 JEV_READINESS_PROVIDER=offline 与 JEV_READINESS_ALLOW_OFFLINE=true
 * （后者即“测试环境”显式标记；默认缺失）。
 *
 * 真实 TypeSafe 调用需先满足费用硬门禁和经核验的 Readiness 协议。当前账户计费上限不可确认，
 * 且 System One 的结构化输出不能满足现有自由文本证据引用合同，因此真实 Provider 固定 fail-closed。
 * `JEV_READINESS_BUDGET_ACK=true` 只表达人工确认，不能替代跨进程费用上限或协议校验。
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

export type JevReadinessProviderKind = "typesafe" | "offline" | "unavailable";

export type JevReadinessPolicy = {
  /** 功能总开关：默认 false。未启用时任何运行请求都在进入 Provider 之前被拒绝。 */
  readonly enabled: boolean;
  /** 解析后的 Provider 类型；unavailable 表示按当前配置不可用。 */
  readonly providerKind: JevReadinessProviderKind;
  /** providerKind=unavailable 时的机器可读原因；可用时为 null。 */
  readonly providerReason: string | null;
  /** 是否显式允许离线桩（仅测试用途；正式模式不设）。 */
  readonly allowOffline: boolean;
  /** 真实 Provider 是否已确认费用预算授权。 */
  readonly budgetAcknowledged: boolean;
};

/** 单次执行允许的最大外部请求数（硬编码为 1：无重试、无翻页补充）。 */
export const JEV_READINESS_MAX_EXTERNAL_REQUESTS_PER_RUN = 1 as const;
/** 同版本强制重跑的冷却时间（毫秒）。 */
export const JEV_READINESS_RERUN_COOLDOWN_MS = 60_000;
/** 传输超时（与既有 TypeSafe Provider 同款，无重试）。 */
export const JEV_READINESS_TIMEOUT_MS = 15_000;
/** 解析当前 Jev Readiness 生产策略（纯函数，默认全关）。 */
export function readJevReadinessPolicy(env: EnvLike = process.env): JevReadinessPolicy {
  const enabledValue = (env.JEV_READINESS_ENABLED ?? "").trim().toLowerCase();
  const enabled = enabledValue === "1" || enabledValue === "true";
  const allowOffline = (env.JEV_READINESS_ALLOW_OFFLINE ?? "").trim() === "true";
  const budgetAcknowledged = (env.JEV_READINESS_BUDGET_ACK ?? "").trim() === "true";
  const raw = (env.JEV_READINESS_PROVIDER ?? "").trim().toLowerCase();

  let providerKind: JevReadinessProviderKind = "unavailable";
  let providerReason: string | null = null;
  if (raw === "typesafe") {
    if (!budgetAcknowledged) {
      providerReason = "JEV_READINESS_BUDGET_NOT_ACKNOWLEDGED";
    } else {
      providerReason = "JEV_READINESS_REAL_PROVIDER_NOT_VERIFIED";
    }
  } else if (raw === "offline") {
    if (!allowOffline) {
      providerReason = "JEV_READINESS_OFFLINE_NOT_ALLOWED";
    } else {
      providerKind = "offline";
    }
  } else {
    providerReason = raw ? "JEV_READINESS_PROVIDER_UNKNOWN" : "JEV_READINESS_PROVIDER_NOT_CONFIGURED";
  }

  return { enabled, providerKind, providerReason, allowOffline, budgetAcknowledged };
}
