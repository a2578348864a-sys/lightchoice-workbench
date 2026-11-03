import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({
  create: vi.fn(),
  clientOptions: null as Record<string, unknown> | null,
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: openAiMocks.create } };

    constructor(options: Record<string, unknown>) {
      openAiMocks.clientOptions = options;
    }
  },
}));

import {
  getAiConfig, createAiClient,
  bindProviderCallStartBoundary,
  callAiJson,
  callAiText,
  safeParseJsonFromAiText,
} from "@/lib/server/aiClient";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("AI_API_KEY", "unit-test-key");
  vi.stubEnv("AI_MODEL", "unit-test-model");
  vi.stubEnv("AI_BASE_URL", "https://provider.invalid/v1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("captures provider body before JSON normalization, including an invalid draft", async () => {
  const raw = { id: "synthetic-response", model: "unit-test-model", choices: [{ message: { content: "{broken json" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  openAiMocks.create.mockResolvedValueOnce(raw);
  const observer = vi.fn();
  const result = await callAiJson({ messages: [{ role: "user", content: "offline fixture" }], onProviderResponse: observer });
  expect(result.ok).toBe(false);
  expect(observer).toHaveBeenCalledWith(raw);
  expect(observer).toHaveBeenCalledTimes(1);
});

describe("safeParseJsonFromAiText", () => {
  it.each([
    ["CASE 01 direct JSON", '{"verdict":"pass"}', true],
    ["CASE 02 whitespace", '  \n {"verdict":"pass"} \t ', true],
    ["CASE 03 UTF-8 BOM", '\uFEFF{"verdict":"pass"}', true],
    ["CASE 04 json fence", '```json\n{"verdict":"pass"}\n```', true],
    ["CASE 05 generic fence", '```\n{"verdict":"pass"}\n```', true],
    ["CASE 06 unique object with prefix", 'Here is the JSON:\n{"verdict":"pass"}', true],
    ["CASE 07 unique object with suffix", '{"verdict":"pass"}\nDone.', true],
    ["CASE 08 multiple objects", '{"a":1} then {"b":2}', false],
    ["CASE 09 truncated object", '{"a":{"b":1}', false],
    ["CASE 10 trailing comma", '{"a":1,}', false],
    ["CASE 11 pseudo JSON", "{'a':'1'}", false],
    ["CASE 12 top-level array remains valid JSON for caller schema gate", '[{"a":1}]', true],
    ["invalid prose", 'provider said no JSON', false],
  ])("%s", (_name, input, expected) => {
    expect(safeParseJsonFromAiText(input).ok).toBe(expected);
  });

  it("AI 返回不可解析文本时返回安全分类，不泄露 Provider 正文", () => {
    const sensitiveProviderText = "PRIVATE_PROVIDER_BODY_NOT_FOR_LOGS ".repeat(20);
    const result = safeParseJsonFromAiText(sensitiveProviderText);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("json_parse_error");
      expect(result.error.detail?.length).toBeLessThanOrEqual(240);
      expect(result.error.detail).toContain("class=non_json");
      expect(result.error.detail).not.toContain("PRIVATE_PROVIDER_BODY_NOT_FOR_LOGS");
    }
  });
});

describe("providerCallStarted", () => {
  it("persists the started boundary immediately before invoking the Provider SDK", async () => {
    const events: string[] = [];
    openAiMocks.create.mockImplementationOnce(async () => {
      events.push("provider");
      return { choices: [{ message: { content: "ok" } }] };
    });

    await callAiText({
      messages: [{ role: "user", content: "test" }],
      onProviderCallStart: () => { events.push("persisted"); },
    });

    expect(events).toEqual(["persisted", "provider"]);
  });

  it("does not invoke the Provider when persisting the started boundary fails", async () => {
    await expect(callAiText({
      messages: [{ role: "user", content: "test" }],
      onProviderCallStart: () => { throw new Error("quota boundary unavailable"); },
    })).rejects.toThrow("quota boundary unavailable");

    expect(openAiMocks.create).not.toHaveBeenCalled();
  });

  it("uses a one-shot request boundary for legacy quota callers", async () => {
    const boundary = vi.fn();
    bindProviderCallStartBoundary(boundary);
    openAiMocks.create
      .mockResolvedValueOnce({ choices: [{ message: { content: "first" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "second" } }] });

    await callAiText({ messages: [{ role: "user", content: "first" }] });
    await callAiText({ messages: [{ role: "user", content: "second" }] });

    expect(boundary).toHaveBeenCalledOnce();
    expect(openAiMocks.create).toHaveBeenCalledTimes(2);
  });

  it("sets maxRetries=0 and marks a successful SDK call as started", async () => {
    openAiMocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] });

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.providerCallStarted).toBe(true);
    expect(openAiMocks.create).toHaveBeenCalledOnce();
    expect(openAiMocks.clientOptions).toEqual(expect.objectContaining({ maxRetries: 0 }));
  });

  it.each([
    ["rate_limited", Object.assign(new Error("429 rate limited"), { status: 429 })],
    ["timeout", Object.assign(new Error("request timed out"), { name: "TimeoutError" })],
  ])("marks %s after the SDK call starts", async (_label, error) => {
    openAiMocks.create.mockRejectedValueOnce(error);

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.ok).toBe(false);
    expect(result.providerCallStarted).toBe(true);
  });

  it("marks an empty provider response as started", async () => {
    openAiMocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "" } }] });

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.ok).toBe(false);
    expect(result.providerCallStarted).toBe(true);
    if (!result.ok) expect(result.error.code).toBe("empty_response");
  });

  it("P5-04：正常 usage 必须落 prompt/completion/total 与模型一致性", async () => {
    openAiMocks.create.mockResolvedValueOnce({
      model: "unit-test-model",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 },
    });

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject({
      model: "unit-test-model",
      requestedModel: "unit-test-model",
      modelMismatch: false,
      promptTokens: 1234,
      completionTokens: 567,
      totalTokens: 1801,
    });
    expect(typeof result.diagnostics?.elapsedMs).toBe("number");
  });

  it("P5-04：usage 缺失时保持 null，不用 0 顶替", async () => {
    openAiMocks.create.mockResolvedValueOnce({ model: "unit-test-model", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject({ promptTokens: null, completionTokens: null, totalTokens: null });
  });

  it("P5-04：usage 字段异常时逐项兜底（负数/字符串→null，浮点截断）", async () => {
    openAiMocks.create.mockResolvedValueOnce({
      model: "unit-test-model",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: -1, completion_tokens: "abc", total_tokens: 1.9 },
    });

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.diagnostics).toMatchObject({ promptTokens: null, completionTokens: null, totalTokens: 1 });
  });

  it("P5-04：provider 回显模型与请求模型不一致时必须标记", async () => {
    openAiMocks.create.mockResolvedValueOnce({
      model: "deepseek-chat",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.diagnostics).toMatchObject({ model: "deepseek-chat", requestedModel: "unit-test-model", modelMismatch: true });
  });

  it("preserves the started marker when JSON parsing fails", async () => {
    openAiMocks.create.mockResolvedValueOnce({
      choices: [{ finish_reason: "length", message: { content: "not-json" } }],
    });

    const result = await callAiJson({ messages: [{ role: "user", content: "test" }] });

    expect(result.ok).toBe(false);
    expect(result.providerCallStarted).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe("json_parse_error");
      expect(result.diagnostics).toMatchObject({
        providerHttpStatusClass: "success",
        finishReason: "length",
        responseCharLength: 8,
        jsonParseStage: "failed",
        responseFailureClass: "truncated",
      });
      expect(result.diagnostics?.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    ["missing content", { choices: [{ finish_reason: "stop", message: { content: null } }] }, "content_missing"],
    ["unknown content shape", { choices: [{ finish_reason: "stop", message: { content: [{ type: "text", text: "{}" }] } }] }, "unknown_response_shape"],
    ["refusal", { choices: [{ finish_reason: "stop", message: { content: null, refusal: "sensitive refusal text" } }] }, "refusal"],
  ])("classifies %s without retaining response text", async (_name, response, failureClass) => {
    openAiMocks.create.mockResolvedValueOnce(response);
    const result = await callAiJson({ messages: [{ role: "user", content: "test" }] });
    expect(result.ok).toBe(false);
    expect(result.diagnostics?.responseFailureClass).toBe(failureClass);
    expect(JSON.stringify(result)).not.toContain("sensitive refusal text");
  });

  it.each([
    ["markdown_fence", '```json\n{"ok":true}\n```'],
    ["prefix_suffix", 'Result: {"ok":true} done'],
  ])("records safe normalization stage %s", async (stage, content) => {
    openAiMocks.create.mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content } }] });
    const result = await callAiJson({ messages: [{ role: "user", content: "test" }] });
    expect(result.ok).toBe(true);
    expect(result.diagnostics?.jsonNormalizationStage).toBe(stage);
    expect(JSON.stringify(result.diagnostics)).not.toContain(content);
  });

  it("sends the DeepSeek thinking toggle with JSON output and records only safe token diagnostics", async () => {
    vi.stubEnv("AI_PROVIDER", "deepseek");
    openAiMocks.create.mockResolvedValueOnce({
      model: "deepseek-v4-flash",
      choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      usage: {
        completion_tokens: 42,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    });

    const result = await callAiJson<{ ok: boolean }>({
      messages: [{ role: "user", content: "return JSON" }],
      maxTokens: 6000,
      thinkingMode: "disabled",
    });

    expect(result.ok).toBe(true);
    expect(openAiMocks.create).toHaveBeenCalledTimes(1);
    expect(openAiMocks.create.mock.calls[0][0]).toMatchObject({
      max_tokens: 6000,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
    expect(result.diagnostics).toMatchObject({
      model: "deepseek-v4-flash",
      thinkingMode: "disabled",
      maxTokens: 6000,
      finishReason: "stop",
      completionTokens: 42,
      reasoningTokens: 0,
      responseCharLength: 11,
    });
  });

  it("records only the Provider HTTP status class when the SDK returns an error", async () => {
    openAiMocks.create.mockRejectedValueOnce(Object.assign(new Error("secret upstream body"), { status: 429 }));

    const result = await callAiJson({ messages: [{ role: "user", content: "test" }] });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toMatchObject({
      providerHttpStatusClass: "rate_limited",
      finishReason: null,
      responseCharLength: 0,
      jsonParseStage: "not_started",
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret upstream body");
  });

  it("does not mark or invoke the SDK when configuration fails first", async () => {
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    const result = await callAiText({ messages: [{ role: "user", content: "test" }] });

    expect(result.ok).toBe(false);
    expect(result.providerCallStarted).toBe(false);
    expect(openAiMocks.create).not.toHaveBeenCalled();
  });
});


describe("Provider allowlist", () => {
  it.each(["unknown", "fake", "azure", "deepseek-typo"])("refuses %s before the SDK", async (provider) => {
    vi.stubEnv("AI_PROVIDER", provider);
    expect(getAiConfig()).toMatchObject({ ok: false, error: { code: "unsupported_provider" } });
    expect(await callAiText({ messages: [{ role: "user", content: "must not call" }] })).toMatchObject({ ok: false, providerCallStarted: false, error: { code: "unsupported_provider" } });
    expect(openAiMocks.create).not.toHaveBeenCalled();
  });
  it("refuses unknown Provider even with a caller-supplied config", () => {
    expect(createAiClient({ ok: true, data: { provider: "unknown", apiKey: "test-only", maskedApiKey: "***", baseURL: "https://provider.invalid", timeoutMs: 1000, model: "test" } })).toMatchObject({ ok: false, error: { code: "unsupported_provider" } });
  });
});
