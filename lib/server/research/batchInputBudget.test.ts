import { describe, expect, it } from "vitest";
import {
  CHAT_TEMPLATE_EXTRA_TOKENS,
  CHAIN_OUTPUT_CAP_TOKENS,
  TOKEN_BOUND_ALLOWANCE,
  TOKEN_BOUND_PROOF,
  createBatchRequestGate,
  countUtf8Bytes,
  estimateTokenUpperBound,
  messagesDigest,
  preflightBatchInput,
  provenMessageShape,
  requestFingerprint,
  validateSettledUsage,
  verifyUsageAgainstBound,
  type AuthorizeInput,
  type SettleInput,
} from "./batchInputBudget";

const CAPS = { inputCapTokens: 20_000, outputCapTokens: 2_400 } as const;

describe("P5 批次输入预算：字节上界与预检", () => {
  it("上界依据必须是「字节级 BPE + 256 字节符号齐全」这类结构性证据", () => {
    expect(TOKEN_BOUND_PROOF.proven).toBe(true);
    expect(TOKEN_BOUND_PROOF.boundKind).toBe("utf8_bytes_plus_allowance");
    expect(TOKEN_BOUND_PROOF.evidence).toContain("ByteLevel");
    expect(TOKEN_BOUND_PROOF.evidence).toContain("256/256");
  });

  it("中文 / 英文 / Emoji / 特殊字符：字节上界必须 ≥ 字符数且按 UTF-8 计算", () => {
    const cases = [
      { text: "漏水可能来自密封圈装配误差。", minBytes: 42 },
      { text: "seal ring tolerance", minBytes: 19 },
      { text: "👍🏽 漏水 ⚠️", minBytes: 4 },
      { text: "<｜begin▁of▁sentence｜>{\"a\":1}\n\t", minBytes: 10 },
    ];
    for (const item of cases) {
      const bytes = countUtf8Bytes(item.text);
      expect(bytes).toBeGreaterThanOrEqual(item.minBytes);
      expect(bytes).toBeGreaterThanOrEqual(item.text.length); // 字节数 ≥ UTF-16 字符数
      expect(estimateTokenUpperBound(item.text).tokenUpperBound).toBe(bytes + TOKEN_BOUND_ALLOWANCE);
    }
    // Emoji 是 4 字节，必须按字节而不是按「1 个字符」算
    expect(countUtf8Bytes("👍")).toBe(4);
    expect(countUtf8Bytes("👍🏽")).toBe(8);
  });

  it("边界：恰好等于单请求上限放行，超出 1 字节即拒绝", () => {
    const budget = CAPS.inputCapTokens - TOKEN_BOUND_ALLOWANCE;
    const exact = "a".repeat(budget);
    const allowed = preflightBatchInput({ system: "", user: exact, ...CAPS });
    expect(allowed.decision).toBe("allow");
    expect(allowed.tokenUpperBound).toBe(CAPS.inputCapTokens);

    const over = preflightBatchInput({ system: "", user: `${exact}a`, ...CAPS });
    expect(over.decision).toBe("block");
    if (over.decision === "block") expect(over.code).toBe("INPUT_CAP_EXCEEDED");
  });

  it("中文按字节更早触顶：字符数没超但字节数超，也必须拒绝", () => {
    // 6,700 个中文字符 = 20,100 字节 > 19,984（上限 - 余量），字符数却只有 6,700
    const text = "水".repeat(6_700);
    const result = preflightBatchInput({ system: "", user: text, ...CAPS });
    expect(result.decision).toBe("block");
    if (result.decision === "block") {
      expect(result.code).toBe("INPUT_CAP_EXCEEDED");
      expect(result.utf8Bytes).toBe(20_100);
    }
  });

  it("费用预检：超预算即拒绝，未超时给出可复算的美元/人民币估算", () => {
    const small = preflightBatchInput({ system: "s", user: "u", ...CAPS, budgetCny: 5, cnyPerUsd: 7.1 });
    expect(small.decision).toBe("allow");
    if (small.decision === "allow") {
      const expectedUsd = (small.tokenUpperBound * 0.3 + CAPS.outputCapTokens * 1.2) / 1_000_000;
      expect(small.estimatedCostUsd).toBeCloseTo(expectedUsd, 10);
      expect(small.estimatedCostCny).toBeCloseTo(expectedUsd * 7.1, 10);
    }

    const broke = preflightBatchInput({ system: "s", user: "u", ...CAPS, budgetCny: 0.000001, cnyPerUsd: 7.1 });
    expect(broke.decision).toBe("block");
    if (broke.decision === "block") expect(broke.code).toBe("BUDGET_EXCEEDED");
  });

  it("上限非法（0 / 负数 / NaN）一律拒绝，不猜默认值", () => {
    for (const bad of [0, -1, Number.NaN]) {
      const result = preflightBatchInput({ system: "s", user: "u", inputCapTokens: bad, outputCapTokens: 2400 });
      expect(result.decision).toBe("block");
      if (result.decision === "block") expect(result.code).toBe("INVALID_CAP");
    }
  });

  it("发送后复核：usage 缺失 / 越界必须失败，正常值通过", () => {
    expect(verifyUsageAgainstBound({ promptTokens: 1234, tokenUpperBound: 2000 })).toEqual({ ok: true, promptTokens: 1234, tokenUpperBound: 2000 });

    const missing = verifyUsageAgainstBound({ promptTokens: null, tokenUpperBound: 2000 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("USAGE_UNAVAILABLE");

    const malformed = verifyUsageAgainstBound({ promptTokens: -3, tokenUpperBound: 2000 });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe("USAGE_UNAVAILABLE");

    const violated = verifyUsageAgainstBound({ promptTokens: 2001, tokenUpperBound: 2000 });
    expect(violated.ok).toBe(false);
    if (!violated.ok) expect(violated.code).toBe("TOKEN_BOUND_VIOLATED");
  });
});

const BASE_CONFIG = {
  model: "deepseek-flash" as const,
  inputCapTokens: 20_000,
  budgetCny: 5,
  cnyPerUsd: 7.1,
  maxRequests: 9,
  maxConsecutiveFailures: 2,
} as const;

// 用户消息留 1,000 字节，使上界（≈1,030）足够容纳后面用到的 promptTokens 取值。
const MESSAGES = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "a".repeat(1_000) },
] as const;

function authorizeInput(overrides: Partial<AuthorizeInput> = {}): AuthorizeInput {
  return {
    chain: "v1",
    model: "deepseek-flash",
    messages: MESSAGES,
    maxTokens: CHAIN_OUTPUT_CAP_TOKENS.v1,
    temperature: 0.2,
    responseFormat: null,
    timeoutMs: 45_000,
    ...overrides,
  };
}

function settleInput(
  authorized: { readonly ticket: string; readonly fingerprint: string },
  overrides: Partial<SettleInput> = {},
): SettleInput {
  return {
    ticket: authorized.ticket,
    fingerprint: authorized.fingerprint,
    actualModel: "deepseek-flash",
    requestedModel: "deepseek-flash",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    httpStatusClass: "success",
    httpStatus: null,
    elapsedMs: 1_000,
    ok: true,
    errorCode: null,
    ...overrides,
  };
}

describe("P5 批次发送闸：绑定实际请求、单飞、记账与停止", () => {
  it("模板余量必须覆盖已证明的模板开销，并留出未证明部分的余量", () => {
    expect(CHAT_TEMPLATE_EXTRA_TOKENS).toBe(3);
    expect(TOKEN_BOUND_ALLOWANCE).toBeGreaterThanOrEqual(CHAT_TEMPLATE_EXTRA_TOKENS);
    // 3 个模板 token 之外仍有余量留给服务端格式（未证明，靠 usage 反证）
    expect(TOKEN_BOUND_ALLOWANCE - CHAT_TEMPLATE_EXTRA_TOKENS).toBeGreaterThanOrEqual(8);
  });

  it("两条链路的输出上限必须分开：V1=12000 / V5=2000，写错即拒发", () => {
    expect(CHAIN_OUTPUT_CAP_TOKENS.v1).toBe(12_000);
    expect(CHAIN_OUTPUT_CAP_TOKENS.v5).toBe(2_000);

    const gate = createBatchRequestGate(BASE_CONFIG);
    const wrongV1 = gate.authorize(authorizeInput({ chain: "v1", maxTokens: 2_000 }));
    expect(wrongV1.ok).toBe(false);
    if (!wrongV1.ok) expect(wrongV1.code).toBe("OUTPUT_CAP_MISMATCH");

    const wrongV5 = gate.authorize(authorizeInput({ chain: "v5", maxTokens: 12_000 }));
    expect(wrongV5.ok).toBe(false);
    if (!wrongV5.ok) expect(wrongV5.code).toBe("OUTPUT_CAP_MISMATCH");

    expect(gate.authorize(authorizeInput({ chain: "v5", maxTokens: 2_000 })).ok).toBe(true);
    expect(gate.state().requests).toBe(0); // 只有结算才算一次请求
  });

  it("正常一例：先发票据再记账，费用按实际 usage 复算，指纹与消息摘要落记录", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const input = authorizeInput();
    const authorized = gate.authorize(input);
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(gate.state().inFlight).toBe(true);

    const settled = gate.settle(settleInput(authorized, { promptTokens: 100, completionTokens: 50 }));
    expect(settled.ok).toBe(true);
    expect(settled.code).toBeNull();

    const expectedCny = ((100 * 0.3 + 50 * 1.2) / 1_000_000) * 7.1;
    const state = gate.state();
    expect(state.spentCny).toBeCloseTo(expectedCny, 12);
    expect(state.requests).toBe(1);
    expect(state.stopped).toBeNull();
    expect(state.inFlight).toBe(false);
    expect(state.records).toHaveLength(1);

    const record = state.records[0];
    expect(record.fingerprint).toBe(authorized.fingerprint);
    expect(record.messagesDigest).toBe(messagesDigest(input.messages));
    expect(record.inputUpperBound).toBe(authorized.tokenUpperBound);
    expect(record.costUnknown).toBe(false);
    expect(record.costCny).toBeCloseTo(expectedCny, 12);
  });

  it("票据绑定实际请求：换掉 messages / 采样参数后结算必须判违约并关闸", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");

    const tampered = gate.settle(settleInput(authorized, {
      fingerprint: "0".repeat(64),
    }));
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.code).toBe("REQUEST_FINGERPRINT_MISMATCH");
    expect(gate.state().stopped?.code).toBe("REQUEST_FINGERPRINT_MISMATCH");
    expect(gate.authorize(authorizeInput()).ok).toBe(false);
  });

  it("单飞：上一张票据未结算时，任何新请求都不得签发", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const first = gate.authorize(authorizeInput());
    expect(first.ok).toBe(true);

    const second = gate.authorize(authorizeInput());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("REQUEST_IN_FLIGHT");
    expect(gate.state().requests).toBe(0);

    if (!first.ok) return;
    expect(gate.settle(settleInput(first)).ok).toBe(true);
    expect(gate.authorize(authorizeInput()).ok).toBe(true);
  });

  it("票据一次性：重复结算与伪造票据都被拒", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");
    expect(gate.settle(settleInput(authorized)).ok).toBe(true);

    const again = gate.settle(settleInput(authorized));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("INVALID_TICKET");

    const forged = gate.settle(settleInput({ ticket: "bt_forged", fingerprint: "x" }));
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("INVALID_TICKET");
  });

  it("票据过期结算：判违约并关闸（防止长期挂起绕过预算）", async () => {
    const gate = createBatchRequestGate({ ...BASE_CONFIG, ticketTtlMs: 1 });
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const settled = gate.settle(settleInput(authorized));
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.code).toBe("TICKET_EXPIRED");
  });

  it("输入超上限：发送前直接拒绝，不发票据也不计请求", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const tooBig = "水".repeat(7_000); // 21,000 字节
    const result = gate.authorize(authorizeInput({
      messages: [{ role: "system", content: "" }, { role: "user", content: tooBig }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INPUT_CAP_EXCEEDED");
    expect(gate.state().requests).toBe(0);
    expect(gate.state().inFlight).toBe(false);
  });

  it("模型不符：立即关闸，后续请求全部拒绝，且费用记为未知而不是 0", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");

    const settled = gate.settle(settleInput(authorized, {
      actualModel: "deepseek-chat",
      requestedModel: "deepseek-flash",
    }));
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.code).toBe("MODEL_MISMATCH");

    const record = gate.state().records[0];
    expect(record.modelMismatch).toBe(true);
    expect(record.costCny).toBeNull();
    expect(record.costUnknown).toBe(true);

    const next = gate.authorize(authorizeInput());
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.code).toBe("BATCH_STOPPED");
    expect(gate.state().stopped?.code).toBe("MODEL_MISMATCH");
  });

  it("请求成功但缺 usage：判违约关闸（无法复核上界、无法核算费用）", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");
    const settled = gate.settle(settleInput(authorized, { promptTokens: null, completionTokens: null, totalTokens: null }));
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.code).toBe("USAGE_UNAVAILABLE");
    expect(gate.state().records[0].costUnknown).toBe(true);
  });

  it("请求本身失败且无 usage：不误标 USAGE_UNAVAILABLE，费用记为未知，由失败计数停批", () => {
    const gate = createBatchRequestGate({ ...BASE_CONFIG, maxConsecutiveFailures: 1 });
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");
    const settled = gate.settle(settleInput(authorized, {
      ok: false,
      errorCode: "timeout",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      httpStatusClass: "timeout",
    }));
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.code).toBe("CONSECUTIVE_FAILURES");
    const record = gate.state().records[0];
    expect(record.costUnknown).toBe(true);
    expect(record.httpStatusClass).toBe("timeout");
    expect(record.errorCode).toBe("timeout");
  });

  it("先记账后判停：判停的请求仍必须留下可复算的费用", () => {
    const overOutput = createBatchRequestGate(BASE_CONFIG);
    const t1 = overOutput.authorize(authorizeInput());
    if (!t1.ok) throw new Error("authorize failed");
    const r1 = overOutput.settle(settleInput(t1, { promptTokens: 900, completionTokens: 12_001, totalTokens: 12_901 }));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("OUTPUT_CAP_EXCEEDED");
    expect(overOutput.state().records[0].costCny).toBeCloseTo(((900 * 0.3 + 12_001 * 1.2) / 1_000_000) * 7.1, 12);
    expect(overOutput.state().spentCny).toBeGreaterThan(0);

    const overInput = createBatchRequestGate(BASE_CONFIG);
    const t2 = overInput.authorize(authorizeInput());
    if (!t2.ok) throw new Error("authorize failed");
    const violatedPrompt = t2.tokenUpperBound + 1;
    const r2 = overInput.settle(settleInput(t2, {
      promptTokens: violatedPrompt,
      completionTokens: 50,
      totalTokens: violatedPrompt + 50,
    }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("TOKEN_BOUND_VIOLATED");
    expect(overInput.state().records[0].promptTokens).toBe(violatedPrompt);
    expect(overInput.state().spentCny).toBeGreaterThan(0);
  });

  it("预算：单例预估超预算即拒发；累计花费计入下一次预检", () => {
    const bigText = "a".repeat(10_000); // 10,000 字节 → 上界 10,016
    const bigMessages = [
      { role: "system", content: "" },
      { role: "user", content: bigText },
    ] as const;

    // 单例预估超预算 → 发送前拒绝
    const tight = createBatchRequestGate({ ...BASE_CONFIG, budgetCny: 0.01 });
    const blocked = tight.authorize(authorizeInput({ messages: bigMessages }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("BUDGET_EXCEEDED");
    expect(tight.state().requests).toBe(0);

    // 第一例允许；记账后累计花费进入下一次预检 → 第二例被拒
    // V1 输出上限提到 12000 后单例预估约 0.1236 元，预算取 0.13 才能放行第一例
    const gate = createBatchRequestGate({ ...BASE_CONFIG, budgetCny: 0.13 });
    const first = gate.authorize(authorizeInput({ messages: bigMessages }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const settled = gate.settle(settleInput(first, { promptTokens: 10_000, completionTokens: 2_400, totalTokens: 12_400 }));
    expect(settled.ok).toBe(true);
    expect(gate.state().spentCny).toBeGreaterThan(0.04);

    const second = gate.authorize(authorizeInput({ messages: bigMessages }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("BUDGET_EXCEEDED");
  });

  // 2026-10-29 #5 真实运行暴露：预检构建一份输入、发送前又重建一份，两次 runId 不同，
  // 导致 User Payload Hash 不一致，事后无法证明「预检覆盖了实际发送内容」。
  // 冻结指纹把两件事绑成一份：内容漂移在发出 HTTP 之前就被拒绝。
  it("冻结指纹：实际请求与预检内容不一致时，发送前即拒绝且不计请求", () => {
    const frozen = requestFingerprint(authorizeInput());
    const gate = createBatchRequestGate({ ...BASE_CONFIG, expectedFingerprint: frozen });
    const drifted = gate.authorize(authorizeInput({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u-drifted" }],
    }));
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.code).toBe("REQUEST_FINGERPRINT_MISMATCH");
    expect(gate.state().requests).toBe(0);
    expect(gate.state().inFlight).toBe(false);

    // 同一份内容仍然放行
    const clean = createBatchRequestGate({ ...BASE_CONFIG, expectedFingerprint: frozen });
    expect(clean.authorize(authorizeInput()).ok).toBe(true);
  });

  it("请求数上限生效：达到上限后不再签发", () => {
    const gate = createBatchRequestGate({ ...BASE_CONFIG, maxRequests: 1 });
    const first = gate.authorize(authorizeInput());
    if (!first.ok) throw new Error("authorize failed");
    expect(gate.settle(settleInput(first)).ok).toBe(true);
    const second = gate.authorize(authorizeInput());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("REQUEST_CAP_REACHED");
  });

  it("记录数与请求数始终一致：每条记录都带指纹、消息摘要与时间", () => {
    const gate = createBatchRequestGate({ ...BASE_CONFIG, maxConsecutiveFailures: 5 });
    for (let index = 0; index < 3; index += 1) {
      const authorized = gate.authorize(authorizeInput());
      if (!authorized.ok) throw new Error(`authorize #${index} failed: ${authorized.code}`);
      expect(gate.settle(settleInput(authorized, { promptTokens: 100 + index, completionTokens: 50, totalTokens: 150 + index })).ok).toBe(true);
    }
    const state = gate.state();
    expect(state.requests).toBe(3);
    expect(state.records).toHaveLength(3);
    expect(state.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    for (const record of state.records) {
      expect(record.fingerprint).toHaveLength(64);
      expect(record.messagesDigest).toHaveLength(64);
      expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.stopCode).toBeNull();
    }
  });
});

describe("P5 批次发送闸：消息形状、用量自洽与未结算票据", () => {
  it("只接受已证明的消息形状：system + user 两条纯文本", () => {
    expect(provenMessageShape([{ role: "system", content: "s" }, { role: "user", content: "u" }]))
      .toEqual({ system: "s", user: "u" });
    expect(provenMessageShape([{ role: "user", content: "u" }])).toBeNull();
    expect(provenMessageShape([{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: "a" }])).toBeNull();
    expect(provenMessageShape([{ role: "user", content: "u" }, { role: "system", content: "s" }])).toBeNull();
  });

  it("形状不符时发送前拒绝：未证明的形状不得绕过 token 上界", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const result = gate.authorize(authorizeInput({
      messages: [{ role: "user", content: "u" }, { role: "system", content: "s" }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNPROVEN_MESSAGE_SHAPE");
    expect(gate.state().authorizations).toBe(0);
    expect(gate.state().inFlight).toBe(false);
  });

  it("用量校验：齐全且 total = prompt + completion 才算合法", () => {
    expect(validateSettledUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }))
      .toEqual({ ok: true, promptTokens: 100, completionTokens: 50, totalTokens: 150 });

    const missing = validateSettledUsage({ promptTokens: 100, completionTokens: 50, totalTokens: null });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("USAGE_UNAVAILABLE");

    const inconsistent = validateSettledUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 999 });
    expect(inconsistent.ok).toBe(false);
    if (!inconsistent.ok) expect(inconsistent.code).toBe("USAGE_INCONSISTENT");
  });

  it("成功响应用量不自洽 → 立即关闸，且不把该用量当费用记账", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");
    const settled = gate.settle(settleInput(authorized, { promptTokens: 100, completionTokens: 50, totalTokens: 999 }));
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.code).toBe("USAGE_INCONSISTENT");
    const record = gate.state().records[0];
    expect(record.costCny).toBeNull();
    expect(record.costUnknown).toBe(true);
    expect(record.settled).toBe(true);
    expect(gate.state().spentCny).toBe(0);
    expect(gate.authorize(authorizeInput()).ok).toBe(false);
  });

  it("未结算票据：abandon 留下费用未知记录、settled=false，并永久停批", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");
    expect(gate.state().inFlight).toBe(true);

    const abandoned = gate.abandon({ ticket: authorized.ticket, reason: "请求发出后进程被中断。" });
    expect(abandoned.record).not.toBeNull();
    const record = abandoned.record!;
    expect(record.settled).toBe(false);
    expect(record.costCny).toBeNull();
    expect(record.costUnknown).toBe(true);
    expect(record.stopCode).toBe("REQUEST_UNSETTLED");
    expect(record.messagesDigest).toHaveLength(64);

    const state = gate.state();
    expect(state.inFlight).toBe(false);
    expect(state.unsettled).toBe(1);
    expect(state.records).toHaveLength(1);
    expect(state.requests).toBe(0);
    expect(state.authorizations).toBe(1);
    expect(state.stopped?.code).toBe("REQUEST_UNSETTLED");

    const next = gate.authorize(authorizeInput());
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.code).toBe("BATCH_STOPPED");
  });

  it("票据已结算后再 abandon 不产生第二条记录", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const authorized = gate.authorize(authorizeInput());
    if (!authorized.ok) throw new Error("authorize failed");
    expect(gate.settle(settleInput(authorized)).ok).toBe(true);
    expect(gate.abandon({ reason: "late" }).record).toBeNull();
    expect(gate.state().records).toHaveLength(1);
    expect(gate.state().unsettled).toBe(0);
  });

  it("已结算与未结算分别计数：requests 只数已结算，authorizations 数全部票据", () => {
    const gate = createBatchRequestGate(BASE_CONFIG);
    const first = gate.authorize(authorizeInput());
    if (!first.ok) throw new Error("authorize failed");
    expect(gate.settle(settleInput(first)).ok).toBe(true);
    const second = gate.authorize(authorizeInput());
    if (!second.ok) throw new Error("authorize failed");
    gate.abandon({ reason: "no response" });

    const state = gate.state();
    expect(state.requests).toBe(1);
    expect(state.authorizations).toBe(2);
    expect(state.unsettled).toBe(1);
  });
});
