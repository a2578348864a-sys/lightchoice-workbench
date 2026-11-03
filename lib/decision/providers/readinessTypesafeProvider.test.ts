import { afterEach, describe, expect, it, vi } from "vitest";

import type { JevReadinessInput } from "@/lib/decision/readiness/types";
import { parseJevReadinessAdvice } from "@/lib/decision/readiness/schema";
import { TransportFailure } from "@/lib/decision/readiness/offlineProvider";
import {
  READINESS_REAL_PROTOCOL_STATUS,
  TypeSafeReadinessProvider,
  defaultMapReadinessResponse,
} from "@/lib/decision/providers/readinessTypesafeProvider";

function fixtureInput(overrides: Partial<JevReadinessInput> = {}): JevReadinessInput {
  return {
    schema: "jev-readiness-input.v1",
    taskId: "task-1",
    asin: "B0TEST0001",
    binding: { reportHash: "r1", factHash: "f1", evidenceHash: "e1", researchRevision: 3 },
    riskGateSummary: null,
    missingInformation: [],
    decisionSummary: null,
    verifiedNarratives: [],
    unverifiedNarratives: [],
    voc: null,
    vocRefResolution: { strategy: "externalContentId_to_observation_evidenceRefs", mappedThemeRefs: 0, unmappedRefs: [], downgradedThemes: [] },
    allowedEvidenceRefs: ["attachment:att-1"],
    fieldPresence: { bsr: "missing" },
    ...overrides,
  };
}

function okResponse(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

function validRequestBody(): Record<string, unknown> {
  return {
    state: { research: "verified source-backed facts only" },
    questions: {
      readiness: {
        type: "choice",
        instructions: "Classify the supplied research for human review.",
        criteria: {
          READY_FOR_HUMAN_REVIEW: "Enough verified evidence to proceed to human review.",
          NEED_MORE_EVIDENCE: "Material evidence is still missing.",
          HIGH_RISK: "The supplied evidence shows a material risk.",
        },
      },
    },
  };
}

function validSystemOneResponse(readiness = "READY_FOR_HUMAN_REVIEW"): Record<string, unknown> {
  return {
    model: "jev-1.0",
    answers: {
      readiness: {
        type: "choice",
        choice: readiness,
        confidence: 0.91,
        probabilities: { [readiness]: 0.91 },
      },
    },
    usage: { input_tokens: 42, output_tokens: 1 },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TypeSafeReadinessProvider（传输边界；协议 NOT_VERIFIED）", () => {
  it("未配置 Key：返回 unavailable 载荷，且不发起任何请求", async () => {
    const fetchImpl = vi.fn();
    const provider = new TypeSafeReadinessProvider({ apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    const input = fixtureInput();
    const raw = await provider.advise(input);
    const parsed = parseJevReadinessAdvice(raw, input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.advice.status).toBe("unavailable");
      expect(parsed.advice.readiness).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("未注入请求构造器（协议未校准）：返回 unavailable 并明确 PROTOCOL_UNVERIFIED，且不发起任何请求", async () => {
    const fetchImpl = vi.fn();
    const provider = new TypeSafeReadinessProvider({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const input = fixtureInput();
    const raw = await provider.advise(input);
    const parsed = parseJevReadinessAdvice(raw, input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.advice.status).toBe("unavailable");
      expect(parsed.advice.limitations.join(" ")).toContain(READINESS_REAL_PROTOCOL_STATUS);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("注入构造器 + 200 正常应答：映射结果通过 schema 严格校验（含绑定回填）", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse(validSystemOneResponse()));
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    const input = fixtureInput();
    const raw = await provider.advise(input);
    const parsed = parseJevReadinessAdvice(raw, input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.advice.status).toBe("available");
      expect(parsed.advice.readiness).toBe("READY_FOR_HUMAN_REVIEW");
      expect(parsed.advice.reviewQuestions).toHaveLength(0);
      expect(parsed.advice.inputBinding).toEqual(input.binding);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(provider.model).toBe("jev-1.0");
  });

  it("应答含禁止字段（score）：schema 层整份拒收（fail-closed，不降级为成功）", async () => {
    const fetchImpl = vi.fn(async () => okResponse(validSystemOneResponse()));
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
      mapResponseBody: (_body, input) => ({
        status: "available",
        readiness: "READY_FOR_HUMAN_REVIEW",
        reviewQuestions: [],
        contradictions: [],
        missingEvidence: [],
        limitations: [],
        score: 87,
        priority: "P1",
        inputBinding: { ...input.binding },
      }),
    });
    const input = fixtureInput();
    const raw = await provider.advise(input);
    const parsed = parseJevReadinessAdvice(raw, input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("FORBIDDEN_FIELD_PRESENT");
      expect(parsed.forbiddenFields.length).toBeGreaterThan(0);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429：抛 HTTP_429 且只发送一次请求（无重试）", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(429));
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "HTTP_429" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("500：抛 HTTP_500 且只发送一次请求", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(500));
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "HTTP_500" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("401/403：抛 HTTP_AUTH 且只发送一次请求", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(403));
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "HTTP_AUTH" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("超时（AbortError）：抛 ETIMEDOUT 且只发送一次请求", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "ETIMEDOUT" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("JSON 解析失败：抛 INVALID_JSON 且只发送一次请求", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("bad json"); },
    } as unknown as Response));
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "INVALID_JSON" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("网络异常：抛 NETWORK_ERROR 且只发送一次请求", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect refused"); });
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "NETWORK_ERROR" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("候选应答映射默认实现的绑定回填", () => {
    const input = fixtureInput();
    const mapped = defaultMapReadinessResponse(validSystemOneResponse("NEED_MORE_EVIDENCE"), input);
    const parsed = parseJevReadinessAdvice(mapped, input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.advice.readiness).toBe("NEED_MORE_EVIDENCE");
      expect(parsed.advice.inputBinding).toEqual(input.binding);
    }
  });

  it("拒绝缺少 OpenAPI v1 usage 的 200 响应", async () => {
    const fetchImpl = vi.fn(async () => okResponse({
      model: "jev-1.0",
      answers: { readiness: { type: "choice", choice: "HIGH_RISK" } },
    }));
    const provider = new TypeSafeReadinessProvider({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, buildRequestBody: validRequestBody });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "INVALID_RESPONSE" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("只接受 OpenAPI v1 文档中的 HTTP 200 成功响应", async () => {
    const fetchImpl = vi.fn(async () => okResponse(validSystemOneResponse(), 201));
    const provider = new TypeSafeReadinessProvider({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, buildRequestBody: validRequestBody });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "UNEXPECTED_HTTP_STATUS" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("拒绝非官方域名 / 错误 API 版本并且不发送带 Key 的请求", async () => {
    const fetchImpl = vi.fn();
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      baseUrl: "https://example.invalid/v2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: validRequestBody,
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "INVALID_API_BASE_URL" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("拒绝空 questions 请求且不发送带 Key 的请求", async () => {
    const fetchImpl = vi.fn();
    const provider = new TypeSafeReadinessProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildRequestBody: () => ({ state: "s", questions: {} }),
    });
    await expect(provider.advise(fixtureInput())).rejects.toMatchObject({ code: "INVALID_REQUEST" } satisfies Partial<TransportFailure>);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
