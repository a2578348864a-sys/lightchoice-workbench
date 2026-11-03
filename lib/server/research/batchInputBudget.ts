import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { V1_MAX_OUTPUT_TOKENS, V5_MAX_OUTPUT_TOKENS } from "./researchOutputLimits";

/**
 * 真实模型批次的输入预算预检（纯函数，无 IO、无网络）。
 *
 * ## 为什么可以用「UTF-8 字节数」当 token 上界
 *
 * 依据 DeepSeek 官方发布的 tokenizer 产物（`deepseek_v4_tokenizer.zip` 内的 `tokenizer.json`）：
 *  1. `model.type = "BPE"`；
 *  2. `pre_tokenizer` 末段为 `{"type":"ByteLevel"}`，`decoder` 亦为 `ByteLevel`；
 *  3. 词表 128,000 项中包含 **全部 256 个 ByteLevel 字节符号**（用 GPT-2 的 bytes→unicode 映射逐项核对，缺失 0 个）。
 *
 * 由 2、3 可得：任意输入先被转成字节，每个字节至少映射为 1 个基础符号；
 * BPE 只做「相邻合并」，不会把一个符号拆成多个。
 * 因此对任意文本都有 **token 数 ≤ UTF-8 字节数**（这是结构性上界，不是经验系数）。
 * 再叠加少量 chat 模板/特殊 token 余量后仍是上界。
 *
 * 注意：这证明的是**上界**，不是精确计数；精确值只有 provider 返回的 `usage.prompt_tokens` 才算数，
 * 所以发送后必须用它反证上界（见 `verifyUsageAgainstBound`）。
 */

/**
 * chat 模板在我们这种「system + user，且要求生成」形状下新增的特殊 token 数。
 *
 * 证据（官方 `tokenizer_config.json` 的 `chat_template` + `tokenizer.json` 的 `added_tokens`）：
 * 模板展开为 `<｜begin▁of▁sentence｜>` + system + `<｜User｜>` + user + `<｜Assistant｜>`，
 * 其中三个特殊串都是**单个** added token（id 分别为 0 / 128803 / 128804）。
 */
export const CHAT_TEMPLATE_EXTRA_TOKENS = 3;

/**
 * 输入上界的模板余量。
 * = 3（已证明的模板开销）+ 13（留给服务端可能的额外格式，未证明，由发送后 usage 反证兜底）。
 */
export const TOKEN_BOUND_ALLOWANCE = 16;

/** 上界依据的机读描述，供批次报告与审计引用。 */
export const TOKEN_BOUND_PROOF = {
  proven: true,
  boundKind: "utf8_bytes_plus_allowance",
  evidence: "tokenizer.json: model.type=BPE; pre_tokenizer/decoder=ByteLevel; 256/256 ByteLevel byte symbols present in 128k vocab",
  source: "https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip",
  caveat: "结构性上界；精确 token 数只能以 provider 返回的 usage.prompt_tokens 为准",
} as const;

/** 高峰价（USD / 1M tokens），与执行表一致。 */
export const PEAK_PRICE_USD_PER_MTOK = {
  "deepseek-flash": { input: 0.3, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96 },
} as const;

export type BatchModelId = keyof typeof PEAK_PRICE_USD_PER_MTOK;

export function countUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 输入 token 的结构性上界：UTF-8 字节数 + 模板余量。 */
export function estimateTokenUpperBound(text: string): { utf8Bytes: number; tokenUpperBound: number } {
  const utf8Bytes = countUtf8Bytes(text);
  return { utf8Bytes, tokenUpperBound: utf8Bytes + TOKEN_BOUND_ALLOWANCE };
}

export type PreflightInput = {
  readonly system: string;
  readonly user: string;
  /** 单请求输入上限（tokens）。 */
  readonly inputCapTokens: number;
  /** 单请求输出上限（tokens）。 */
  readonly outputCapTokens: number;
  readonly model?: BatchModelId;
  /** 汇率：1 USD = ? CNY。 */
  readonly cnyPerUsd?: number;
  /** 整批预算上限（人民币）。 */
  readonly budgetCny?: number;
  /** 已花费（人民币），用于累计预检。 */
  readonly spentCny?: number;
};

export type PreflightResult =
  | {
      readonly decision: "allow";
      readonly utf8Bytes: number;
      readonly tokenUpperBound: number;
      readonly outputCapTokens: number;
      readonly estimatedCostUsd: number;
      readonly estimatedCostCny: number;
      readonly projectedSpendCny: number;
      readonly boundProof: typeof TOKEN_BOUND_PROOF;
    }
  | {
      readonly decision: "block";
      readonly code: "INPUT_CAP_EXCEEDED" | "BUDGET_EXCEEDED" | "INVALID_CAP";
      readonly detail: string;
      readonly utf8Bytes: number;
      readonly tokenUpperBound: number;
      readonly projectedSpendCny: number | null;
      readonly boundProof: typeof TOKEN_BOUND_PROOF;
    };

/**
 * 发送前预检：输入上界、单请求费用、累计预算。
 * 任一不满足即返回 block，调用方**不得发送请求**。
 */
export function preflightBatchInput(input: PreflightInput): PreflightResult {
  // 两条消息分别计数再相加，不人为插入分隔符，避免把上界算少 1 字节。
  const utf8Bytes = countUtf8Bytes(input.system) + countUtf8Bytes(input.user);
  const tokenUpperBound = utf8Bytes + TOKEN_BOUND_ALLOWANCE;
  const model: BatchModelId = input.model ?? "deepseek-flash";
  const price = PEAK_PRICE_USD_PER_MTOK[model];
  const cnyPerUsd = input.cnyPerUsd ?? 7.1;
  const budgetCny = input.budgetCny ?? 5;
  const spentCny = input.spentCny ?? 0;

  if (!Number.isFinite(input.inputCapTokens) || input.inputCapTokens <= 0 || !Number.isFinite(input.outputCapTokens) || input.outputCapTokens <= 0) {
    return { decision: "block", code: "INVALID_CAP", detail: "输入/输出上限必须是正数。", utf8Bytes, tokenUpperBound, projectedSpendCny: null, boundProof: TOKEN_BOUND_PROOF };
  }

  const estimatedCostUsd = (tokenUpperBound * price.input + input.outputCapTokens * price.output) / 1_000_000;
  const estimatedCostCny = estimatedCostUsd * cnyPerUsd;
  const projectedSpendCny = spentCny + estimatedCostCny;

  if (tokenUpperBound > input.inputCapTokens) {
    return {
      decision: "block",
      code: "INPUT_CAP_EXCEEDED",
      detail: `输入上界 ${tokenUpperBound}（${utf8Bytes} 字节 + ${TOKEN_BOUND_ALLOWANCE} 余量）超过单请求上限 ${input.inputCapTokens}。`,
      utf8Bytes,
      tokenUpperBound,
      projectedSpendCny,
      boundProof: TOKEN_BOUND_PROOF,
    };
  }
  if (projectedSpendCny > budgetCny) {
    return {
      decision: "block",
      code: "BUDGET_EXCEEDED",
      detail: `本请求后累计预估 ${projectedSpendCny.toFixed(4)} 元超过预算 ${budgetCny} 元。`,
      utf8Bytes,
      tokenUpperBound,
      projectedSpendCny,
      boundProof: TOKEN_BOUND_PROOF,
    };
  }
  return { decision: "allow", utf8Bytes, tokenUpperBound, outputCapTokens: input.outputCapTokens, estimatedCostUsd, estimatedCostCny, projectedSpendCny, boundProof: TOKEN_BOUND_PROOF };
}

export type UsageVerification =
  | { readonly ok: true; readonly promptTokens: number; readonly tokenUpperBound: number }
  | { readonly ok: false; readonly code: "USAGE_UNAVAILABLE" | "TOKEN_BOUND_VIOLATED"; readonly detail: string; readonly promptTokens: number | null; readonly tokenUpperBound: number };

/**
 * 发送后复核：用 provider 返回的真实 usage 反证上界。
 * - `promptTokens` 缺失/非法 → USAGE_UNAVAILABLE（费用不可核算）
 * - `promptTokens > tokenUpperBound` → TOKEN_BOUND_VIOLATED（上界假设失效，后续预算不可信）
 * 任一失败都必须整批停止。
 */
export function verifyUsageAgainstBound(input: { readonly promptTokens: unknown; readonly tokenUpperBound: number }): UsageVerification {
  const value = input.promptTokens;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, code: "USAGE_UNAVAILABLE", detail: "provider 未返回可用的 prompt_tokens，费用不可核算。", promptTokens: null, tokenUpperBound: input.tokenUpperBound };
  }
  const promptTokens = Math.trunc(value);
  if (promptTokens > input.tokenUpperBound) {
    return { ok: false, code: "TOKEN_BOUND_VIOLATED", detail: `实际 prompt_tokens ${promptTokens} 超过上界 ${input.tokenUpperBound}，字节上界假设失效。`, promptTokens, tokenUpperBound: input.tokenUpperBound };
  }
  return { ok: true, promptTokens, tokenUpperBound: input.tokenUpperBound };
}

// ---------------------------------------------------------------------------
// 发送闸：绑定「实际要发出的请求」+ 已证明的消息形状 + 用量自洽 + 单飞 + 不漏账
//
// 设计要点（对应执行表 §6.4）：
//  1. 票据绑定模型 / 完整 messages / 输出上限 / temperature / responseFormat / timeout 的指纹；
//     结算时指纹不一致 → 拒绝并关闸，不能只校验预检时拼的字符串。
//  2. 只允许**已证明的请求形状**：恰好两条消息（system + user，内容均为字符串）。
//     字节上界的证明只覆盖 `BOS + system + <｜User｜> + user + <｜Assistant｜>` 这一形状；
//     形状不符 → `UNPROVEN_MESSAGE_SHAPE`，**发送前**拒绝，不让未证明的形状绕过上界。
//  3. 单飞：同一时刻只允许一张未结算票据；未结算时拒绝签发下一张（禁止并发绕闸）。
//  4. 每条链路用自己的输出上限（V1=12000 / V5=2000），请求里的 maxTokens 必须与之相等。
//  5. 结算先记账再判停；**成功响应必须给出合法且自洽的 prompt/completion/total**。
//  6. 预算按「已花费 + 未完成预留」预检，避免连续请求击穿预算。
//  7. 票据可能「已发出但未结算」：`abandon()` 留下 `settled=false` + 费用未知的记录并永久停批，
//     绝不允许把状态不明的请求算成 `error_before_send`。
// ---------------------------------------------------------------------------

/** 两条生产链路各自的单请求输出上限（与 `DEFAULT_RESEARCH_CONFIG` / `AI_RESEARCH_MAX_TOKENS` 一致）。 */
// V1 由 2400 → 4000 → 12000：2400/4000 都被真实调用证明会截断报告 JSON（见 researchInput 说明）。
// 12000 必须与 DEFAULT_RESEARCH_CONFIG.maxTokens 和路由允许上限一致，否则 OUTPUT_CAP_MISMATCH。
export const CHAIN_OUTPUT_CAP_TOKENS = { v1: V1_MAX_OUTPUT_TOKENS, v5: V5_MAX_OUTPUT_TOKENS } as const;
export type BatchChain = keyof typeof CHAIN_OUTPUT_CAP_TOKENS;

export type BatchStop = { readonly code: string; readonly detail: string };

export type BatchGateConfig = {
  readonly model: BatchModelId;
  readonly inputCapTokens: number;
  readonly budgetCny: number;
  readonly cnyPerUsd: number;
  readonly maxRequests: number;
  readonly maxConsecutiveFailures: number;
  /** 票据有效期，超时结算视为过期（防止长期挂起）。 */
  readonly ticketTtlMs?: number;
  /**
   * 预检时冻结的请求指纹。给了它，authorize 就要求**实际要发的请求**与冻结内容
   * 逐字段一致，否则在发出 HTTP 之前就拒绝（`REQUEST_FINGERPRINT_MISMATCH`）。
   *
   * 为什么需要：真实运行曾出现「预检构建一份输入、发送前又重建一份」，两次的
   * runId/traceId 不同 → User Payload Hash 不一致，事后无法证明预检覆盖了实际发送内容。
   * 冻结指纹把「预检的内容」和「发送的内容」绑成同一份。
   */
  readonly expectedFingerprint?: string;
};

export type BatchMessages = readonly { readonly role: string; readonly content: string }[];

export type BatchRequestBinding = {
  readonly model: string;
  readonly messages: BatchMessages;
  readonly maxTokens: number | null;
  readonly temperature: number | null;
  readonly responseFormat: unknown;
  readonly timeoutMs: number | null;
};

export type AuthorizeInput = BatchRequestBinding & { readonly chain: BatchChain };

export type AuthorizeResult =
  | { readonly ok: true; readonly ticket: string; readonly fingerprint: string; readonly tokenUpperBound: number; readonly outputCapTokens: number; readonly reservedCny: number }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export type SettleInput = {
  readonly ticket: string;
  readonly fingerprint: string;
  readonly actualModel: string;
  readonly requestedModel: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly httpStatusClass: string;
  readonly httpStatus: number | null;
  readonly elapsedMs: number | null;
  readonly ok: boolean;
  readonly errorCode: string | null;
};

export type BatchRequestRecord = {
  readonly seq: number;
  readonly chain: BatchChain;
  readonly ticket: string;
  readonly requestedModel: string;
  readonly actualModel: string;
  readonly modelMismatch: boolean;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly inputUpperBound: number;
  readonly outputCapTokens: number;
  readonly costUsd: number | null;
  readonly costCny: number | null;
  /** true = 无法核算费用（缺 usage、用量不自洽或模型价格未知），不得当作 0。 */
  readonly costUnknown: boolean;
  /** false = 已发出但未结算（`abandon`），此时用量与费用必然未知。 */
  readonly settled: boolean;
  readonly httpStatusClass: string;
  readonly httpStatus: number | null;
  readonly elapsedMs: number | null;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly stopCode: string | null;
  readonly stopDetail: string | null;
  readonly fingerprint: string;
  readonly messagesDigest: string;
  readonly at: string;
};

export type BatchGateState = {
  readonly spentCny: number;
  /** 已结算请求数。 */
  readonly requests: number;
  /** 已签发票据数（含未结算），恒等于 `records.length`。 */
  readonly authorizations: number;
  /** 已发出但未结算的数量；> 0 表示存在状态不明的请求，不得声称对账一致。 */
  readonly unsettled: number;
  readonly consecutiveFailures: number;
  readonly inFlight: boolean;
  readonly stopped: BatchStop | null;
  readonly records: readonly BatchRequestRecord[];
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

/** 实际请求指纹：模型 / 完整 messages / 输出上限 / 采样参数 / 超时。 */
export function requestFingerprint(binding: BatchRequestBinding): string {
  return digest({
    model: binding.model,
    messages: binding.messages.map((m) => ({ role: m.role, content: m.content })),
    maxTokens: binding.maxTokens,
    temperature: binding.temperature,
    responseFormat: binding.responseFormat,
    timeoutMs: binding.timeoutMs,
  });
}

export function messagesDigest(messages: BatchMessages): string {
  return digest(messages.map((m) => ({ role: m.role, content: m.content })));
}

export type ProvenMessageShape = { readonly system: string; readonly user: string };

/**
 * 只接受**已证明**的请求形状：system + user 两条纯文本消息。
 *
 * 字节上界的证明链（BPE + ByteLevel + 256/256 字节符号 + 3 个模板 token）
 * 只覆盖这一形状；多消息、tool、图片等形状的上界未证明，因此直接拒绝。
 */
export function provenMessageShape(messages: BatchMessages): ProvenMessageShape | null {
  if (messages.length !== 2) return null;
  const first = messages[0];
  const second = messages[1];
  if (!first || !second) return null;
  if (first.role !== "system" || second.role !== "user") return null;
  if (typeof first.content !== "string" || typeof second.content !== "string") return null;
  return { system: first.content, user: second.content };
}

export type UsageValidation =
  | { readonly ok: true; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number }
  | { readonly ok: false; readonly code: "USAGE_UNAVAILABLE" | "USAGE_INCONSISTENT"; readonly detail: string };

/**
 * 用量校验：三个字段必须齐全、非负整数，且 `total = prompt + completion`。
 * 不一致说明服务商口径异常，费用与上界都不可信 → 关闸。
 */
export function validateSettledUsage(input: {
  readonly promptTokens: unknown;
  readonly completionTokens: unknown;
  readonly totalTokens: unknown;
}): UsageValidation {
  const normalize = (value: unknown) => (
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
  );
  const promptTokens = normalize(input.promptTokens);
  const completionTokens = normalize(input.completionTokens);
  const totalTokens = normalize(input.totalTokens);
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return { ok: false, code: "USAGE_UNAVAILABLE", detail: "缺少合法的 prompt/completion/total usage。" };
  }
  if (totalTokens !== promptTokens + completionTokens) {
    return {
      ok: false,
      code: "USAGE_INCONSISTENT",
      detail: `total_tokens ${totalTokens} ≠ prompt ${promptTokens} + completion ${completionTokens}。`,
    };
  }
  return { ok: true, promptTokens, completionTokens, totalTokens };
}

export type BatchRequestGate = {
  readonly authorize: (input: AuthorizeInput) => AuthorizeResult;
  readonly settle: (input: SettleInput) => { readonly ok: boolean; readonly code: string | null; readonly record: BatchRequestRecord | null };
  /** 请求已发出但无法结算时调用：留下未结算记录（费用未知）并永久停批。 */
  readonly abandon: (input: { readonly ticket?: string; readonly reason: string }) => { readonly record: BatchRequestRecord | null };
  /** 无票据可作废时（例如一例内出现多条记录）强制停批。 */
  readonly halt: (input: { readonly code: string; readonly detail: string }) => void;
  readonly state: () => BatchGateState;
};

export function createBatchRequestGate(config: BatchGateConfig): BatchRequestGate {
  const ttlMs = config.ticketTtlMs ?? 180_000;
  let spentCny = 0;
  let requests = 0;
  let consecutiveFailures = 0;
  let stopped: BatchStop | null = null;
  let inFlight: {
    ticket: string;
    fingerprint: string;
    messagesDigest: string;
    tokenUpperBound: number;
    outputCapTokens: number;
    reservedCny: number;
    chain: BatchChain;
    issuedAt: number;
  } | null = null;
  const records: BatchRequestRecord[] = [];

  const stop = (code: string, detail: string) => { stopped ??= { code, detail }; };

  const pushRecord = (partial: Omit<BatchRequestRecord, "seq" | "at">): BatchRequestRecord => {
    const record: BatchRequestRecord = { seq: records.length + 1, ...partial, at: new Date().toISOString() };
    records.push(record);
    return record;
  };

  return {
    authorize(input) {
      if (stopped) return { ok: false, code: "BATCH_STOPPED", detail: `批次已停止：${stopped.code}` };
      if (inFlight) return { ok: false, code: "REQUEST_IN_FLIGHT", detail: "上一请求尚未结算，禁止并发发送。" };
      if (records.length >= config.maxRequests) return { ok: false, code: "REQUEST_CAP_REACHED", detail: `已达最大请求数 ${config.maxRequests}。` };
      if (input.model !== config.model) return { ok: false, code: "MODEL_NOT_ALLOWED", detail: `请求模型 ${input.model} 与批次模型 ${config.model} 不一致。` };

      const shape = provenMessageShape(input.messages);
      if (!shape) {
        return {
          ok: false,
          code: "UNPROVEN_MESSAGE_SHAPE",
          detail: "只允许 system+user 两条纯文本消息；其他消息形状的 token 上界尚未证明，拒绝发送。",
        };
      }

      const chainCap = CHAIN_OUTPUT_CAP_TOKENS[input.chain];
      if (input.maxTokens !== chainCap) {
        return { ok: false, code: "OUTPUT_CAP_MISMATCH", detail: `${input.chain} 链路输出上限必须是 ${chainCap}，实际 ${input.maxTokens ?? "null"}。` };
      }

      const preflight = preflightBatchInput({
        system: shape.system,
        user: shape.user,
        inputCapTokens: config.inputCapTokens,
        outputCapTokens: chainCap,
        model: config.model,
        cnyPerUsd: config.cnyPerUsd,
        budgetCny: config.budgetCny,
        spentCny,
      });
      if (preflight.decision === "block") return { ok: false, code: preflight.code, detail: preflight.detail };

      const reservedCny = preflight.estimatedCostCny;
      if (spentCny + reservedCny > config.budgetCny) {
        return { ok: false, code: "BUDGET_EXCEEDED", detail: `已花费 ${spentCny.toFixed(4)} + 预留 ${reservedCny.toFixed(4)} 元超过预算 ${config.budgetCny} 元。` };
      }

      const fingerprint = requestFingerprint(input);
      if (config.expectedFingerprint && fingerprint !== config.expectedFingerprint) {
        return {
          ok: false,
          code: "REQUEST_FINGERPRINT_MISMATCH",
          detail: `实际请求指纹 ${fingerprint.slice(0, 12)}… 与预检冻结的 ${config.expectedFingerprint.slice(0, 12)}… 不一致：预检内容与实际发送内容不是同一份。`,
        };
      }
      const ticket = `bt_${records.length + 1}_${Math.random().toString(36).slice(2, 10)}`;
      inFlight = {
        ticket,
        fingerprint,
        messagesDigest: messagesDigest(input.messages),
        tokenUpperBound: preflight.tokenUpperBound,
        outputCapTokens: chainCap,
        reservedCny,
        chain: input.chain,
        issuedAt: Date.now(),
      };
      return { ok: true, ticket, fingerprint, tokenUpperBound: preflight.tokenUpperBound, outputCapTokens: chainCap, reservedCny };
    },

    settle(input) {
      if (!inFlight || inFlight.ticket !== input.ticket) {
        return { ok: false, code: "INVALID_TICKET", record: null };
      }
      const held = inFlight;
      inFlight = null;

      const expired = Date.now() - held.issuedAt > ttlMs;
      const fingerprintMismatch = input.fingerprint !== held.fingerprint;
      const modelMismatch = input.actualModel !== input.requestedModel || input.actualModel !== config.model;

      const usage = validateSettledUsage(input);
      const hasAnyUsage = input.promptTokens !== null || input.completionTokens !== null || input.totalTokens !== null;
      // 成功响应必须齐全且自洽；失败响应只在「确实带了用量」时要求自洽。
      const usageViolation = input.ok
        ? (usage.ok ? null : usage.code)
        : (hasAnyUsage && !usage.ok ? usage.code : null);
      const usageDetail = usage.ok ? null : usage.detail;

      // 计价用「实际回显模型」的价格；回显模型不在价目表内 → 费用未知（不拿批次模型的价格硬套）。
      const priceKnown = Object.prototype.hasOwnProperty.call(PEAK_PRICE_USD_PER_MTOK, input.actualModel);
      const price = priceKnown ? PEAK_PRICE_USD_PER_MTOK[input.actualModel as BatchModelId] : null;
      const costUsd = usage.ok && price
        ? (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000
        : null;
      const costCny = costUsd === null ? null : costUsd * config.cnyPerUsd;

      // 先记账（只要能算就先算），再判停 —— 不允许把已发生费用漏记成 0。
      requests += 1;
      if (costCny !== null) spentCny += costCny;
      consecutiveFailures = input.ok ? 0 : consecutiveFailures + 1;

      let stopCode: string | null = null;
      let stopDetail: string | null = null;
      const markStop = (code: string, detail: string) => { stopCode ??= code; stopDetail ??= detail; stop(code, detail); };

      if (expired) markStop("TICKET_EXPIRED", "票据超过有效期才结算。");
      if (fingerprintMismatch) markStop("REQUEST_FINGERPRINT_MISMATCH", "实际请求内容与预检绑定的指纹不一致。");
      if (modelMismatch) markStop("MODEL_MISMATCH", `实际模型 ${input.actualModel} 与请求模型 ${input.requestedModel} 不一致。`);
      if (usageViolation) markStop(usageViolation, usageDetail ?? "用量不可信。");
      if (usage.ok && usage.promptTokens > held.tokenUpperBound) {
        markStop("TOKEN_BOUND_VIOLATED", `prompt_tokens ${usage.promptTokens} 超过上界 ${held.tokenUpperBound}。`);
      }
      if (usage.ok && usage.completionTokens > held.outputCapTokens) {
        markStop("OUTPUT_CAP_EXCEEDED", `completion_tokens ${usage.completionTokens} 超过输出上限 ${held.outputCapTokens}。`);
      }
      if (costCny !== null && spentCny > config.budgetCny) markStop("BUDGET_EXCEEDED", `累计 ${spentCny.toFixed(4)} 元超过预算 ${config.budgetCny} 元。`);
      if (consecutiveFailures >= config.maxConsecutiveFailures) markStop("CONSECUTIVE_FAILURES", `连续 ${consecutiveFailures} 例失败。`);

      const record = pushRecord({
        chain: held.chain,
        ticket: held.ticket,
        requestedModel: input.requestedModel,
        actualModel: input.actualModel,
        modelMismatch,
        promptTokens: usage.ok ? usage.promptTokens : null,
        completionTokens: usage.ok ? usage.completionTokens : null,
        totalTokens: usage.ok ? usage.totalTokens : null,
        inputUpperBound: held.tokenUpperBound,
        outputCapTokens: held.outputCapTokens,
        costUsd,
        costCny,
        costUnknown: costCny === null,
        settled: true,
        httpStatusClass: input.httpStatusClass,
        httpStatus: input.httpStatus,
        elapsedMs: input.elapsedMs,
        ok: input.ok,
        errorCode: input.errorCode,
        stopCode,
        stopDetail,
        fingerprint: held.fingerprint,
        messagesDigest: held.messagesDigest,
      });
      return { ok: stopCode === null, code: stopCode, record };
    },

    abandon(input) {
      if (!inFlight) return { record: null };
      if (input.ticket && inFlight.ticket !== input.ticket) return { record: null };
      const held = inFlight;
      inFlight = null;
      stop("REQUEST_UNSETTLED", input.reason);
      const record = pushRecord({
        chain: held.chain,
        ticket: held.ticket,
        requestedModel: config.model,
        actualModel: "unknown",
        modelMismatch: false,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        inputUpperBound: held.tokenUpperBound,
        outputCapTokens: held.outputCapTokens,
        costUsd: null,
        costCny: null,
        costUnknown: true,
        settled: false,
        httpStatusClass: "unknown",
        httpStatus: null,
        elapsedMs: null,
        ok: false,
        errorCode: "REQUEST_UNSETTLED",
        stopCode: "REQUEST_UNSETTLED",
        stopDetail: input.reason,
        fingerprint: held.fingerprint,
        messagesDigest: held.messagesDigest,
      });
      return { record };
    },

    halt(input) {
      stop(input.code, input.detail);
    },

    state() {
      return {
        spentCny,
        requests,
        authorizations: records.length,
        unsettled: records.filter((record) => !record.settled).length,
        consecutiveFailures,
        inFlight: inFlight !== null,
        stopped,
        records: [...records],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 批次上下文：只有显式进入 `runWithBatchGate` 的调用才受闸约束。
// 正常工作台不进入该上下文 → 行为完全不变。
// ---------------------------------------------------------------------------

export type BatchGateContext = { readonly gate: BatchRequestGate; readonly chain: BatchChain };

const batchGateStorage = new AsyncLocalStorage<BatchGateContext>();

export function runWithBatchGate<T>(context: BatchGateContext, fn: () => Promise<T>): Promise<T> {
  return batchGateStorage.run(context, fn);
}

/** 出站调用边界（`aiClient.callAiText`）读取它；没有上下文即普通调用。 */
export function getActiveBatchGate(): BatchGateContext | undefined {
  return batchGateStorage.getStore();
}
