/**
 * lib/decision/providers/mockProvider.ts
 *
 * Mock Decision Provider — 仅开发/测试显式启用的确定性 Provider。
 *
 * 用途：
 * - DECISION_PROVIDER=mock 时直接使用；
 * - 不会由生产 TypeSafe 失败路径自动切入；
 * - 单元测试中隔离网络依赖。
 *
 * 特点：
 * - 基于 facts 字段做确定性规则评分（无随机性，测试可复现）；
 * - 不依赖任何外部网络；
 * - 约 100ms 内返回（含可选的 mock 延迟）。
 */
import type { DecisionProvider, ProductFacts, ProductDecision, DecisionPriority } from "@/lib/decision/types";

const PROVIDER_ID = "mock";
const MODEL_ID = "mock-rule-based-v1";

/**
 * 基于字段强度的确定性评分，用于 mock 和单元测试。
 * 评分规则透明可复现，不含随机性。
 */
function scoreProductFacts(facts: ProductFacts): {
  score: number;
  priority: DecisionPriority;
  reasons: string[];
  risks: string[];
  confidence: number;
} {
  let score = 50; // 基准分
  const reasons: string[] = [];
  const risks: string[] = [];

  // 销量（权重最高）
  if (facts.estimatedMonthlySales !== null) {
    if (facts.estimatedMonthlySales >= 1000) {
      score += 20;
      reasons.push("月销量估算表现较强（≥1000）");
    } else if (facts.estimatedMonthlySales >= 300) {
      score += 10;
      reasons.push("月销量估算适中（300–999）");
    } else {
      score -= 10;
      risks.push("月销量估算偏低（<300），市场规模需验证");
    }
  } else {
    risks.push("月销量数据缺失，难以评估市场规模");
  }

  // 月收入
  if (facts.estimatedMonthlyRevenueUsd !== null) {
    if (facts.estimatedMonthlyRevenueUsd >= 30000) {
      score += 15;
      reasons.push("月收入规模稳定（≥30K USD）");
    } else if (facts.estimatedMonthlyRevenueUsd >= 10000) {
      score += 8;
      reasons.push("月收入规模可接受（10K–30K USD）");
    } else {
      score -= 5;
      risks.push("月收入规模偏低（<10K USD）");
    }
  }

  // 评分与评论
  if (facts.rating !== null && facts.rating >= 4.2) {
    score += 8;
    reasons.push("产品评分良好（≥4.2）");
  } else if (facts.rating !== null && facts.rating < 3.8) {
    score -= 10;
    risks.push("产品评分偏低（<3.8），可能存在质量问题");
  }

  if (facts.reviewCount !== null && facts.reviewCount >= 200) {
    score += 5;
    reasons.push("市场验证度较高（评论 ≥200）");
  } else if (facts.reviewCount !== null && facts.reviewCount < 30) {
    risks.push("评论数较少（<30），市场反馈有限");
  }

  // BSR
  if (facts.rootCategoryBsr !== null && facts.rootCategoryBsr <= 5000) {
    score += 10;
    reasons.push("大类 BSR 排名优秀（≤5000）");
  }

  // 竞争提示（始终提示需要验证）
  if (!reasons.some((r) => r.includes("竞争"))) {
    reasons.push("竞争环境需进一步研究验证");
  }

  const clampedScore = Math.min(100, Math.max(0, score));
  const priority: DecisionPriority =
    clampedScore >= 75 ? "P1" : clampedScore >= 55 ? "P2" : "P3";

  // confidence 基于数据完整度
  const fieldCount = [
    facts.estimatedMonthlySales,
    facts.estimatedMonthlyRevenueUsd,
    facts.rating,
    facts.reviewCount,
    facts.rootCategoryBsr,
    facts.price,
  ].filter((v) => v !== null).length;
  const confidence = Math.min(0.9, fieldCount / 6);

  return {
    score: clampedScore,
    priority,
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 3),
    confidence: Math.round(confidence * 100) / 100,
  };
}

export class MockDecisionProvider implements DecisionProvider {
  readonly providerId = PROVIDER_ID;

  async analyzeProduct(facts: ProductFacts): Promise<ProductDecision> {
    const result = scoreProductFacts(facts);
    return {
      ...result,
      status: "completed",
      provider: PROVIDER_ID,
      model: MODEL_ID,
      timestamp: new Date().toISOString(),
    };
  }

  async analyzeResearchPriority(facts: ProductFacts): Promise<ProductDecision> {
    return this.analyzeProduct(facts);
  }
}
