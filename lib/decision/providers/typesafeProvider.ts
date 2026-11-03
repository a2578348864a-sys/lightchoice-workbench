/**
 * lib/decision/providers/typesafeProvider.ts
 *
 * TypeSafe AI (Jev) Decision Provider Adapter。
 *
 * 职责（严格边界）：
 * - 消费 TypeSafe AI 官方 System One 原生协议（POST https://api.typesafe.ai/v1/systemone）
 * - 模型：jev-latest
 * - 认证：Authorization: Bearer <TYPESAFE_API_KEY>（严格 server-only）
 * - 请求格式转换（ProductFacts → state + questions）
 * - 响应格式转换（answers → ProductDecision）
 * - 错误处理（超时 / 限流 / Key 失效 → 返回 unavailable/failed，不抛出）
 *
 * 禁止：
 * - ❌ 在此处写业务评分规则
 * - ❌ 直接从 EvidenceStore 读数据
 * - ❌ 修改候选状态或事实
 */
import "server-only";

import type { DecisionProvider, ProductFacts, ProductDecision, DecisionPriority } from "@/lib/decision/types";
import { buildFailedDecision, parseProductDecision } from "@/lib/decision/schemas/productDecision";

const PROVIDER_ID = "typesafe";
const TIMEOUT_MS = 15_000;

/** TypeSafe AI 模型标识（可通过环境变量覆盖，默认 jev-latest） */
function resolveModel(): string {
  return process.env["TYPESAFE_MODEL"] ?? "jev-latest";
}

/** TypeSafe API base URL（默认官方 https://api.typesafe.ai/v1） */
function resolveBaseUrl(): string {
  return (process.env["TYPESAFE_BASE_URL"] ?? "https://api.typesafe.ai/v1").replace(/\/$/, "");
}

/** 读取 API Key（严格 server-only；Key 永远不进客户端 bundle） */
function resolveApiKey(): string | null {
  return process.env["TYPESAFE_API_KEY"] ?? null;
}

function buildUnavailableDecision(model: string, reason: string): ProductDecision {
  const decision = buildFailedDecision("unavailable", model);
  return {
    ...decision,
    reasons: [reason],
  };
}

/**
 * 将 ProductFacts 转换为 TypeSafe System One 的 state 字符串。
 */
function buildState(facts: ProductFacts): string {
  const lines: string[] = [];
  if (facts.title) lines.push(`Title: ${facts.title}`);
  if (facts.brand) lines.push(`Brand: ${facts.brand}`);
  if (facts.category) lines.push(`Category: ${facts.category}`);
  if (facts.asin) lines.push(`ASIN: ${facts.asin}`);
  if (facts.price !== null) lines.push(`Price: $${facts.price}`);
  if (facts.rating !== null) lines.push(`Rating: ${facts.rating}/5.0`);
  if (facts.reviewCount !== null) lines.push(`Review Count: ${facts.reviewCount}`);
  if (facts.rootCategoryBsr !== null) lines.push(`Root Category BSR: ${facts.rootCategoryBsr}`);
  if (facts.subCategoryBsr !== null) lines.push(`Sub Category BSR: ${facts.subCategoryBsr}`);
  if (facts.estimatedMonthlySales !== null) {
    lines.push(`Estimated Monthly Sales (third-party): ${facts.estimatedMonthlySales}`);
  }
  if (facts.estimatedMonthlyRevenueUsd !== null) {
    lines.push(`Estimated Monthly Revenue USD (third-party): $${facts.estimatedMonthlyRevenueUsd}`);
  }
  if (facts.marketplace) lines.push(`Marketplace: ${facts.marketplace}`);

  if (lines.length === 0) {
    return "Product: Unknown. No verified facts available.";
  }
  return lines.join("\n");
}

type JevResponse = {
  model?: string;
  answers?: {
    priority?: {
      type?: "choice";
      choice?: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    };
    score?: {
      type?: "score";
      score?: number;
      confidence?: number;
    };
    has_data_risk?: {
      type?: "noul";
      noul?: number;
    };
  };
};

export class TypeSafeDecisionProvider implements DecisionProvider {
  readonly providerId = PROVIDER_ID;

  async analyzeProduct(facts: ProductFacts): Promise<ProductDecision> {
    const apiKey = resolveApiKey();
    const model = resolveModel();

    if (!apiKey) {
      return buildUnavailableDecision(model, "TypeSafe Jev 未配置 API Key，已保留人工研究流程。");
    }

    const state = buildState(facts);
    const baseUrl = resolveBaseUrl();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/systemone`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            state,
            questions: {
              priority: {
                type: "choice",
                instructions: "Evaluate this Amazon product candidate and determine the research priority.",
                criteria: {
                  P1: "Strong sales volume, healthy BSR, high revenue and solid rating (≥4.0). Recommended to prioritize for research.",
                  P2: "Moderate metrics, reasonable market size. Worth researching.",
                  P3: "Low sales, poor rating (<3.8), weak BSR or missing core data. Low priority.",
                },
              },
              score: {
                type: "score",
                instructions: "Rate commercial potential of this candidate from low to high.",
                criteria: ["Low Potential", "Moderate Potential", "High Potential"],
              },
              has_data_risk: {
                type: "noul",
                instructions: "Does this product have notable risk such as low rating (<3.8), poor sales, or insufficient reviews (<30)?",
                criteria: {
                  true: "Product has observable risk factors",
                  false: "Product looks healthy and standard",
                },
              },
            },
          }),
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        if (response.status === 429 || response.status === 401 || response.status === 403) {
          return buildUnavailableDecision(model, "TypeSafe Jev 当前不可用，已保留人工研究流程。");
        }
        return buildUnavailableDecision(model, "TypeSafe Jev Provider 返回失败，已保留人工研究流程。");
      }

      let body: JevResponse;
      try {
        body = (await response.json()) as JevResponse;
      } catch {
        return buildUnavailableDecision(model, "TypeSafe Jev 返回了无法解析的 JSON，已保留人工研究流程。");
      }

      const actualModel = body?.model ?? model;
      const priorityAnswer = body?.answers?.priority;
      const scoreAnswer = body?.answers?.score;
      const riskAnswer = body?.answers?.has_data_risk;

      // ── JEV-001：严格输出校验 ────────────────────────────────────
      // 未知枚举、缺字段、非法数值一律降级为 unavailable；
      // 禁止再把未知 priority 归一为 P2，或用固定 score / 固定 confidence 兜底。
      const rawChoice = typeof priorityAnswer?.choice === "string"
        ? priorityAnswer.choice.trim().toUpperCase()
        : "";
      if (rawChoice !== "P1" && rawChoice !== "P2" && rawChoice !== "P3") {
        return buildUnavailableDecision(actualModel, "TypeSafe Jev 返回了无法识别的 priority，已保留人工研究流程。");
      }
      const priority: DecisionPriority = rawChoice;

      const rawScore = scoreAnswer?.score;
      if (typeof rawScore !== "number" || !Number.isFinite(rawScore) || rawScore < 0 || rawScore > 100) {
        return buildUnavailableDecision(actualModel, "TypeSafe Jev 返回的 score 无效，已保留人工研究流程。");
      }
      // Jev 的 score 为 0..2 三级；越界不再静默夹取成某个结论
      const scoreNum = Math.round(Math.min(1, Math.max(0, rawScore / 2)) * 100);

      const rawConfidence = priorityAnswer?.confidence;
      if (
        typeof rawConfidence !== "number" ||
        !Number.isFinite(rawConfidence) ||
        rawConfidence < 0 ||
        rawConfidence > 1
      ) {
        return buildUnavailableDecision(actualModel, "TypeSafe Jev 返回的 confidence 无效，已保留人工研究流程。");
      }
      const confidence = Math.round(rawConfidence * 1000) / 1000;

      const rawRisk = riskAnswer?.noul;
      if (
        rawRisk !== undefined &&
        (typeof rawRisk !== "number" || !Number.isFinite(rawRisk) || rawRisk < 0 || rawRisk > 1)
      ) {
        return buildUnavailableDecision(actualModel, "TypeSafe Jev 返回的 has_data_risk 无效，已保留人工研究流程。");
      }

      // Reasons
      const reasons: string[] = [];
      const p1Prob = priorityAnswer?.probabilities?.["P1"];
      const p2Prob = priorityAnswer?.probabilities?.["P2"];
      const p3Prob = priorityAnswer?.probabilities?.["P3"];

      if (typeof p1Prob === "number" && p1Prob > 0.6) {
        reasons.push(`TypeSafe Jev 模型评估建议 P1 优先（概率 ${Math.round(p1Prob * 100)}%）`);
      } else if (typeof p2Prob === "number" && p2Prob > 0.5) {
        reasons.push(`TypeSafe Jev 模型评估建议 P2 适中（概率 ${Math.round(p2Prob * 100)}%）`);
      } else if (typeof p3Prob === "number" && p3Prob > 0.5) {
        reasons.push(`TypeSafe Jev 模型评估建议 P3 较低（概率 ${Math.round(p3Prob * 100)}%）`);
      } else {
        reasons.push(`TypeSafe Jev 模型建议：${priority}`);
      }

      if (facts.estimatedMonthlySales !== null) {
        if (facts.estimatedMonthlySales >= 1000) {
          reasons.push(`第三方月销估算强劲（约 ${facts.estimatedMonthlySales.toLocaleString()} 件）`);
        } else if (facts.estimatedMonthlySales >= 300) {
          reasons.push(`第三方月销估算平稳（约 ${facts.estimatedMonthlySales.toLocaleString()} 件）`);
        }
      }

      if (facts.rating !== null && facts.rating >= 4.0) {
        reasons.push(`商品评分良好（${facts.rating} 分）`);
      }

      // Risks
      const risks: string[] = [];
      if (typeof rawRisk === "number" && rawRisk > 0.5) {
        risks.push(`数据风险概率偏高（${Math.round(rawRisk * 100)}%），建议人工细审`);
      }
      if (facts.estimatedMonthlySales === null) {
        risks.push("月销量数据缺失，无法确认市场规模");
      }
      if (facts.rating !== null && facts.rating < 3.8) {
        risks.push(`评分较低（${facts.rating} 分），可能存在品质差评隐患`);
      }

      const candidateDecision: ProductDecision = {
        priority,
        score: scoreNum,
        status: "completed",
        confidence,
        reasons: reasons.slice(0, 5),
        risks: risks.slice(0, 3),
        provider: PROVIDER_ID,
        model: actualModel,
        timestamp: new Date().toISOString(),
      };

      // 二次运行时校验：复用 decisionEngine 同一契约解析器；不通过即视为不可用（不兜底）
      const parsed = parseProductDecision(candidateDecision, PROVIDER_ID, actualModel);
      if (!parsed) {
        return buildUnavailableDecision(actualModel, "TypeSafe Jev 返回结构无法验证，已保留人工研究流程。");
      }
      return parsed;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return buildUnavailableDecision(model, "TypeSafe Jev 请求超时，已保留人工研究流程。");
      }
      return buildUnavailableDecision(model, "TypeSafe Jev 请求失败，已保留人工研究流程。");
    }
  }

  async analyzeResearchPriority(facts: ProductFacts): Promise<ProductDecision> {
    return this.analyzeProduct(facts);
  }
}
