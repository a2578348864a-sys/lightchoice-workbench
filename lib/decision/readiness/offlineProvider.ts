/**
 * Jev Research Readiness — 离线 Provider（零费用、零网络）
 *
 * 本轮**绝对禁止真实 Jev / DeepSeek / OpenAI / Amazon / SellerSprite 调用**。
 * 本文件只提供确定性的离线桩与故障注入，用于证明：
 *   技术接线、契约有效性、安全规则与失败降级。
 *
 * 重要：离线桩**不证明**真实 Jev 模型的判断质量。
 * 桩的输出由输入确定性派生（引用输入自带的 evidenceRefs），不编造结论。
 * 语义矛盾检测等能力在桩里显式留空，并标注为需真实模型验证。
 */
import type { JevReadinessAdvice, JevReadinessInput, ReadinessAdviceProvider } from "./types";

export type OfflineScenario =
  | "ok"
  | "unconfigured"
  | "timeout"
  | "http429"
  | "http500"
  | "malformedJson"
  | "unknownEnum"
  | "invalidRefs"
  | "forbiddenScoreField"
  | "bindingMismatch";

/** 离线桩的固定身份；绝不冒充真实模型 */
export const OFFLINE_PROVIDER_ID = "offline-stub";

export class TransportFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function readinessOf(input: JevReadinessInput): JevReadinessAdvice["readiness"] {
  if (input.riskGateSummary?.hasBlockingRisk === true) return "HIGH_RISK";
  if (input.verifiedNarratives.length === 0) return "NEED_MORE_EVIDENCE";
  if (input.voc === null) return "NEED_MORE_EVIDENCE";
  if (input.fieldPresence["bsr"] === "missing") return "NEED_MORE_EVIDENCE";
  return "READY_FOR_HUMAN_REVIEW";
}

/**
 * 由输入确定性派生「可复核问题」——只使用输入自带的真实 evidenceRefs。
 * 不生成任何改进方案、报价、MOQ、评分或自动决策。
 */
function deriveQuestions(input: JevReadinessInput): JevReadinessAdvice["reviewQuestions"] {
  const questions: { text: string; evidenceRefs: string[] }[] = [];

  for (const theme of input.voc?.themes ?? []) {
    if (theme.kind !== "pain") continue;
    if (theme.evidenceRefs.length === 0) continue;
    const strengthText = theme.strength === "isolated"
      ? `仅 ${theme.reviewCount} 条独立评论提及，尚未复现`
      : theme.strength === "weak"
        ? `${theme.reviewCount} 条提及，未达复现门槛`
        : `${theme.reviewCount} 条提及，已达系统复现门槛（不等于市场普遍需求）`;
    questions.push({
      text: `需人工复核痛点主题「${theme.label}」：${strengthText}。请确认该反馈是否与当前规格一致。`,
      evidenceRefs: [...theme.evidenceRefs],
    });
    if (questions.length >= 4) break;
  }

  for (const missing of input.missingInformation) {
    if (questions.length >= 6) break;
    const ref = input.verifiedNarratives[0]?.evidenceRefs[0];
    if (!ref) break;
    questions.push({ text: `需补齐并复核：${missing}`, evidenceRefs: [ref] });
  }

  return questions;
}

function buildAvailableAdvice(input: JevReadinessInput): JevReadinessAdvice {
  return {
    status: "available",
    readiness: readinessOf(input),
    reviewQuestions: deriveQuestions(input),
    // 语义矛盾检测需要真实模型；离线桩不做任何推测，保持为空并写入 limitations。
    contradictions: [],
    missingEvidence: [...input.missingInformation],
    limitations: [
      "离线桩不进行语义矛盾检测与逻辑跳跃识别；该能力需真实模型验证（NOT_VERIFIED）。",
      "桩输出由输入确定性派生，不代表真实模型的判断质量。",
    ],
    inputBinding: { ...input.binding },
  };
}

/**
 * 创建离线 Provider。所有场景都不会发起任何外部请求。
 * - unconfigured：返回 unavailable（不伪造成功）
 * - timeout / http429 / http500：抛出传输异常，交由执行器映射为 failed
 * - malformedJson / unknownEnum / invalidRefs / forbiddenScoreField / bindingMismatch：返回违规载荷，
 *   由 schema 层整份拒收 → failed
 */
export function createOfflineAdviceProvider(scenario: OfflineScenario): ReadinessAdviceProvider {
  return {
    providerId: `${OFFLINE_PROVIDER_ID}:${scenario}`,
    async advise(input: JevReadinessInput): Promise<unknown> {
      switch (scenario) {
        case "ok":
          return buildAvailableAdvice(input);
        case "unconfigured":
          return {
            status: "unavailable",
            readiness: null,
            reviewQuestions: [],
            contradictions: [],
            missingEvidence: [],
            limitations: ["离线桩：未配置 Provider。"],
            inputBinding: { ...input.binding },
          };
        case "timeout":
          throw new TransportFailure("ETIMEDOUT", "offline stub: simulated timeout");
        case "http429":
          throw new TransportFailure("HTTP_429", "offline stub: simulated rate limit");
        case "http500":
          throw new TransportFailure("HTTP_500", "offline stub: simulated server error");
        case "malformedJson":
          return "{\"status\":\"available\",\"readiness\":";
        case "unknownEnum":
          return {
            status: "available",
            readiness: "MAYBE_READY",
            reviewQuestions: [],
            contradictions: [],
            missingEvidence: [],
            limitations: [],
            inputBinding: { ...input.binding },
          };
        case "invalidRefs":
          return {
            status: "available",
            readiness: "READY_FOR_HUMAN_REVIEW",
            reviewQuestions: [
              { text: "引用了不在白名单内的证据（应被拒收）", evidenceRefs: ["evidence:not-in-allowlist-001"] },
            ],
            contradictions: [
              { text: "同样引用了非法引用", evidenceRefs: ["attachment:forged-xyz"] },
            ],
            missingEvidence: [],
            limitations: [],
            inputBinding: { ...input.binding },
          };
        case "forbiddenScoreField":
          return {
            status: "available",
            readiness: "READY_FOR_HUMAN_REVIEW",
            reviewQuestions: [],
            contradictions: [],
            missingEvidence: [],
            limitations: [],
            score: 87,
            priority: "P1",
            inputBinding: { ...input.binding },
          };
        case "bindingMismatch":
          return {
            status: "available",
            readiness: "READY_FOR_HUMAN_REVIEW",
            reviewQuestions: [],
            contradictions: [],
            missingEvidence: [],
            limitations: [],
            inputBinding: { ...input.binding, reportHash: "deadbeef".repeat(8), researchRevision: (input.binding.researchRevision ?? 0) + 1 },
          };
        default:
          throw new TransportFailure("UNKNOWN_SCENARIO", `offline stub: unknown scenario ${String(scenario)}`);
      }
    },
  };
}

/**
 * 网络守卫：任何被它拦截的调用都会被计数并抛出。
 * 用于证明离线执行路径不会发起外部请求（测试里把它装到 globalThis.fetch）。
 */
export function createNetworkGuard(): { fetchImpl: (...args: unknown[]) => never; attempted: () => number } {
  let attempts = 0;
  return {
    fetchImpl: (..._args: unknown[]): never => {
      attempts += 1;
      throw new Error("EXTERNAL_REQUEST_FORBIDDEN: 本轮禁止任何外部网络调用");
    },
    attempted: () => attempts,
  };
}
