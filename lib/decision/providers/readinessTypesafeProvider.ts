/**
 * lib/decision/providers/readinessTypesafeProvider.ts
 *
 * TypeSafe System One 传输边界（Jev Research Readiness 专用适配层）。
 *
 * 复用既有 `typesafeProvider.ts` 的传输纪律：server-only Key、15s 超时、无重试、
 * 429 / 401 / 403 / 非 2xx / 解析失败一律映射为失败或不可用，绝不静默降级为桩成功、
 * 绝不自动切换 Mock。
 *
 * **真实协议状态：NOT_VERIFIED。**
 * 现有可核验证据只覆盖旧 ProductDecision（P1-P3 评分）问题集；Readiness 问题集的
 * 请求/应答 schema 未经真实协议校准。因此：
 * - 未注入 `buildRequestBody` 时，本 Provider **不发出任何请求**，直接返回 unavailable；
 * - 注入路径（`buildRequestBody` / `mapResponseBody`）仅作为可测试的候选实现，
 *   供离线测试与未来协议校准后启用；
 * - 未经用户授权，不得对真实接口做探测调用。
 *
 * 明确不复用：旧 ProductDecision 的 priority(P1-P3) / score 归一化 / confidence 契约。
 */
import "server-only";

import type { JevReadinessInput, ReadinessAdviceProvider } from "@/lib/decision/readiness/types";
import { TransportFailure } from "@/lib/decision/readiness/offlineProvider";
import { JEV_READINESS_TIMEOUT_MS } from "@/lib/decision/readiness/policy";

const PROVIDER_ID = "typesafe-readiness";

/** 真实协议兼容性状态（无可靠协议样本前恒为 NOT_VERIFIED）。 */
export const READINESS_REAL_PROTOCOL_STATUS = "NOT_VERIFIED" as const;

export type ReadinessRequestBuilder = (input: JevReadinessInput) => Record<string, unknown>;
export type ReadinessResponseMapper = (body: unknown, input: JevReadinessInput) => unknown;

export type TypeSafeReadinessProviderConfig = {
  readonly fetchImpl?: typeof fetch;
  readonly apiKey?: string | null;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** 经校准的请求构造器；未注入时 Provider 不发起任何请求（fail-closed）。 */
  readonly buildRequestBody?: ReadinessRequestBuilder | null;
  /** 应答 → 候选 advice 映射；默认使用候选映射（协议未验证）。 */
  readonly mapResponseBody?: ReadinessResponseMapper | null;
};

type TypeSafeSystemOneRequestBody = {
  readonly state: unknown;
  readonly questions: Record<string, unknown>;
  readonly assets?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pin the credential-bearing request to TypeSafe's documented HTTPS v1 endpoint. */
function resolveSystemOneUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TransportFailure("INVALID_API_BASE_URL", "TypeSafe API 地址无效；未发起请求。");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.typesafe.ai" || parsed.port
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname.replace(/\/+$/, "") !== "/v1") {
    throw new TransportFailure("INVALID_API_BASE_URL", "TypeSafe API 仅允许 https://api.typesafe.ai/v1；未发起请求。");
  }
  return "https://api.typesafe.ai/v1/systemone";
}

function validateSystemOneRequestBody(value: Record<string, unknown>): TypeSafeSystemOneRequestBody {
  if (Object.hasOwn(value, "model") || !Object.hasOwn(value, "state")
    || !isRecord(value.questions) || Object.keys(value.questions).length === 0
    || (value.assets !== undefined && (!isRecord(value.assets) || Object.keys(value.assets).length === 0))) {
    throw new TransportFailure("INVALID_REQUEST", "TypeSafe System One 请求不符合 v1 的 state/questions 契约；未发起请求。");
  }
  return value as TypeSafeSystemOneRequestBody;
}

/** Validate the required response envelope documented by TypeSafe OpenAPI v1. */
function validateSystemOneResponse(value: unknown): value is {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
} {
  if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim()
    || !isRecord(value.answers) || Object.keys(value.answers).length === 0
    || !isRecord(value.usage)) return false;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = value.usage;
  return Number.isInteger(inputTokens) && Number.isInteger(outputTokens)
    && Number(inputTokens) >= 0 && Number(outputTokens) >= 0;
}

function unavailableAdvice(input: JevReadinessInput, reason: string): unknown {
  return {
    status: "unavailable",
    readiness: null,
    reviewQuestions: [],
    contradictions: [],
    missingEvidence: [],
    limitations: [`${reason}（真实协议状态：${READINESS_REAL_PROTOCOL_STATUS}）`],
    inputBinding: { ...input.binding },
  };
}

/**
 * 候选应答映射（PROTOCOL_UNVERIFIED）。
 *
 * 仅按结构提取字段；无法识别的形状不做任何兜底修补，交由 schema 层
 * （parseJevReadinessAdvice）整份拒收 → failed。binding 以输入回填，
 * 若服务端将来回显 binding，schema 层仍会执行严格一致校验。
 */
export function defaultMapReadinessResponse(body: unknown, input: JevReadinessInput): unknown {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const answers = record.answers && typeof record.answers === "object" && !Array.isArray(record.answers)
    ? (record.answers as Record<string, unknown>)
    : {};
  const readinessRaw = answers["readiness"];
  let readiness: unknown = null;
  if (readinessRaw && typeof readinessRaw === "object" && !Array.isArray(readinessRaw)) {
    const choice = (readinessRaw as Record<string, unknown>)["choice"];
    readiness = typeof choice === "string" ? choice : null;
  } else if (typeof readinessRaw === "string") {
    readiness = readinessRaw;
  }
  return {
    status: typeof record["status"] === "string" ? record["status"] : "available",
    readiness,
    reviewQuestions: answers["review_questions"] ?? [],
    contradictions: answers["contradictions"] ?? [],
    missingEvidence: answers["missing_evidence"] ?? [],
    limitations: answers["limitations"] ?? [],
    inputBinding: { ...input.binding },
  };
}

export class TypeSafeReadinessProvider implements ReadinessAdviceProvider {
  readonly providerId = PROVIDER_ID;
  private reportedModel: string | null = null;

  get model(): string {
    return this.reportedModel ?? this.config.model ?? process.env["TYPESAFE_MODEL"] ?? "jev-latest";
  }

  constructor(private readonly config: TypeSafeReadinessProviderConfig = {}) {}

  /**
   * 单次调用：最多一次外部请求（无重试、无二次补发）。
   * 所有失败路径抛 `TransportFailure`（由执行器映射为 failed）或返回 unavailable 载荷。
   */
  async advise(input: JevReadinessInput): Promise<unknown> {
    const apiKey = this.config.apiKey !== undefined
      ? this.config.apiKey
      : (process.env["TYPESAFE_API_KEY"] ?? null);
    if (!apiKey) {
      return unavailableAdvice(input, "TypeSafe Jev readiness 未配置 API Key。");
    }

    const build = this.config.buildRequestBody ?? null;
    if (!build) {
      return unavailableAdvice(input, "真实协议未验证（PROTOCOL_UNVERIFIED）：未提供经校准的请求构造器，未发起任何请求。");
    }

    const endpoint = resolveSystemOneUrl(this.config.baseUrl ?? process.env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai/v1");
    const model = this.config.model ?? process.env["TYPESAFE_MODEL"] ?? "jev-latest";
    const timeoutMs = this.config.timeoutMs ?? JEV_READINESS_TIMEOUT_MS;
    const fetchImpl = this.config.fetchImpl ?? fetch;
    let requestBody: TypeSafeSystemOneRequestBody;
    try {
      requestBody = validateSystemOneRequestBody(build(input));
    } catch (error) {
      if (error instanceof TransportFailure) throw error;
      throw new TransportFailure("INVALID_REQUEST", "TypeSafe System One 请求构造失败；未发起请求。");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, ...requestBody }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TransportFailure("ETIMEDOUT", "TypeSafe Jev readiness 请求超时。");
      }
      throw new TransportFailure("NETWORK_ERROR", "TypeSafe Jev readiness 请求失败。");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 429) throw new TransportFailure("HTTP_429", "TypeSafe Jev readiness 触发限流（不重试）。");
      if (response.status === 401 || response.status === 403) {
        throw new TransportFailure("HTTP_AUTH", `TypeSafe Jev readiness 鉴权失败（${response.status}）。`);
      }
      throw new TransportFailure(`HTTP_${response.status}`, `TypeSafe Jev readiness 返回失败（${response.status}，不重试）。`);
    }
    if (response.status !== 200) {
      throw new TransportFailure("UNEXPECTED_HTTP_STATUS", `TypeSafe System One v1 返回未记录的 HTTP ${response.status}（未解析为结论）。`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TransportFailure("INVALID_JSON", "TypeSafe Jev readiness 返回了无法解析的 JSON。");
    }

    if (!validateSystemOneResponse(body)) {
      throw new TransportFailure("INVALID_RESPONSE", "TypeSafe System One 响应不符合 v1 的 model/answers/usage 契约。");
    }

    this.reportedModel = body.model;
    const mapper = this.config.mapResponseBody ?? defaultMapReadinessResponse;
    return mapper(body, input);
  }
}
