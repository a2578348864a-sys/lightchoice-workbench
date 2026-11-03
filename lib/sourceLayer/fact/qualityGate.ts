import type { ProductFact } from "@/lib/sourceLayer/fact/types";

/**
 * TypeSafe / Jev 质量门禁的预留接口。
 *
 * Phase 1 默认关闭：Capture Gateway 不会实例化、调用或联网执行任何
 * Quality Gate。未来接入时只能在 Evidence 已落地、ProductFact 已生成之后
 * 显式开启，并把结果作为质量信号返回，不能改写事实值。
 */
export const QUALITY_GATE_DEFAULT_ENABLED = false as const;

export type QualityGateStatus = "disabled" | "passed" | "failed";

export type QualityGateIssue = {
  readonly code: string;
  readonly field: string | null;
  readonly message: string;
};

export type QualityGateResult = {
  readonly enabled: boolean;
  readonly status: QualityGateStatus;
  readonly gateId: string | null;
  readonly issues: readonly QualityGateIssue[];
};

export interface QualityGate {
  readonly gateId: string;
  evaluate(productFact: ProductFact): Promise<QualityGateResult>;
}

export const DISABLED_QUALITY_GATE_RESULT: QualityGateResult = Object.freeze({
  enabled: false,
  status: "disabled",
  gateId: null,
  issues: [],
});
