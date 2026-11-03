import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { callAiText } from "../aiClient";
import { CHAIN_OUTPUT_CAP_TOKENS, createBatchRequestGate } from "./batchInputBudget";
import {
  P5_BATCH_BUDGET_CNY,
  P5_BATCH_CASES,
  P5_BATCH_REAL_MODE_ALLOWED,
  P5BatchAuthorizationError,
  assertBatchRunAuthorized,
  defaultBatchGateConfig,
  runP5BatchWithNewGate,
  runRealModelBatch,
  type P5BatchCaseDefinition,
  type P5BatchCaseInvoker,
} from "./realModelBatchRunner";

/**
 * 九例执行器的本地替身闭环。
 *
 * 这里刻意**不 mock `callAiText`**：请求真的经过 OpenAI SDK → 本机 loopback 替身，
 * 因此被验证的是「闸挂在真实出站边界上」这件事本身，而不是某个包装函数。
 */

type StubReply = { status: number; body: unknown; delayMs?: number };

let server: Server;
let baseUrl = "";
let reply: (body: Record<string, unknown>) => StubReply = () => defaultOkReply();
const received: Array<Record<string, unknown>> = [];

function defaultOkReply(): StubReply {
  return {
    status: 200,
    body: {
      id: "chatcmpl-stub",
      object: "chat.completion",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5_000, completion_tokens: 500, total_tokens: 5_500 },
    },
  };
}

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_TIMEOUT_MS",
  "AI_RESEARCH_MAX_TOKENS",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      received.push(body);
      const value = reply(body);
      const send = () => {
        response.writeHead(value.status, { "content-type": "application/json" });
        response.end(JSON.stringify(value.body));
      };
      if (value.delayMs) setTimeout(send, value.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.AI_PROVIDER = "deepseek";
  process.env.AI_API_KEY = "stub-key";
  process.env.AI_BASE_URL = baseUrl;
  process.env.AI_MODEL = "deepseek-flash";
  process.env.AI_TIMEOUT_MS = "45000";
  delete process.env.AI_RESEARCH_MAX_TOKENS;
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  received.length = 0;
  reply = () => defaultOkReply();
  process.env.AI_TIMEOUT_MS = "45000";
});

/** 生产形状的调用：同样的 messages 结构、同样的 maxTokens、走真实 callAiText。 */
function productionShapedInvoker(overrides: { maxTokens?: number; padding?: number } = {}): P5BatchCaseInvoker {
  return async (definition: P5BatchCaseDefinition) => {
    const evidenceBlock = "证据占位 ".repeat(overrides.padding ?? 600);
    const result = await callAiText({
      messages: [
        { role: "system", content: `P5 case ${definition.id} chain=${definition.chain} ${definition.purpose}` },
        { role: "user", content: `taskId=${definition.taskId} asin=${definition.asin}\n${evidenceBlock}` },
      ],
      maxTokens: overrides.maxTokens ?? CHAIN_OUTPUT_CAP_TOKENS[definition.chain],
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });
    return {
      ok: result.ok,
      errorCode: result.ok ? null : result.error.code,
      detail: result.ok ? null : result.error.detail ?? null,
    };
  };
}

async function runBatch(options: {
  invoke?: P5BatchCaseInvoker;
  gateConfig?: Parameters<typeof defaultBatchGateConfig>[0];
  cases?: readonly P5BatchCaseDefinition[];
} = {}) {
  return runRealModelBatch({
    mode: "stub",
    gate: createBatchRequestGate(defaultBatchGateConfig(options.gateConfig)),
    invoke: options.invoke ?? productionShapedInvoker(),
    cases: options.cases,
  });
}

describe("P5 九例执行器：运行授权与环境一致性", () => {
  const baseEnv = {
    AI_PROVIDER: "deepseek",
    AI_MODEL: "deepseek-flash",
    AI_BASE_URL: "http://127.0.0.1:1234",
  };

  it("未显式声明模式时拒绝运行（不允许默认值把真实调用跑起来）", () => {
    expect(() => assertBatchRunAuthorized({ mode: undefined, env: baseEnv }))
      .toThrow(P5BatchAuthorizationError);
    try {
      assertBatchRunAuthorized({ mode: "", env: baseEnv });
    } catch (error) {
      expect((error as P5BatchAuthorizationError).code).toBe("P5_BATCH_MODE_INVALID");
    }
  });

  it("stub 模式必须指向本机替身，否则拒绝（防止以为在跑替身其实在花钱）", () => {
    try {
      assertBatchRunAuthorized({ mode: "stub", env: { ...baseEnv, AI_BASE_URL: "https://api.deepseek.com" } });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as P5BatchAuthorizationError).code).toBe("P5_BATCH_STUB_REQUIRES_LOOPBACK");
    }
    expect(assertBatchRunAuthorized({ mode: "stub", env: baseEnv })).toEqual({ mode: "stub" });
  });

  it("环境与执行表不一致时，发送前拒绝并逐项列出", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ AI_PROVIDER: "openai" }, "AI_PROVIDER"],
      [{ AI_MODEL: "deepseek-chat" }, "AI_MODEL"],
      [{ AI_TIMEOUT_MS: "30000" }, "AI_TIMEOUT_MS"],
      [{ AI_RESEARCH_MAX_TOKENS: "4000" }, "AI_RESEARCH_MAX_TOKENS"],
    ];
    for (const [override, expected] of cases) {
      try {
        assertBatchRunAuthorized({ mode: "stub", env: { ...baseEnv, ...override } });
        throw new Error(`should have thrown for ${expected}`);
      } catch (error) {
        const authorizationError = error as P5BatchAuthorizationError;
        expect(authorizationError.code).toBe("P5_BATCH_ENV_MISMATCH");
        expect(authorizationError.message).toContain(expected);
      }
    }
  });

  it("预算被改动同样拒绝（本轮硬停止线固定 8 元）", () => {
    try {
      assertBatchRunAuthorized({ mode: "stub", env: baseEnv, budgetCny: 50 });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as P5BatchAuthorizationError).code).toBe("P5_BATCH_ENV_MISMATCH");
      expect((error as P5BatchAuthorizationError).message).toContain(`预算必须为 ${P5_BATCH_BUDGET_CNY} 元`);
    }
  });

  it("real 模式缺少任一授权项都拒绝，并列出全部缺失项", () => {
    try {
      assertBatchRunAuthorized({ mode: "real", env: { ...baseEnv, AI_BASE_URL: "https://api.deepseek.com" } });
      throw new Error("should have thrown");
    } catch (error) {
      const authorizationError = error as P5BatchAuthorizationError;
      expect(authorizationError.code).toBe("P5_BATCH_NOT_AUTHORIZED");
      expect(authorizationError.message).toContain("P5_BATCH_ALLOW_REAL=1");
      expect(authorizationError.message).toContain("P5_BATCH_CONFIRM=real-model-spend");
      expect(authorizationError.message).toContain(`P5_BATCH_BUDGET_CNY=${P5_BATCH_BUDGET_CNY}`);
    }
  });

  it("real 模式集齐三重确认后放行（本轮已授权），缺任一项仍拒绝", () => {
    const env = {
      ...baseEnv,
      AI_BASE_URL: "https://api.deepseek.com",
      P5_BATCH_ALLOW_REAL: "1",
      P5_BATCH_CONFIRM: "real-model-spend",
      P5_BATCH_BUDGET_CNY: String(P5_BATCH_BUDGET_CNY),
    };
    expect(P5_BATCH_REAL_MODE_ALLOWED).toBe(true);
    expect(assertBatchRunAuthorized({ mode: "real", env })).toEqual({ mode: "real" });

    for (const key of ["P5_BATCH_ALLOW_REAL", "P5_BATCH_CONFIRM", "P5_BATCH_BUDGET_CNY"] as const) {
      const broken = { ...env } as Record<string, string>;
      delete broken[key];
      try {
        assertBatchRunAuthorized({ mode: "real", env: broken });
        throw new Error(`should have thrown for ${key}`);
      } catch (error) {
        expect((error as P5BatchAuthorizationError).code).toBe("P5_BATCH_NOT_AUTHORIZED");
      }
    }
  });
});

describe("P5 九例执行器：替身闭环", () => {
  it("正常九例：九个请求、九条记录、对账恒等式成立", async () => {
    const result = await runP5BatchWithNewGate({
      mode: "stub",
      env: { ...process.env, AI_BASE_URL: baseUrl },
      invoke: productionShapedInvoker(),
    });

    expect(result.results).toHaveLength(9);
    expect(result.results.every((item) => item.outcome === "ok")).toBe(true);
    expect(received).toHaveLength(9);

    const reconciliation = result.reconciliation;
    expect(reconciliation.settled).toBe(9);
    expect(reconciliation.records).toBe(9);
    expect(reconciliation.requests).toBe(9);
    expect(reconciliation.notRun).toBe(0);
    expect(reconciliation.blockedBeforeSend).toBe(0);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.costUnknownCount).toBe(0);
    expect(reconciliation.spentCny).toBeGreaterThan(0);
    expect(reconciliation.spentCny).toBeLessThan(P5_BATCH_BUDGET_CNY);
    expect(reconciliation.promptTokens).toBe(9 * 5_000);
    expect(reconciliation.completionTokens).toBe(9 * 500);
    expect(result.stopped).toBeNull();

    // 每条请求带的输出上限必须是该链路的真实上限
    const expectedCaps = P5_BATCH_CASES.map((item) => CHAIN_OUTPUT_CAP_TOKENS[item.chain]);
    expect(received.map((body) => body.max_tokens)).toEqual(expectedCaps);
    expect(received.every((body) => body.model === "deepseek-flash")).toBe(true);
  });

  it("费用按实际 usage 复算：单例费用 = prompt×0.3 + completion×1.2", async () => {
    const result = await runBatch({ cases: P5_BATCH_CASES.slice(0, 1) });
    const record = result.gate.records[0];
    const expectedCny = ((5_000 * 0.3 + 500 * 1.2) / 1_000_000) * 7.1;
    expect(record.costCny).toBeCloseTo(expectedCny, 12);
    expect(result.reconciliation.spentCny).toBeCloseTo(expectedCny, 12);
  });

  it("禁止并发绕闸：同一例内并发两次调用，第二次必须被闸拒绝", async () => {
    const invoker: P5BatchCaseInvoker = async (definition) => {
      const call = () => callAiText({
        messages: [
          { role: "system", content: `concurrency ${definition.id}` },
          { role: "user", content: "证据占位 ".repeat(600) },
        ],
        maxTokens: CHAIN_OUTPUT_CAP_TOKENS[definition.chain],
        responseFormat: { type: "json_object" },
      });
      const [first, second] = await Promise.all([call(), call()]);
      return {
        ok: first.ok && second.ok,
        errorCode: second.ok ? null : second.error.code,
        detail: second.ok ? null : second.error.detail ?? null,
      };
    };

    const result = await runBatch({ invoke: invoker, cases: P5_BATCH_CASES.slice(0, 1) });
    expect(received).toHaveLength(1);
    expect(result.gate.requests).toBe(1);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].errorCode).toBe("batch_gate_blocked");
    expect(result.results[0].detail).toContain("REQUEST_IN_FLIGHT");
    expect(result.reconciliation.consistent).toBe(true);
  });

  it("超请求数：达到上限后不再签发，且不产生额外 HTTP", async () => {
    const result = await runBatch({ gateConfig: { maxRequests: 3 } });
    expect(received).toHaveLength(3);
    expect(result.results.filter((item) => item.outcome === "ok")).toHaveLength(3);
    expect(result.results.filter((item) => item.outcome === "error_before_send")).toHaveLength(6);
    expect(result.results[3].detail).toContain("REQUEST_CAP_REACHED");
    expect(result.reconciliation.consistent).toBe(true);
    expect(result.reconciliation.records).toBe(3);
  });

  it("上界被突破（预检与真实用量不一致）：立即停批，剩余样例不发请求", async () => {
    reply = () => ({
      status: 200,
      body: {
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 1,
        model: "deepseek-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 999_999, completion_tokens: 10, total_tokens: 1_000_009 },
      },
    });

    const result = await runBatch();
    expect(received).toHaveLength(1);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].errorCode).toBe("batch_gate_violation");
    expect(result.stopped?.code).toBe("TOKEN_BOUND_VIOLATED");
    expect(result.results.slice(1).every((item) => item.outcome === "not_run")).toBe(true);
    expect(result.reconciliation.consistent).toBe(true);
    expect(result.reconciliation.spentCny).toBeGreaterThan(0); // 判停也要把已发生费用记上
  });

  it("模型不符：停批且费用记为未知（不按批次模型价格硬套）", async () => {
    reply = () => {
      const base = defaultOkReply();
      return { ...base, body: { ...(base.body as Record<string, unknown>), model: "deepseek-chat" } };
    };

    const result = await runBatch();
    expect(received).toHaveLength(1);
    expect(result.stopped?.code).toBe("MODEL_MISMATCH");
    expect(result.gate.records[0].modelMismatch).toBe(true);
    expect(result.gate.records[0].costCny).toBeNull();
    expect(result.reconciliation.costUnknownCount).toBe(1);
    expect(result.reconciliation.spentCny).toBe(0);
    expect(result.results.slice(1).every((item) => item.outcome === "not_run")).toBe(true);
  });

  it("缺 usage：请求成功但无法核算 → 停批", async () => {
    reply = () => {
      const base = defaultOkReply();
      const body = { ...(base.body as Record<string, unknown>) };
      delete body.usage;
      return { ...base, body };
    };

    const result = await runBatch();
    expect(received).toHaveLength(1);
    expect(result.stopped?.code).toBe("USAGE_UNAVAILABLE");
    expect(result.reconciliation.costUnknownCount).toBe(1);
    expect(result.results.slice(1).every((item) => item.outcome === "not_run")).toBe(true);
  });

  it("非 2xx：该例记失败不重试；连续 2 例失败才整批停（与 §6.3 一致）", async () => {
    reply = () => ({ status: 500, body: { error: { message: "internal server error", type: "server_error" } } });

    const result = await runBatch();
    expect(received).toHaveLength(2);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[1].outcome).toBe("failed");
    expect(result.results[0].errorCode).toBe("provider_unavailable");
    expect(result.gate.records[0].httpStatusClass).toBe("server_error");
    expect(result.gate.records[0].httpStatus).toBe(500);
    expect(result.stopped?.code).toBe("CONSECUTIVE_FAILURES");
    expect(result.reconciliation.costUnknownCount).toBe(2);
    expect(result.results.slice(2).every((item) => item.outcome === "not_run")).toBe(true);
  });

  it("鉴权失败：401 连发两例后整批停，不重试同一例", async () => {
    reply = () => ({ status: 401, body: { error: { message: "invalid api key", type: "authentication_error" } } });

    const result = await runBatch();
    expect(received).toHaveLength(2);
    expect(result.results[0].errorCode).toBe("invalid_api_key");
    expect(result.gate.records[0].httpStatusClass).toBe("client_error");
    expect(result.results.slice(2).every((item) => item.outcome === "not_run")).toBe(true);
  });

  it("超时：按 timeout 记失败，连续 2 例后停批", async () => {
    process.env.AI_TIMEOUT_MS = "200";
    reply = () => {
      const base = defaultOkReply();
      return { ...base, delayMs: 1_000 };
    };

    const result = await runBatch();
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].errorCode).toBe("timeout");
    expect(result.gate.records[0].httpStatusClass).toBe("timeout");
    expect(result.results.slice(2).every((item) => item.outcome === "not_run")).toBe(true);
  });

  it("预算不足：发送前全部拒绝，替身一个请求都收不到", async () => {
    const result = await runBatch({ gateConfig: { budgetCny: 0.000001 } });
    expect(received).toHaveLength(0);
    expect(result.results.every((item) => item.outcome === "error_before_send")).toBe(true);
    expect(result.results[0].errorCode).toBe("batch_gate_blocked");
    expect(result.results[0].detail).toContain("BUDGET_EXCEEDED");
    expect(result.gate.requests).toBe(0);
    expect(result.gate.records).toHaveLength(0);
    expect(result.reconciliation.consistent).toBe(true);
  });

  it("输入超上限：发送前拒绝，替身收不到请求", async () => {
    const hugeInvoker: P5BatchCaseInvoker = async (definition) => {
      const result = await callAiText({
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "水".repeat(50_000) },
        ],
        maxTokens: CHAIN_OUTPUT_CAP_TOKENS[definition.chain],
      });
      return { ok: result.ok, errorCode: result.ok ? null : result.error.code, detail: result.ok ? null : result.error.detail ?? null };
    };

    const result = await runBatch({ invoke: hugeInvoker, cases: P5_BATCH_CASES.slice(0, 1) });
    expect(received).toHaveLength(0);
    expect(result.results[0].outcome).toBe("error_before_send");
    expect(result.results[0].detail).toContain("INPUT_CAP_EXCEEDED");
  });

  it("输出上限与链路不符：拒绝签发，不发请求", async () => {
    const result = await runBatch({
      invoke: productionShapedInvoker({ maxTokens: CHAIN_OUTPUT_CAP_TOKENS.v5 }),
      cases: P5_BATCH_CASES.filter((item) => item.chain === "v1").slice(0, 1),
    });
    expect(received).toHaveLength(0);
    expect(result.results[0].outcome).toBe("error_before_send");
    expect(result.results[0].detail).toContain("OUTPUT_CAP_MISMATCH");
  });

  it("停止之后不再有任何请求：停批后剩余样例的调用函数根本不会被调用", async () => {
    let invocations = 0;
    const countingInvoker: P5BatchCaseInvoker = async (definition) => {
      invocations += 1;
      return productionShapedInvoker()(definition);
    };
    reply = () => ({ status: 503, body: { error: { message: "service unavailable" } } });

    const result = await runBatch({ invoke: countingInvoker });
    expect(invocations).toBe(2);
    expect(received).toHaveLength(2);
    expect(result.stopped?.code).toBe("CONSECUTIVE_FAILURES");
    expect(result.results.slice(2).every((item) => item.outcome === "not_run")).toBe(true);
    expect(result.reconciliation.notRun).toBe(7);
  });
});

describe("P5 九例执行器：请求状态不明的处理", () => {
  it("请求已发出但未结算：记 unsettled + 费用未知，永久停批且对账不得为 consistent", async () => {
    reply = () => ({ ...defaultOkReply(), delayMs: 300 });

    const invoker: P5BatchCaseInvoker = async (definition) => {
      // 发出请求但不等待结算：模拟「请求已发出、结算前被中断」。
      const pending = callAiText({
        messages: [
          { role: "system", content: `unsettled ${definition.id}` },
          { role: "user", content: "证据占位 ".repeat(600) },
        ],
        maxTokens: CHAIN_OUTPUT_CAP_TOKENS[definition.chain],
      }).catch(() => null);
      void pending;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: false, errorCode: "CASE_ABORTED", detail: "调用方在结算前中断。" };
    };

    const result = await runBatch({ invoke: invoker, cases: P5_BATCH_CASES.slice(0, 3) });

    expect(result.results[0].outcome).toBe("unsettled");
    expect(result.results[0].record?.settled).toBe(false);
    expect(result.results[0].record?.costUnknown).toBe(true);
    expect(result.results[0].record?.costCny).toBeNull();
    expect(result.results[0].record?.promptTokens).toBeNull();
    expect(result.results[0].record?.stopCode).toBe("REQUEST_UNSETTLED");
    expect(result.stopped?.code).toBe("REQUEST_UNSETTLED");

    expect(result.reconciliation.unsettled).toBe(1);
    expect(result.reconciliation.requests).toBe(0);
    expect(result.reconciliation.inFlight).toBe(false);
    expect(result.reconciliation.consistent).toBe(false);

    expect(result.results.slice(1).every((item) => item.outcome === "not_run")).toBe(true);
    // 未结算的请求不会因为迟到的响应变成「已结算」。
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(result.gate.records.filter((record) => record.settled)).toHaveLength(0);
  });

  it("一例内出现两次请求：判违约、强制停批、后续样例不发请求", async () => {
    const invoker: P5BatchCaseInvoker = async (definition) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await callAiText({
          messages: [
            { role: "system", content: `double ${definition.id} ${attempt}` },
            { role: "user", content: "证据占位 ".repeat(600) },
          ],
          maxTokens: CHAIN_OUTPUT_CAP_TOKENS[definition.chain],
        });
      }
      return { ok: true, errorCode: null };
    };

    const result = await runBatch({ invoke: invoker, cases: P5_BATCH_CASES.slice(0, 2) });
    expect(received).toHaveLength(2);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].errorCode).toBe("MULTIPLE_REQUESTS_FOR_CASE");
    expect(result.stopped?.code).toBe("CASE_MULTIPLE_REQUESTS");
    expect(result.results[1].outcome).toBe("not_run");
    expect(result.reconciliation.consistent).toBe(false);
  });

  it("调用抛错但闸从未签发：仍可证未发出（error_before_send）", async () => {
    const invoker: P5BatchCaseInvoker = async () => {
      throw new Error("candidate binding missing");
    };
    const result = await runBatch({ invoke: invoker, cases: P5_BATCH_CASES.slice(0, 1) });
    expect(received).toHaveLength(0);
    expect(result.results[0].outcome).toBe("error_before_send");
    expect(result.results[0].errorCode).toBe("CASE_THREW");
    expect(result.results[0].record).toBeNull();
    expect(result.reconciliation.consistent).toBe(true);
  });
});
