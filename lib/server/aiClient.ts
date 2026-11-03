import "server-only";

import OpenAI from "openai";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { getActiveBatchGate } from "./research/batchInputBudget";

const DEFAULT_PROVIDER = "openai";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 45_000;

export type AiProvider = "openai" | "deepseek" | (string & { readonly __aiProvider?: never });

export type AiClientErrorCode =
  | "unsupported_provider"
  | "missing_api_key"
  | "missing_model"
  | "missing_base_url"
  | "timeout"
  | "network_error"
  | "invalid_api_key"
  | "insufficient_balance"
  | "invalid_model"
  | "invalid_parameters"
  | "invalid_endpoint"
  | "rate_limited"
  | "provider_unavailable"
  | "empty_response"
  | "json_parse_error"
  | "provider_error"
  /** 批次发送闸在发送前拒绝（预检/预算/并发/请求数）。请求未发出。 */
  | "batch_gate_blocked"
  /** 批次发送闸在结算时发现违约（用量缺失、上界被突破、模型不符等）。请求已发出。 */
  | "batch_gate_violation"
  | "unknown_error";

export type AiClientError = {
  code: AiClientErrorCode;
  message: string;
  status?: number;
  provider?: string;
  model?: string;
  detail?: string;
};

export type AiProviderHttpStatusClass =
  | "not_started"
  | "success"
  | "client_error"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network_error"
  | "unknown";

export type AiThinkingMode = "enabled" | "disabled";

export type AiCallDiagnostics = {
  model: string;
  thinkingMode: AiThinkingMode | "default";
  maxTokens: number | null;
  providerHttpStatusClass: AiProviderHttpStatusClass;
  finishReason: string | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  /** P5-04：实际输入 tokens（此前未采集，导致无法核算真实费用）。 */
  promptTokens?: number | null;
  /** P5-04：provider 返回的 total_tokens；缺失时保持 null，不用估算值顶替。 */
  totalTokens?: number | null;
  /** 本次请求声明的模型（config 或参数）。 */
  requestedModel?: string;
  /** provider 回显的模型与请求模型是否一致；不一致时上层必须停止自动调用。 */
  modelMismatch?: boolean;
  responseCharLength: number;
  responseContentPresent?: boolean;
  responseContentShape?: "text" | "missing" | "non_text" | "refusal";
  responseStartsWithFence?: boolean;
  responseEndsWithFence?: boolean;
  responseFirstCharType?: "object" | "array" | "quote" | "other" | "none";
  responseLastCharType?: "object" | "array" | "quote" | "other" | "none";
  responseFailureClass?: AiResponseFailureClass;
  jsonNormalizationStage?: "direct_json" | "markdown_fence" | "prefix_suffix" | "failed";
  jsonParseStage: "not_started" | "passed" | "failed";
  elapsedMs: number;
};

export type AiResponseFailureClass =
  | "none"
  | "content_missing"
  | "content_empty"
  | "unknown_response_shape"
  | "refusal"
  | "truncated"
  | "non_json"
  | "invalid_json";

export type AiResult<T> =
  | { ok: true; data: T; providerCallStarted?: boolean; diagnostics?: AiCallDiagnostics }
  | { ok: false; error: AiClientError; providerCallStarted?: boolean; diagnostics?: AiCallDiagnostics };

export type AiConfig = {
  provider: AiProvider;
  baseURL: string;
  apiKey: string;
  maskedApiKey: string;
  model: string;
  timeoutMs: number;
};

export type CallAiTextParams = {
  messages: ChatCompletionMessageParam[];
  /** Persist any non-refundable quota boundary before the SDK call begins. */
  onProviderCallStart?: () => void | Promise<void>;
  /** Request-scoped audit observer. Never receives request headers or credentials. */
  onProviderResponse?: (response: unknown) => void;
  temperature?: number;
  responseFormat?: ChatCompletionCreateParamsNonStreaming["response_format"];
  maxTokens?: number;
  /** DeepSeek request-level thinking toggle; omitted for other providers. */
  thinkingMode?: AiThinkingMode;
  model?: string;
  timeoutMs?: number;
};

type ProviderCallStartBoundary = {
  callback: () => void | Promise<void>;
  consumed: boolean;
};

const providerCallStartBoundary = new AsyncLocalStorage<ProviderCallStartBoundary>();

/** Bind one legacy request-scoped quota boundary to the next text Provider call. */
export function bindProviderCallStartBoundary(callback: () => void | Promise<void>): void {
  providerCallStartBoundary.enterWith({ callback, consumed: false });
}

async function persistProviderCallStart(params: CallAiTextParams): Promise<void> {
  if (params.onProviderCallStart) {
    await params.onProviderCallStart();
    return;
  }
  const boundary = providerCallStartBoundary.getStore();
  if (!boundary || boundary.consumed) return;
  boundary.consumed = true;
  await boundary.callback();
}

let cachedClient: OpenAI | null = null;
let cachedClientKey = "";

function ok<T>(data: T): AiResult<T> {
  return { ok: true, data };
}

function fail(error: AiClientError): AiResult<never> {
  return { ok: false, error };
}

function parseTimeoutMs(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_TIMEOUT_MS;
}

function normalizeProvider(value: string): AiProvider {
  return (value || DEFAULT_PROVIDER).toLowerCase() as AiProvider;
}

function getProviderDefaultBaseUrl(provider: AiProvider) {
  return provider === "deepseek" ? DEFAULT_DEEPSEEK_BASE_URL : DEFAULT_OPENAI_BASE_URL;
}

function getProviderDefaultModel(provider: AiProvider) {
  return provider === "deepseek" ? DEFAULT_DEEPSEEK_MODEL : DEFAULT_OPENAI_MODEL;
}

export function maskSecret(value: string) {
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function buildConfigError(
  code: AiClientErrorCode,
  message: string,
  config?: Partial<Pick<AiConfig, "provider" | "model">>,
): AiResult<never> {
  return fail({
    code,
    message,
    provider: config?.provider,
    model: config?.model,
  });
}

/** Read AI runtime config from environment variables without exposing secrets. */
export function getAiConfig(env: Record<string, string | undefined> = process.env): AiResult<AiConfig> {
  const readEnv = (name: string) => env[name]?.trim() || "";
  const provider = normalizeProvider(readEnv("AI_PROVIDER") || (
    readEnv("DEEPSEEK_API_KEY") && !readEnv("OPENAI_API_KEY") ? "deepseek" : DEFAULT_PROVIDER
  ));
  if (provider != "openai" && provider != "deepseek") {
    return buildConfigError("unsupported_provider", "AI Provider is not supported.");
  }
  const apiKey = readEnv("AI_API_KEY")
    || (provider === "deepseek" ? readEnv("DEEPSEEK_API_KEY") : readEnv("OPENAI_API_KEY"));
  const baseURL = readEnv("AI_BASE_URL")
    || (provider === "deepseek" ? readEnv("DEEPSEEK_BASE_URL") : readEnv("OPENAI_BASE_URL"))
    || getProviderDefaultBaseUrl(provider);
  const model = readEnv("AI_MODEL")
    || (provider === "deepseek" ? readEnv("DEEPSEEK_MODEL") : readEnv("OPENAI_MODEL"))
    || getProviderDefaultModel(provider);
  const timeoutMs = parseTimeoutMs(readEnv("AI_TIMEOUT_MS"));

  if (!apiKey) {
    return buildConfigError("missing_api_key", "AI API Key is missing.", { provider, model });
  }

  if (!baseURL) {
    return buildConfigError("missing_base_url", "AI base URL is missing.", { provider, model });
  }

  if (!model) {
    return buildConfigError("missing_model", "AI model is missing.", { provider });
  }

  return ok({
    provider,
    baseURL,
    apiKey,
    maskedApiKey: maskSecret(apiKey),
    model,
    timeoutMs,
  });
}

/** Create and cache an OpenAI-compatible client for server-side route handlers. */
export function createAiClient(config = getAiConfig()): AiResult<OpenAI> {
  if (!config.ok) {
    return config;
  }

  if (config.data.provider !== "openai" && config.data.provider !== "deepseek") {
    return buildConfigError("unsupported_provider", "AI Provider is not supported.");
  }
  const { apiKey, baseURL, timeoutMs } = config.data;
  const cacheKey = `${baseURL}|${maskSecret(apiKey)}|${timeoutMs}`;

  if (cachedClient && cachedClientKey === cacheKey) {
    return ok(cachedClient);
  }

  cachedClient = new OpenAI({
    apiKey,
    baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  });
  cachedClientKey = cacheKey;

  return ok(cachedClient);
}

function getObjectProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return "";
  return Reflect.get(value, property);
}

function getNestedPropertyCandidates(value: unknown, property: string) {
  const direct = getObjectProperty(value, property);
  const nestedError = getObjectProperty(value, "error");
  const nestedResponse = getObjectProperty(value, "response");
  const nestedCause = getObjectProperty(value, "cause");

  return [
    direct,
    getObjectProperty(nestedError, property),
    getObjectProperty(nestedResponse, property),
    getObjectProperty(nestedCause, property),
  ];
}

function getStringProperty(value: unknown, property: string) {
  const item = getNestedPropertyCandidates(value, property).find((candidate) => typeof candidate === "string");
  return typeof item === "string" ? item : "";
}

function getNumberProperty(value: unknown, property: string) {
  for (const item of getNestedPropertyCandidates(value, property)) {
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && item.trim()) {
      const parsed = Number(item);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function getSafeAiClientErrorMessage(code: AiClientErrorCode) {
  switch (code) {
    case "unsupported_provider":
      return "服务端 AI Provider 不在允许名单中，请检查配置。";
    case "missing_api_key":
      return "服务端 AI Key 未配置，请检查环境变量。";
    case "missing_model":
      return "服务端 AI_MODEL / DEEPSEEK_MODEL 未配置。";
    case "missing_base_url":
      return "服务端 AI_BASE_URL / DEEPSEEK_BASE_URL 未配置。";
    case "timeout":
      return "AI 请求超时，请稍后重试。";
    case "network_error":
      return "AI 服务网络连接失败，请检查服务器网络或 Base URL。";
    case "invalid_api_key":
      return "AI Key 无效或权限不足，请检查服务端环境变量。";
    case "insufficient_balance":
      return "AI 服务余额不足或额度不可用，请检查服务商账户。";
    case "invalid_model":
      return "AI 模型名无效或当前 Key 无权使用，请检查 AI_MODEL / DEEPSEEK_MODEL。";
    case "invalid_parameters":
      return "AI 请求参数不被服务商接受，请检查模型兼容性和请求格式。";
    case "invalid_endpoint":
      return "AI 服务地址无效，请检查 Base URL 或接口路径。";
    case "rate_limited":
      return "AI 请求过于频繁或触发限流，请稍后重试。";
    case "provider_unavailable":
      return "AI 服务商暂时不可用，请稍后重试。";
    case "provider_error":
      return "AI 服务返回错误，请检查模型名、余额、权限或服务商状态。";
    case "json_parse_error":
      return "AI 返回格式异常，请稍后重试。";
    case "empty_response":
      return "AI 返回为空，请稍后重试。";
    case "batch_gate_blocked":
      return "批次发送闸在发送前拒绝该请求（预检/预算/并发/请求数），请求未发出。";
    case "batch_gate_violation":
      return "批次发送闸在结算时发现违约（用量缺失、上界被突破或模型不符），批次必须停止。";
    case "unknown_error":
    default:
      return "AI 服务出现未知错误，请检查服务端 AI 配置或稍后重试。";
  }
}

function getProviderCodeFromStatus(status?: number): AiClientErrorCode | undefined {
  if (status === 401 || status === 403) return "invalid_api_key";
  if (status === 402) return "insufficient_balance";
  if (status === 404) return "invalid_model";
  if (status === 400 || status === 422) return "invalid_parameters";
  if (status === 429) return "rate_limited";
  if (status === 500 || status === 502 || status === 503 || status === 504) return "provider_unavailable";
  return undefined;
}

function getProviderCodeFromText(text: string): AiClientErrorCode | undefined {
  if (text.includes("401") || text.includes("403")) {
    return "invalid_api_key";
  }

  if (text.includes("402")) {
    return "insufficient_balance";
  }

  if (text.includes("404")) {
    return "invalid_model";
  }

  if (text.includes("400") || text.includes("422")) {
    return "invalid_parameters";
  }

  if (text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) {
    return "provider_unavailable";
  }

  if (
    text.includes("invalid_api_key")
    || text.includes("incorrect api key")
    || text.includes("unauthorized")
    || text.includes("authentication")
    || text.includes("permission denied")
  ) {
    return "invalid_api_key";
  }

  if (
    text.includes("insufficient_quota")
    || text.includes("insufficient balance")
    || text.includes("balance")
    || text.includes("billing")
    || text.includes("payment required")
  ) {
    return "insufficient_balance";
  }

  if (
    text.includes("model_not_found")
    || text.includes("model not found")
    || text.includes("model does not exist")
    || text.includes("no such model")
    || text.includes("invalid model")
  ) {
    return "invalid_model";
  }

  if (
    text.includes("invalid_request")
    || text.includes("invalid parameter")
    || text.includes("invalid_request_error")
    || text.includes("response_format")
    || text.includes("json_object")
    || text.includes("bad request")
    || text.includes("unprocessable")
  ) {
    return "invalid_parameters";
  }

  if (
    text.includes("rate_limit")
    || text.includes("rate limit")
    || text.includes("too many requests")
    || text.includes("429")
  ) {
    return "rate_limited";
  }

  if (
    text.includes("service unavailable")
    || text.includes("bad gateway")
    || text.includes("gateway timeout")
    || text.includes("internal server error")
  ) {
    return "provider_unavailable";
  }

  return undefined;
}

function classifyAiError(error: unknown, config?: AiConfig): AiClientError {
  const name = error instanceof Error ? error.name : getStringProperty(error, "name");
  const message = error instanceof Error
    ? error.message
    : getStringProperty(error, "message") || getStringProperty(error, "error") || "Unknown AI SDK error.";
  const status = getNumberProperty(error, "status");
  const codeText = getStringProperty(error, "code").toLowerCase();
  const typeText = getStringProperty(error, "type").toLowerCase();
  const lowerMessage = message.toLowerCase();
  const lowerName = name.toLowerCase();
  const providerText = [lowerName, codeText, typeText, lowerMessage].filter(Boolean).join(" ");

  if (
    lowerName.includes("timeout")
    || codeText.includes("timeout")
    || typeText.includes("timeout")
    || lowerMessage.includes("timeout")
    || lowerMessage.includes("timed out")
  ) {
    return {
      code: "timeout",
      message: "AI request timed out.",
      provider: config?.provider,
      model: config?.model,
      detail: message.slice(0, 240),
    };
  }

  if (
    lowerName.includes("apiconnection")
    || codeText.includes("econn")
    || codeText.includes("network")
    || typeText.includes("network")
    || lowerMessage.includes("fetch failed")
    || lowerMessage.includes("network")
  ) {
    return {
      code: "network_error",
      message: "AI network request failed.",
      provider: config?.provider,
      model: config?.model,
      detail: message.slice(0, 240),
    };
  }

  const providerCode = getProviderCodeFromStatus(status) || getProviderCodeFromText(providerText);

  if (
    status
    || ((typeof error === "object" || typeof error === "function") && error !== null)
    || lowerName.includes("apierror")
    || lowerName.includes("badrequest")
    || lowerName.includes("authentication")
    || lowerName.includes("permission")
    || lowerName.includes("ratelimit")
    || codeText.includes("invalid")
    || codeText.includes("auth")
    || codeText.includes("permission")
    || codeText.includes("rate")
    || typeText.includes("invalid")
    || typeText.includes("auth")
    || typeText.includes("permission")
    || typeText.includes("rate")
    || lowerMessage.includes("401")
    || lowerMessage.includes("403")
    || lowerMessage.includes("404")
    || lowerMessage.includes("429")
    || lowerMessage.includes("model")
    || lowerMessage.includes("quota")
    || lowerMessage.includes("balance")
    || lowerMessage.includes("permission")
    || lowerMessage.includes("api key")
  ) {
    return {
      code: providerCode || "provider_error",
      message: "AI provider returned an error.",
      status,
      provider: config?.provider,
      model: config?.model,
      detail: message.slice(0, 240),
    };
  }

  return {
    code: "unknown_error",
    message: "Unknown AI request error.",
    provider: config?.provider,
    model: config?.model,
    detail: message.slice(0, 240),
  };
}

type DeepSeekChatParams = ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: AiThinkingMode };
};

function makeChatParams(config: AiConfig, params: CallAiTextParams): ChatCompletionCreateParamsNonStreaming {
  const body: DeepSeekChatParams = {
    model: params.model || config.model,
    messages: params.messages,
    temperature: params.temperature,
    response_format: params.responseFormat,
    max_tokens: params.maxTokens,
  };
  if (config.provider === "deepseek" && params.thinkingMode) {
    body.thinking = { type: params.thinkingMode };
  }
  return body;
}

function normalizeFinishReason(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized && /^[a-z0-9_.-]{1,64}$/.test(normalized) ? normalized : "other";
}

function providerHttpStatusClass(error: AiClientError): AiProviderHttpStatusClass {
  if (error.code === "timeout") return "timeout";
  if (error.code === "network_error") return "network_error";
  if (error.status === 429 || error.code === "rate_limited") return "rate_limited";
  if (typeof error.status === "number" && error.status >= 500) return "server_error";
  if (typeof error.status === "number" && error.status >= 400) return "client_error";
  return "unknown";
}

function safeTokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function safeModelName(value: unknown, fallback: string) {
  const safeFallback = /^[a-zA-Z0-9._:/-]{1,128}$/.test(fallback) ? fallback : "unknown";
  if (typeof value !== "string") return safeFallback;
  const normalized = value.trim();
  return normalized && /^[a-zA-Z0-9._:/-]{1,128}$/.test(normalized) ? normalized : safeFallback;
}

function safeUsageDiagnostics(usage: unknown) {
  // P5-04：真实费用必须能由 usage 复算，因此输入与总量也要落盘；
  // 非法/缺失一律 null（不用 0 或估算值顶替，避免把未知洗成「零消耗」）。
  if (!usage || typeof usage !== "object") {
    return { completionTokens: null, reasoningTokens: null, promptTokens: null, totalTokens: null };
  }
  const record = usage as Record<string, unknown>;
  const details = record.completion_tokens_details && typeof record.completion_tokens_details === "object"
    ? record.completion_tokens_details as Record<string, unknown>
    : null;
  return {
    completionTokens: safeTokenCount(record.completion_tokens),
    reasoningTokens: safeTokenCount(details?.reasoning_tokens ?? record.reasoning_tokens),
    promptTokens: safeTokenCount(record.prompt_tokens),
    totalTokens: safeTokenCount(record.total_tokens),
  };
}

function safeEdgeCharType(value: string, first: boolean): AiCallDiagnostics["responseFirstCharType"] {
  const trimmed = value.trim();
  if (!trimmed) return "none";
  const char = first ? trimmed[0] : trimmed[trimmed.length - 1];
  if (char === "{") return "object";
  if (char === "[") return "array";
  if (char === "\"" || char === "'") return "quote";
  return "other";
}

function responseDiagnostics(content: unknown, refusalPresent = false) {
  const text = typeof content === "string" ? content : "";
  const normalized = text.trim();
  const startsWithFence = /^```/u.test(normalized);
  const endsWithFence = /```$/u.test(normalized);
  const contentShape = refusalPresent
    ? "refusal" as const
    : typeof content === "string"
      ? "text" as const
      : content === null || content === undefined
        ? "missing" as const
        : "non_text" as const;
  return {
    responseCharLength: text.length,
    responseContentPresent: content !== null && content !== undefined,
    responseContentShape: contentShape,
    responseStartsWithFence: startsWithFence,
    responseEndsWithFence: endsWithFence,
    responseFirstCharType: safeEdgeCharType(normalized, true),
    responseLastCharType: safeEdgeCharType(normalized, false),
  };
}

function baseDiagnostics(config: AiConfig, params: CallAiTextParams) {
  return {
    model: safeModelName(params.model || config.model, "unknown"),
    thinkingMode: config.provider === "deepseek" && params.thinkingMode
      ? params.thinkingMode
      : "default" as const,
    maxTokens: safeTokenCount(params.maxTokens),
  };
}

type ChatCallInput = {
  readonly client: OpenAI;
  readonly config: AiConfig;
  readonly params: CallAiTextParams;
  readonly chatParams: ChatCompletionCreateParamsNonStreaming;
  readonly timeoutMs: number;
  readonly startedAt: number;
};

/** 真正发出 HTTP 请求并归一化响应；不含任何批次闸逻辑。 */
async function requestChatCompletion(input: ChatCallInput): Promise<AiResult<string>> {
  const { client, config, params, chatParams, timeoutMs, startedAt } = input;

  // The caller's durable boundary must succeed before any external request is made.
  await persistProviderCallStart(params);

  try {
    const response = await client.chat.completions.create(chatParams, { timeout: timeoutMs });
    params.onProviderResponse?.(response);
    const choice = response.choices[0];
    const message = choice?.message;
    const content: unknown = message?.content;
    const refusalPresent = typeof message?.refusal === "string" && message.refusal.trim().length > 0;
    const text = typeof content === "string" ? content.trim() : "";
    const usage = safeUsageDiagnostics(response.usage);
    const shapeDiagnostics = responseDiagnostics(content, refusalPresent);
    const requestedModel = safeModelName(params.model || config.model, "unknown");
    const actualModel = safeModelName(response.model, requestedModel);
    const diagnostics: AiCallDiagnostics = {
      ...baseDiagnostics(config, params),
      model: actualModel,
      requestedModel,
      modelMismatch: actualModel !== requestedModel,
      providerHttpStatusClass: "success",
      finishReason: normalizeFinishReason(response.choices[0]?.finish_reason),
      ...usage,
      ...shapeDiagnostics,
      responseFailureClass: "none",
      jsonParseStage: "not_started",
      elapsedMs: Date.now() - startedAt,
    };

    if (diagnostics.finishReason === "length") {
      return {
        ...fail({ code: "json_parse_error", message: "AI response was truncated at the output limit.", detail: "class=truncated" }),
        providerCallStarted: true,
        diagnostics: { ...diagnostics, responseFailureClass: "truncated", jsonParseStage: "failed" },
      };
    }

    if (refusalPresent) {
      return {
        ...fail({ code: "provider_error", message: "AI provider refused the request.", detail: "class=refusal" }),
        providerCallStarted: true,
        diagnostics: { ...diagnostics, responseFailureClass: "refusal" },
      };
    }

    if (!choice || !message) {
      return {
        ...fail({ code: "provider_error", message: "AI provider returned an unknown response shape.", detail: "class=unknown_response_shape" }),
        providerCallStarted: true,
        diagnostics: { ...diagnostics, responseContentShape: "non_text", responseFailureClass: "unknown_response_shape" },
      };
    }

    if (content === null || content === undefined) {
      return {
        ...fail({ code: "provider_error", message: "AI provider response content is missing.", detail: "class=content_missing" }),
        providerCallStarted: true,
        diagnostics: { ...diagnostics, responseFailureClass: "content_missing" },
      };
    }

    if (typeof content !== "string") {
      return {
        ...fail({ code: "provider_error", message: "AI provider returned an unsupported response shape.", detail: "class=unknown_response_shape" }),
        providerCallStarted: true,
        diagnostics: { ...diagnostics, responseFailureClass: "unknown_response_shape" },
      };
    }

    if (!text) {
      return { ...fail({
        code: "empty_response",
        message: "AI returned empty text.",
        provider: config.provider,
        model: params.model || config.model,
        detail: "class=content_empty",
      }), providerCallStarted: true, diagnostics: { ...diagnostics, responseFailureClass: "content_empty" } };
    }

    return { ...ok(text), providerCallStarted: true, diagnostics };
  } catch (error) {
    const failure = error && typeof error === "object" ? error as Record<string, unknown> : {};
    params.onProviderResponse?.({ kind: "provider_error", status: failure.status ?? null,
      responseId: failure.request_id ?? null, error: failure.error ?? (error instanceof Error ? error.message : "unknown_error") });
    const classified = classifyAiError(error, config);
    return {
      ...fail(classified),
      providerCallStarted: true,
      diagnostics: {
        ...baseDiagnostics(config, params),
        providerHttpStatusClass: providerHttpStatusClass(classified),
        finishReason: null,
        completionTokens: null,
        reasoningTokens: null,
        responseCharLength: 0,
        responseContentPresent: false,
        responseContentShape: "missing",
        responseStartsWithFence: false,
        responseEndsWithFence: false,
        responseFirstCharType: "none",
        responseLastCharType: "none",
        responseFailureClass: "unknown_response_shape",
        jsonParseStage: "not_started",
        elapsedMs: Date.now() - startedAt,
      },
    };
  }
}

function blockedDiagnostics(config: AiConfig, params: CallAiTextParams, elapsedMs: number): AiCallDiagnostics {
  return {
    ...baseDiagnostics(config, params),
    providerHttpStatusClass: "not_started",
    finishReason: null,
    completionTokens: null,
    reasoningTokens: null,
    promptTokens: null,
    totalTokens: null,
    responseCharLength: 0,
    responseContentPresent: false,
    responseContentShape: "missing",
    responseStartsWithFence: false,
    responseEndsWithFence: false,
    responseFirstCharType: "none",
    responseLastCharType: "none",
    responseFailureClass: "none",
    jsonParseStage: "not_started",
    elapsedMs,
  };
}

/**
 * Call an OpenAI-compatible chat completion endpoint and return text content.
 *
 * 批次模式（`runWithBatchGate`）下：发送前必须通过 `gate.authorize`，响应后必须 `gate.settle`。
 * 正常工作台不进入该上下文，`getActiveBatchGate()` 返回 undefined，走的仍是原来的单次调用路径。
 */
export async function callAiText(params: CallAiTextParams): Promise<AiResult<string>> {
  const startedAt = Date.now();
  const configResult = getAiConfig();
  if (!configResult.ok) {
    return { ...configResult, providerCallStarted: false };
  }

  const clientResult = createAiClient(configResult);
  if (!clientResult.ok) {
    return { ...clientResult, providerCallStarted: false };
  }

  const chatParams = makeChatParams(configResult.data, params);
  const timeoutMs = params.timeoutMs || configResult.data.timeoutMs;
  const gateContext = getActiveBatchGate();

  let ticket: { readonly ticket: string; readonly fingerprint: string } | null = null;
  if (gateContext) {
    const authorized = gateContext.gate.authorize({
      chain: gateContext.chain,
      model: chatParams.model,
      messages: params.messages.map((message) => ({
        role: message.role,
        // 批次链路只用纯文本消息；非文本按稳定序列化入指纹，仍然绑定「实际发出的内容」。
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? null),
      })),
      maxTokens: typeof chatParams.max_tokens === "number" ? chatParams.max_tokens : null,
      temperature: typeof chatParams.temperature === "number" ? chatParams.temperature : null,
      responseFormat: chatParams.response_format ?? null,
      timeoutMs,
    });
    if (!authorized.ok) {
      // 闸拒绝：既不进入持久化边界，也不发 HTTP。
      return {
        ...fail({
          code: "batch_gate_blocked",
          message: "Batch request gate rejected the request before it was sent.",
          provider: configResult.data.provider,
          model: chatParams.model,
          detail: `class=batch_gate_blocked;code=${authorized.code}`,
        }),
        providerCallStarted: false,
        diagnostics: blockedDiagnostics(configResult.data, params, Date.now() - startedAt),
      };
    }
    ticket = { ticket: authorized.ticket, fingerprint: authorized.fingerprint };
  }

  const result = await requestChatCompletion({
    client: clientResult.data,
    config: configResult.data,
    params,
    chatParams,
    timeoutMs,
    startedAt,
  });

  if (!gateContext || !ticket) return result;

  const diagnostics = result.diagnostics ?? null;
  const settlement = gateContext.gate.settle({
    ticket: ticket.ticket,
    fingerprint: ticket.fingerprint,
    actualModel: diagnostics?.model ?? chatParams.model,
    requestedModel: diagnostics?.requestedModel ?? chatParams.model,
    promptTokens: diagnostics?.promptTokens ?? null,
    completionTokens: diagnostics?.completionTokens ?? null,
    totalTokens: diagnostics?.totalTokens ?? null,
    httpStatusClass: diagnostics?.providerHttpStatusClass ?? "unknown",
    httpStatus: result.ok ? null : (result.error.status ?? null),
    elapsedMs: diagnostics?.elapsedMs ?? null,
    ok: result.ok,
    errorCode: result.ok ? null : result.error.code,
  });

  // 已经失败的结果保留原错误（更可诊断）；闸的停止原因由 gate.state().stopped 记录。
  if (settlement.ok || !result.ok) return result;

  return {
    ...fail({
      code: "batch_gate_violation",
      message: "Batch request gate rejected this response; the batch must stop.",
      provider: configResult.data.provider,
      model: diagnostics?.model ?? chatParams.model,
      detail: `class=batch_gate_violation;code=${settlement.code}`,
    }),
    providerCallStarted: true,
    diagnostics: diagnostics ?? blockedDiagnostics(configResult.data, params, Date.now() - startedAt),
  };
}

function stripExplicitJsonFence(text: string): string | null {
  const match = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  return match?.[1] ?? null;
}

function findBalancedJsonRoot(text: string, start: number): number | null {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return null;
  const stack: string[] = [opening];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
      if (!stack.length) return index;
    }
  }
  return null;
}

function extractUniqueJsonRoot(text: string): string | null {
  let candidate: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    const end = findBalancedJsonRoot(text, index);
    if (end === null) return null;
    if (candidate !== null) return null;
    candidate = text.slice(index, end + 1);
    index = end;
  }
  return candidate;
}

/** Parse strict JSON after deterministic BOM/whitespace/fence normalization or unique balanced-root extraction. */
export function safeParseJsonFromAiText<T = unknown>(text: string): AiResult<T> {
  const normalized = text.replace(/^\uFEFF/u, "").trim();
  const fenced = stripExplicitJsonFence(normalized);
  const candidates = [normalized, ...(fenced === null ? [] : [fenced.replace(/^\uFEFF/u, "").trim()])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return ok(JSON.parse(candidate) as T);
    } catch {
      // Continue only with deterministic wrapper normalization below.
    }
  }

  const extracted = extractUniqueJsonRoot(fenced === null ? normalized : fenced.trim());
  if (extracted) {
    try {
      return ok(JSON.parse(extracted) as T);
    } catch {
      // Balanced boundaries are not JSON repair; malformed JSON remains rejected.
    }
  }

  const failureClass = /[\[{]/u.test(normalized) ? "invalid_json" : "non_json";

  return fail({
    code: "json_parse_error",
    message: "Failed to parse JSON from AI text.",
    detail: `class=${failureClass};response_length=${text.length}`,
  });
}

function jsonNormalizationStage(text: string, parsed: AiResult<unknown>): AiCallDiagnostics["jsonNormalizationStage"] {
  if (!parsed.ok) return "failed";
  const normalized = text.replace(/^\uFEFF/u, "").trim();
  try { JSON.parse(normalized); return "direct_json"; } catch { /* check explicit wrappers */ }
  const fenced = stripExplicitJsonFence(normalized);
  if (fenced !== null) {
    try { JSON.parse(fenced.replace(/^\uFEFF/u, "").trim()); return "markdown_fence"; } catch { /* try safe extraction */ }
  }
  return "prefix_suffix";
}

/** Call AI and parse the response as JSON. */
export async function callAiJson<T>(params: Omit<CallAiTextParams, "responseFormat"> & {
  responseFormat?: ChatCompletionCreateParamsNonStreaming["response_format"];
}): Promise<AiResult<T>> {
  const startedAt = Date.now();
  const textResult = await callAiText({
    ...params,
    responseFormat: params.responseFormat || { type: "json_object" },
  });

  if (!textResult.ok) {
    if (textResult.diagnostics && textResult.error.detail?.includes("class=truncated")) {
      return {
        ...textResult,
        diagnostics: { ...textResult.diagnostics, jsonParseStage: "failed", responseFailureClass: "truncated" },
      };
    }
    return textResult;
  }

  const parsed = safeParseJsonFromAiText<T>(textResult.data);
  return {
    ...parsed,
    providerCallStarted: textResult.providerCallStarted === true,
    diagnostics: {
      ...(textResult.diagnostics || {
        model: params.model || "unknown",
        thinkingMode: params.thinkingMode || "default",
        maxTokens: safeTokenCount(params.maxTokens),
        providerHttpStatusClass: "unknown" as const,
        finishReason: null,
        completionTokens: null,
        reasoningTokens: null,
        responseCharLength: textResult.data.length,
        jsonParseStage: "not_started" as const,
        elapsedMs: 0,
      }),
      jsonParseStage: parsed.ok ? "passed" : "failed",
      jsonNormalizationStage: jsonNormalizationStage(textResult.data, parsed),
      responseFailureClass: parsed.ok
        ? "none"
        : parsed.error.detail?.includes("class=non_json")
          ? "non_json"
          : "invalid_json",
      elapsedMs: Date.now() - startedAt,
    },
  };
}
