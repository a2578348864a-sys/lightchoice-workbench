import {
  CHAIN_OUTPUT_CAP_TOKENS,
  createBatchRequestGate,
  runWithBatchGate,
  type BatchChain,
  type BatchGateConfig,
  type BatchGateState,
  type BatchRequestGate,
  type BatchRequestRecord,
  type BatchStop,
} from "./batchInputBudget";

/**
 * P5 真实模型批次的九例执行器。
 *
 * 设计边界：
 * 1. **只做编排**：本模块不 import 任何 Provider / Prisma / 业务服务，真正的链路调用由
 *    `invoke` 注入。这样「闸是否真的卡在出站边界」可以脱离数据库与付费调用验证。
 * 2. **串行、无重试**：单例失败只记该例 `failed`，连续 2 例失败整批停（硬违约首次即停）。
 * 3. **状态必须可证**：只有「闸从未签发过票据」才能记 `error_before_send`；
 *    票据已签发但未结算 → `unsettled`（费用未知），永久停批，且对账不得报 `consistent`。
 * 4. **真实调用需要多重显式授权**，且本轮硬禁用；stub 模式必须指向本机替身。
 */

export type P5BatchMode = "stub" | "real";

export type P5BatchCaseDefinition = {
  readonly id: number;
  readonly taskId: string;
  readonly asin: string;
  readonly chain: BatchChain;
  /** 该例要验证的业务要求（来自执行表，便于报告直接引用）。 */
  readonly purpose: string;
};

/** 九例执行表（任务 ID / ASIN 已按正式库只读核对）。 */
export const P5_BATCH_CASES: readonly P5BatchCaseDefinition[] = [
  { id: 1, taskId: "task-b07g4vtv2f-prod", asin: "B07G4VTV2F", chain: "v1", purpose: "完整证据 + 旧 v1 报告；P2-02 逐原因/反证/验证计划" },
  { id: 2, taskId: "cmv795sl90002z7ukje2l9ahn", asin: "B0CWPNBC4Z", chain: "v1", purpose: "完整证据；现决策 VALIDATE_MORE；P2-02" },
  { id: 3, taskId: "cmv795smo0008z7uksxwx4ee3", asin: "B0D5RF6GH8", chain: "v1", purpose: "完整证据；无决定；P2-02" },
  { id: 4, taskId: "cmv795sm70005z7uk29v9d837", asin: "B0HFS7K4GP", chain: "v5", purpose: "上次 advisory failed；P5-03 失败后重跑恢复" },
  { id: 5, taskId: "cmv807ra30002gzsmq7al1vke", asin: "B0CFTP6JR4", chain: "v1", purpose: "中等证据；无决定；P2-02" },
  { id: 6, taskId: "cmuux87dg000f5nbglvmh0wq7", asin: "B005CXG1X0", chain: "v5", purpose: "干净起点（无报告）；P2-04 全链" },
  { id: 7, taskId: "cmuvqfn1l000hezlsbprx68z5", asin: "B000AXN2AC", chain: "v5", purpose: "证据不足；P5-01「证据不足必须说不知道」" },
  { id: 8, taskId: "cmuvq7lm8000cezlswubqg1rb", asin: "B01A58FHQ8", chain: "v5", purpose: "证据不足；无报告；P2-04" },
  { id: 9, taskId: "cmuvqfn1w000kezlsb7vgeen2", asin: "B006NZZH18", chain: "v5", purpose: "证据不足；旧 v5 报告无决定；P2-04" },
];

export const P5_BATCH_MODEL = "deepseek-flash" as const;
export const P5_BATCH_PROVIDER = "deepseek" as const;
export const P5_BATCH_TIMEOUT_MS = 45_000;
/**
 * 批次专用输入上限：在保留完整证据绑定的前提下，V1 prompt 投影去掉
 * Bundle 内重复的 ProductFact 后，九例可执行样本的最大已证明上界为
 * 142,220 tokens；145,000 留出小幅结构漂移余量，仍低于本轮允许评估的
 * 160,000 上限。正常生产研究默认参数不受此常量影响。
 */
export const P5_BATCH_INPUT_CAP_TOKENS = 145_000;
/**
 * **诊断用**输入上限，不是已批准参数。
 *
 * 实测：旧投影的 V1 真实提示词最高 174,879 token 上界，超过原 20,000；
 * 现行投影在批次上限 145,000 内覆盖可执行样本。
 * 为验证「真实入口 → 闸 → 替身 → 证据落盘」这条链路本身可通，允许在**隔离替身**下
 * 用本上限跑一次诊断批次；它不能替代已批准参数的运行，也不得用于真实模型。
 */
export const P5_BATCH_DIAGNOSTIC_INPUT_CAP_TOKENS = 200_000;
/**
 * 本轮真实调用的累计硬停止线（人民币）。
 *
 * 用户 2026-10-29 明确授权真实费用并给出软预算 ¥20 / 硬线 ¥30；但账户实际可用余额只有
 * ¥11.30，因此把工程闸定在 **¥8.00**（低于余额，留汇率与峰谷价波动缓冲）。
 * 预估 8 例最坏约 ¥0.8，¥8 是约 10 倍余量，**不是需要花完的目标**。
 */
export const P5_BATCH_BUDGET_CNY = 8;
export const P5_BATCH_CNY_PER_USD = 7.1;
export const P5_BATCH_MAX_REQUESTS = P5_BATCH_CASES.length;

/**
 * 真实模式开关。
 *
 * 2026-10-29 用户在本轮任务书中明确授权「实际调用 DeepSeek 并承担费用」，
 * 因此在保留**三重环境确认**（ALLOW_REAL + CONFIRM + BUDGET_CNY）与回环/官方端点互斥检查
 * 的前提下开启。它仍然不是「所有环境默认开启」：未设置 `P5_BATCH_MODE=real` 的进程
 * 一律走 stub 或直接拒绝。
 */
export const P5_BATCH_REAL_MODE_ALLOWED = true;

export function defaultBatchGateConfig(overrides: Partial<BatchGateConfig> = {}): BatchGateConfig {
  return {
    model: P5_BATCH_MODEL,
    inputCapTokens: P5_BATCH_INPUT_CAP_TOKENS,
    budgetCny: P5_BATCH_BUDGET_CNY,
    cnyPerUsd: P5_BATCH_CNY_PER_USD,
    maxRequests: P5_BATCH_MAX_REQUESTS,
    // 与 §6.3 已批准的停止规则一致：单例失败只记该例 FAILED，**连续 2 例失败**才整批停。
    // 注意「硬违约」（用量缺失/不自洽、模型不符、上界被突破、未结算）不按次数算，首次出现即停。
    maxConsecutiveFailures: 2,
    ...overrides,
  };
}

export class P5BatchAuthorizationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "P5BatchAuthorizationError";
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function readEnv(env: Record<string, string | undefined>, key: string): string {
  return (env[key] ?? "").trim();
}

/**
 * 运行前授权与环境一致性检查。任何一项不满足都直接抛错，不「警告后继续」。
 *
 * 与执行表对齐的硬约束：provider=deepseek、model=deepseek-flash、45s 超时、
 * V1/V5 输出上限（12000 / 2000）、批次输入上限 145,000、预算 8 元、最多 9 次请求。
 */
export function assertBatchRunAuthorized(input: {
  readonly mode: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly budgetCny?: number;
  readonly inputCapTokens?: number;
}): { readonly mode: P5BatchMode } {
  const mode = (input.mode ?? "").trim();
  if (mode !== "stub" && mode !== "real") {
    throw new P5BatchAuthorizationError(
      "P5_BATCH_MODE_INVALID",
      "P5_BATCH_MODE 必须显式设为 stub 或 real；未设置时拒绝运行。",
    );
  }

  const mismatches: string[] = [];

  const provider = readEnv(input.env, "AI_PROVIDER");
  if (provider !== P5_BATCH_PROVIDER) mismatches.push(`AI_PROVIDER 必须是 ${P5_BATCH_PROVIDER}（当前 ${provider || "未设置"}）`);

  const model = readEnv(input.env, "AI_MODEL") || readEnv(input.env, "DEEPSEEK_MODEL");
  if (model !== P5_BATCH_MODEL) mismatches.push(`AI_MODEL 必须是 ${P5_BATCH_MODEL}（当前 ${model || "未设置"}）`);

  const timeout = readEnv(input.env, "AI_TIMEOUT_MS");
  if (timeout && Number(timeout) !== P5_BATCH_TIMEOUT_MS) {
    mismatches.push(`AI_TIMEOUT_MS 必须为空或 ${P5_BATCH_TIMEOUT_MS}（当前 ${timeout}）`);
  }

  const v5Cap = readEnv(input.env, "AI_RESEARCH_MAX_TOKENS");
  if (v5Cap && Number(v5Cap) !== CHAIN_OUTPUT_CAP_TOKENS.v5) {
    mismatches.push(`AI_RESEARCH_MAX_TOKENS 必须为空或 ${CHAIN_OUTPUT_CAP_TOKENS.v5}（当前 ${v5Cap}）`);
  }

  const budgetCny = input.budgetCny ?? P5_BATCH_BUDGET_CNY;
  if (budgetCny !== P5_BATCH_BUDGET_CNY) {
    mismatches.push(`预算必须为 ${P5_BATCH_BUDGET_CNY} 元（当前 ${budgetCny}）`);
  }

  const inputCap = input.inputCapTokens ?? P5_BATCH_INPUT_CAP_TOKENS;
  if (inputCap !== P5_BATCH_INPUT_CAP_TOKENS) {
    mismatches.push(`单请求输入上限必须为 ${P5_BATCH_INPUT_CAP_TOKENS} tokens（当前 ${inputCap}）；诊断上限只能用于替身验证，不能走授权入口`);
  }

  const baseUrl = readEnv(input.env, "AI_BASE_URL");
  if (!baseUrl) {
    throw new P5BatchAuthorizationError("P5_BATCH_BASE_URL_MISSING", "AI_BASE_URL 未设置，无法确认请求去向。");
  }
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new P5BatchAuthorizationError("P5_BATCH_BASE_URL_INVALID", `AI_BASE_URL 不是合法 URL：${baseUrl}`);
  }
  const loopback = isLoopbackHost(host);

  if (mode === "stub" && !loopback) {
    throw new P5BatchAuthorizationError(
      "P5_BATCH_STUB_REQUIRES_LOOPBACK",
      `stub 模式必须指向本机替身，实际指向 ${host}；拒绝在 stub 模式下发出真实请求。`,
    );
  }
  if (mode === "real" && loopback) {
    mismatches.push(`real 模式的 AI_BASE_URL 必须指向 api.deepseek.com（当前 ${host}）`);
  }

  if (mismatches.length > 0) {
    throw new P5BatchAuthorizationError(
      "P5_BATCH_ENV_MISMATCH",
      `环境配置与执行表不一致，拒绝运行：${mismatches.join("；")}`,
    );
  }

  if (mode === "stub") return { mode };

  const missing: string[] = [];
  if (readEnv(input.env, "P5_BATCH_ALLOW_REAL") !== "1") missing.push("P5_BATCH_ALLOW_REAL=1");
  if (readEnv(input.env, "P5_BATCH_CONFIRM") !== "real-model-spend") missing.push("P5_BATCH_CONFIRM=real-model-spend");
  if (Number(readEnv(input.env, "P5_BATCH_BUDGET_CNY")) !== P5_BATCH_BUDGET_CNY) missing.push(`P5_BATCH_BUDGET_CNY=${P5_BATCH_BUDGET_CNY}`);
  if (missing.length > 0) {
    throw new P5BatchAuthorizationError(
      "P5_BATCH_NOT_AUTHORIZED",
      `真实模型调用需要全部授权项，缺失：${missing.join("；")}`,
    );
  }

  if (!P5_BATCH_REAL_MODE_ALLOWED) {
    throw new P5BatchAuthorizationError(
      "P5_BATCH_REAL_MODE_DISABLED",
      "本轮禁止启用真实模式：授权门禁已通过，但代码中的 P5_BATCH_REAL_MODE_ALLOWED=false，需要 Owner 明确授权后才能改为 true。",
    );
  }
  return { mode };
}

export type P5BatchCaseOutcome = {
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly detail?: string | null;
  /** 该例的模型输出摘要（供证据落盘），可为空。 */
  readonly outputSummary?: string | null;
};

/** 注入的链路调用：内部必须走 `callAiText` / `callAiJson`（即真实出站边界）。 */
export type P5BatchCaseInvoker = (definition: P5BatchCaseDefinition) => Promise<P5BatchCaseOutcome>;

export type P5BatchCaseResult = {
  readonly id: number;
  readonly taskId: string;
  readonly asin: string;
  readonly chain: BatchChain;
  /**
   * - `ok`：票据已结算且无停止
   * - `failed`：票据已结算但被判违约或链路失败
   * - `error_before_send`：**可证**未发出请求（闸从未签发票据）
   * - `unsettled`：票据已签发但未结算 → 请求状态不明，费用未知
   * - `not_run`：批次已停止，未尝试
   */
  readonly outcome: "ok" | "failed" | "error_before_send" | "unsettled" | "not_run";
  readonly errorCode: string | null;
  readonly detail: string | null;
  readonly outputSummary: string | null;
  readonly record: BatchRequestRecord | null;
};

export type P5BatchReconciliation = {
  readonly attempted: number;
  readonly settled: number;
  readonly unsettled: number;
  readonly blockedBeforeSend: number;
  readonly notRun: number;
  readonly records: number;
  readonly requests: number;
  readonly inFlight: boolean;
  readonly consistent: boolean;
  readonly spentCny: number;
  readonly costUnknownCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
};

export type P5BatchRunResult = {
  readonly mode: P5BatchMode;
  readonly results: readonly P5BatchCaseResult[];
  readonly gate: BatchGateState;
  readonly stopped: BatchStop | null;
  readonly reconciliation: P5BatchReconciliation;
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

/**
 * 串行执行九例。**不重试**：任一例失败或闸停止后，剩余样例一律标 `not_run`。
 *
 * 状态判定只依赖闸的不变量「HTTP 只在 authorize 成功后发生」：
 * - 无新记录且无未结算票据 → 从未授权 → 可证未发出（`error_before_send`）
 * - 存在未结算票据 → 可能已发出 → `unsettled`，`abandon` 留痕并永久停批
 */
export async function runRealModelBatch(input: {
  readonly mode: P5BatchMode;
  readonly gate: BatchRequestGate;
  readonly invoke: P5BatchCaseInvoker;
  readonly cases?: readonly P5BatchCaseDefinition[];
}): Promise<P5BatchRunResult> {
  const cases = input.cases ?? P5_BATCH_CASES;
  const results: P5BatchCaseResult[] = [];

  for (const definition of cases) {
    const base = {
      id: definition.id,
      taskId: definition.taskId,
      asin: definition.asin,
      chain: definition.chain,
    } as const;

    const before = input.gate.state();
    if (before.stopped) {
      results.push({ ...base, outcome: "not_run", errorCode: before.stopped.code, detail: "批次已停止，未尝试。", outputSummary: null, record: null });
      continue;
    }
    if (before.inFlight) {
      // 上一例留下了未结算票据：请求状态不明，永久停批。
      const abandoned = input.gate.abandon({ reason: "上一例结束时仍有未结算票据，请求状态不明。" });
      results.push({
        ...base,
        outcome: "unsettled",
        errorCode: "REQUEST_UNSETTLED",
        detail: "上一例结束时仍有未结算票据。",
        outputSummary: null,
        record: abandoned.record,
      });
      continue;
    }

    let outcome: P5BatchCaseOutcome;
    try {
      outcome = await runWithBatchGate({ gate: input.gate, chain: definition.chain }, () => input.invoke(definition));
    } catch (error) {
      // 调用抛错：请求是否发出只能由闸判断，下面统一处理。
      outcome = { ok: false, errorCode: "CASE_THREW", detail: messageOf(error) };
    }

    const after = input.gate.state();
    const newRecords = after.records.slice(before.records.length);

    if (after.inFlight) {
      // 票据已签发但未结算：可能已发出，必须留痕为费用未知并停批。
      const abandoned = input.gate.abandon({ reason: `第 ${definition.id} 例结束时有未结算票据，请求状态不明。` });
      results.push({
        ...base,
        outcome: "unsettled",
        errorCode: "REQUEST_UNSETTLED",
        detail: outcome.detail ?? "请求已签发但未结算。",
        outputSummary: outcome.outputSummary ?? null,
        record: abandoned.record,
      });
      continue;
    }

    if (newRecords.length === 0) {
      // 闸从未签发票据 → 可证未发出。
      results.push({
        ...base,
        outcome: "error_before_send",
        errorCode: outcome.errorCode,
        detail: outcome.detail ?? null,
        outputSummary: null,
        record: null,
      });
      continue;
    }

    if (newRecords.length > 1) {
      input.gate.halt({
        code: "CASE_MULTIPLE_REQUESTS",
        detail: `第 ${definition.id} 例产生了 ${newRecords.length} 条请求记录，违反「一例一请求」。`,
      });
      results.push({
        ...base,
        outcome: "failed",
        errorCode: "MULTIPLE_REQUESTS_FOR_CASE",
        detail: `一例内产生 ${newRecords.length} 条记录。`,
        outputSummary: outcome.outputSummary ?? null,
        record: newRecords[newRecords.length - 1],
      });
      continue;
    }

    const record = newRecords[0];
    results.push({
      ...base,
      outcome: outcome.ok ? "ok" : "failed",
      errorCode: outcome.errorCode,
      detail: outcome.detail ?? null,
      outputSummary: outcome.outputSummary ?? null,
      record,
    });
  }

  const gate = input.gate.state();
  const settled = results.filter((item) => item.record?.settled === true).length;
  const unsettled = results.filter((item) => item.outcome === "unsettled").length;
  const blockedBeforeSend = results.filter((item) => item.outcome === "error_before_send").length;
  const notRun = results.filter((item) => item.outcome === "not_run").length;
  const attempted = results.length - notRun;
  const settledRecords = gate.records.filter((record) => record.settled).length;

  return {
    mode: input.mode,
    results,
    gate,
    stopped: gate.stopped,
    reconciliation: {
      attempted,
      settled,
      unsettled,
      blockedBeforeSend,
      notRun,
      records: gate.records.length,
      requests: gate.requests,
      inFlight: gate.inFlight,
      consistent: gate.unsettled === 0
        && unsettled === 0
        && !gate.inFlight
        && settledRecords === gate.requests
        && settled === gate.requests
        && gate.records.length === settledRecords + gate.unsettled
        && attempted === settled + unsettled + blockedBeforeSend,
      spentCny: gate.spentCny,
      costUnknownCount: gate.records.filter((record) => record.costUnknown).length,
      promptTokens: gate.records.reduce((sum, record) => sum + (record.promptTokens ?? 0), 0),
      completionTokens: gate.records.reduce((sum, record) => sum + (record.completionTokens ?? 0), 0),
    },
  };
}

/** 一次性建闸 + 跑完九例，供应用进程内的真实调用入口使用。 */
export async function runP5BatchWithNewGate(input: {
  readonly mode: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly invoke: P5BatchCaseInvoker;
  readonly gateConfig?: Partial<BatchGateConfig>;
  readonly cases?: readonly P5BatchCaseDefinition[];
}): Promise<P5BatchRunResult> {
  const gateConfig = defaultBatchGateConfig(input.gateConfig);
  const authorized = assertBatchRunAuthorized({
    mode: input.mode,
    env: input.env,
    budgetCny: gateConfig.budgetCny,
    inputCapTokens: gateConfig.inputCapTokens,
  });
  return runRealModelBatch({
    mode: authorized.mode,
    gate: createBatchRequestGate(gateConfig),
    invoke: input.invoke,
    cases: input.cases,
  });
}
