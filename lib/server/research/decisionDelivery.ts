import "server-only";

import { buildResearchFactSnapshot } from "@/lib/server/research/researchEngine";
import { calculateUnitEconomics } from "@/lib/server/research/unitEconomicsCalculator";
import { evaluateDeterministicRiskGates } from "@/lib/server/research/riskGateEvaluator";
import {
  buildDecisionSummary,
  type DecisionSummaryInput,
} from "@/lib/research/decisionSummary";
import type {
  DeterministicRiskGateSummary,
  EconomicAssumptionsInput,
  ResearchDecisionSummary,
} from "@/lib/research/researchContracts";
import type { ProductFact } from "@/lib/sourceLayer/fact/types";

/**
 * P0-DC 决策交付装配层（decision-delivery.v1）。
 *
 * 纯确定性程序：ResearchInputBundle.productFact → 事实快照 → 单位经济测算 →
 * 11 条风险规则门禁 → 决策摘要（8 项清单 / 归因 / 三态建议）。
 * 全程零 AI 调用（aiInvoked 恒为 false，单测断言）；不写任何状态，只做读时组装。
 *
 * V6：可接收已保存的人工商业输入（`assumptions`）。用户输入只作为**确定性计算的输入**，
 * 结果最多影响系统建议的展示，绝不自动设置 PROCEED、绝不改写 Human Decision。
 */
export type DecisionRiskCounts = {
  readonly blocking: number;
  readonly warning: number;
  readonly notComputable: number;
  readonly passed: number;
};

export type DecisionDelivery = {
  readonly status: "available" | "unavailable";
  readonly assembleVersion: "decision-delivery.v1";
  readonly aiInvoked: false;
  readonly reason?: string;
  readonly decisionSummary?: ResearchDecisionSummary;
  readonly riskGate?: DeterministicRiskGateSummary;
  readonly riskCounts?: DecisionRiskCounts;
};

function countRules(gate: DeterministicRiskGateSummary): DecisionRiskCounts {
  let blocking = 0;
  let warning = 0;
  let notComputable = 0;
  let passed = 0;
  for (const rule of gate.rules) {
    if (rule.status === "not_computable") {
      notComputable += 1;
    } else if (rule.status === "passed") {
      passed += 1;
    } else if (rule.status === "triggered") {
      if (rule.severity === "BLOCK") blocking += 1;
      else warning += 1;
    }
  }
  return { blocking, warning, notComputable, passed };
}

/**
 * 组装决策交付物。任何一步失败都降级为 unavailable（fail-closed，不编造建议）。
 */
export function buildDecisionDelivery(input: {
  readonly bundle: { readonly productFact?: ProductFact | null };
  /** V6：已保存的人工商业输入映射出的情景假设；null 时保持历史降级行为。 */
  readonly assumptions?: EconomicAssumptionsInput | null;
  /** V6：商品市场（用于平台费率适用市场登记）。 */
  readonly marketplace?: string | null;
}): DecisionDelivery {
  const productFact = input.bundle.productFact;
  if (!productFact) {
    return {
      status: "unavailable",
      assembleVersion: "decision-delivery.v1",
      aiInvoked: false,
      reason: "PRODUCT_FACT_MISSING",
    };
  }
  try {
    const facts = buildResearchFactSnapshot(productFact);
    const deterministic = calculateUnitEconomics({
      facts,
      assumptions: input.assumptions ?? null,
      marketplace: input.marketplace ?? null,
    });
    const riskGate = evaluateDeterministicRiskGates({ facts, unitEconomics: deterministic });
    const core: DecisionSummaryInput = {
      facts,
      unitEconomics: {
        facts: {
          price: facts.basic.price,
          fbaFee: facts.profit.fbaFee,
          packageWeight: facts.profit.packageWeight,
          packageDimensions: facts.profit.packageDimensions,
          estimatedGrossMargin: facts.market.estimatedGrossMargin,
        },
        deterministic,
      },
      riskAssessment: {
        analysis: null,
        risks: [],
        deterministicGate: riskGate,
      },
    };
    const decisionSummary = buildDecisionSummary(core);
    return {
      status: "available",
      assembleVersion: "decision-delivery.v1",
      aiInvoked: false,
      decisionSummary,
      riskGate,
      riskCounts: countRules(riskGate),
    };
  } catch {
    return {
      status: "unavailable",
      assembleVersion: "decision-delivery.v1",
      aiInvoked: false,
      reason: "ASSEMBLY_FAILED",
    };
  }
}
