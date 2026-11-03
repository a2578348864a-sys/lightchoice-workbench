import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAIN_OUTPUT_CAP_TOKENS, createBatchRequestGate, preflightBatchInput } from "./batchInputBudget";
import { DEFAULT_RESEARCH_CONFIG } from "./researchInput";
import {
  DEEPSEEK_FLASH_CONTEXT_WINDOW,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  RESEARCH_INPUT_CAP_TOKENS,
  V1_DEFAULT_TIMEOUT_MS,
  V1_MAX_OUTPUT_TOKENS,
  V1_MAX_TIMEOUT_MS,
  V1_MIN_OUTPUT_TOKENS,
  V5_MAX_OUTPUT_TOKENS,
} from "./researchOutputLimits";

/**
 * 输出预算一致性（2026-10-29 输出上限 4000 → 12000）。
 *
 * 这里锁定的是「三处消费同一来源」这件事，而不是某个数字本身：
 * 路由夹取、默认研究配置、批次费用闸只要有一处写死不同的值，真实调用就会以
 * `OUTPUT_CAP_MISMATCH` 被拒发（或更糟：请求发出去了但费用按错的输出预算核算）。
 */

const GATE_BASE = {
  model: "deepseek-flash" as const,
  inputCapTokens: RESEARCH_INPUT_CAP_TOKENS,
  budgetCny: 1,
  cnyPerUsd: 7.1,
  maxRequests: 1,
  maxConsecutiveFailures: 1,
} as const;

const messages = [
  { role: "system", content: "s" },
  { role: "user", content: "u" },
] as const;

describe("V1 输出预算：单一配置来源", () => {
  it("默认研究配置与闸的 v1 上限必须相等，且等于 12,000", () => {
    expect(V1_MAX_OUTPUT_TOKENS).toBe(12_000);
    expect(DEFAULT_RESEARCH_CONFIG.maxTokens).toBe(V1_MAX_OUTPUT_TOKENS);
    expect(CHAIN_OUTPUT_CAP_TOKENS.v1).toBe(V1_MAX_OUTPUT_TOKENS);
    // V5 不受本轮影响
    expect(CHAIN_OUTPUT_CAP_TOKENS.v5).toBe(V5_MAX_OUTPUT_TOKENS);
    expect(V5_MAX_OUTPUT_TOKENS).toBe(2_000);
  });

  it("路由夹取区间必须容纳新的默认值，且仍保留原有下限", () => {
    expect(V1_DEFAULT_TIMEOUT_MS).toBe(DEFAULT_RESEARCH_CONFIG.timeoutMs);
    expect(V1_MIN_OUTPUT_TOKENS).toBeLessThanOrEqual(V1_MAX_OUTPUT_TOKENS);
    expect(V1_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(V1_MAX_TIMEOUT_MS);
    expect(V1_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("路由源码必须引用共享常量，不得再写死数字（防止三处再次漂移）", () => {
    const source = readFileSync("app/api/tasks/[id]/research-v1/route.ts", "utf8");
    expect(source).toContain("V1_MAX_OUTPUT_TOKENS");
    expect(source).toContain("V1_MIN_OUTPUT_TOKENS");
    expect(source).toContain("V1_MAX_TIMEOUT_MS");
    // 旧的硬编码上限必须消失
    expect(source).not.toContain("800, 4_000");
    expect(source).not.toContain("10_000, 60_000");
  });

  it("上下文预算：输入上限 + 输出上限远小于模型上下文窗口，输出上限远小于模型最大输出", () => {
    expect(RESEARCH_INPUT_CAP_TOKENS).toBe(145_000);
    expect(RESEARCH_INPUT_CAP_TOKENS + V1_MAX_OUTPUT_TOKENS).toBeLessThan(DEEPSEEK_FLASH_CONTEXT_WINDOW);
    expect(V1_MAX_OUTPUT_TOKENS).toBeLessThan(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS);
  });

  it("闸按 12,000 签发；写成旧值 4,000 或超限 12,001 都必须拒发", () => {
    const gate = createBatchRequestGate(GATE_BASE);
    const wrongOld = gate.authorize({ chain: "v1", model: "deepseek-flash", messages, maxTokens: 4_000, temperature: 0, responseFormat: { type: "json_object" }, timeoutMs: V1_DEFAULT_TIMEOUT_MS });
    expect(wrongOld.ok).toBe(false);
    if (!wrongOld.ok) expect(wrongOld.code).toBe("OUTPUT_CAP_MISMATCH");

    const over = gate.authorize({ chain: "v1", model: "deepseek-flash", messages, maxTokens: 12_001, temperature: 0, responseFormat: { type: "json_object" }, timeoutMs: V1_DEFAULT_TIMEOUT_MS });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("OUTPUT_CAP_MISMATCH");

    const ok = gate.authorize({ chain: "v1", model: "deepseek-flash", messages, maxTokens: V1_MAX_OUTPUT_TOKENS, temperature: 0, responseFormat: { type: "json_object" }, timeoutMs: V1_DEFAULT_TIMEOUT_MS });
    expect(ok.ok).toBe(true);
  });

  it("最坏情况费用（满输入 + 满输出）必须低于本轮 ¥1.00 单次上限", () => {
    const worst = preflightBatchInput({
      system: "s".repeat(RESEARCH_INPUT_CAP_TOKENS),
      user: "",
      model: "deepseek-flash",
      inputCapTokens: RESEARCH_INPUT_CAP_TOKENS,
      outputCapTokens: V1_MAX_OUTPUT_TOKENS,
      budgetCny: 1,
      cnyPerUsd: 7.1,
    });
    expect(worst.decision).toBe("block");
    if (worst.decision === "block") expect(worst.code).toBe("INPUT_CAP_EXCEEDED");

    // 用真实量级输入（#3 约 54.6K tokens 上界）计算最坏费用
    const realistic = preflightBatchInput({
      system: "s".repeat(4_956),
      user: "u".repeat(120_000),
      model: "deepseek-flash",
      inputCapTokens: RESEARCH_INPUT_CAP_TOKENS,
      outputCapTokens: V1_MAX_OUTPUT_TOKENS,
      budgetCny: 1,
      cnyPerUsd: 7.1,
    });
    expect(realistic.decision).toBe("allow");
    if (realistic.decision === "allow") {
      // 输出占大头：12,000 × $1.20/M ≈ ¥0.102；输入按字节上界保守计价。
      expect(realistic.projectedSpendCny).toBeLessThan(1);
      expect(realistic.outputCapTokens).toBe(V1_MAX_OUTPUT_TOKENS);
    }
  });
});
