import { LOCAL_OWNER_PRINCIPAL } from "@/lib/server/accessPassword";
import type { ResearchReport } from "@/lib/research/researchContracts";
import { DEFAULT_RESEARCH_CONFIG, buildResearchEngineInput } from "./researchInput";
import { runResearchEngine } from "./researchEngine";
import { runResearchAdvisory } from "@/lib/server/v5ResearchService";
import type { P5BatchCaseDefinition, P5BatchCaseInvoker, P5BatchCaseOutcome } from "./realModelBatchRunner";

/**
 * 九例执行器的**生产链路接线**：走真实业务入口，不直接拼 prompt。
 *
 * - V1：`buildResearchEngineInput`（只读，正式 Bundle）→ `runResearchEngine`（不写库）
 * - V5：`runResearchAdvisory`（写 task resultJson + V5OperationReceipt）
 *
 * V5 会写库，因此**必须**在隔离副本上运行；隔离性由 `p5BatchIsolation` 断言。
 */

const V5_REQUESTED = ["deepseek_summary", "evidence_risk_gate", "composite_suggestion"] as const;

function summarizeReport(report: ResearchReport): string | null {
  const text = report.executiveSummary?.analysis?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  return text.trim().slice(0, 400);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export type P5RawCapture = (definition: P5BatchCaseDefinition, payload: unknown) => void;

/** V1 生产 invoker：真实研究引擎，返回报告但不落库。 */
export function createV1ProductionInvoker(options: { readonly onRaw?: P5RawCapture } = {}): P5BatchCaseInvoker {
  return async (definition: P5BatchCaseDefinition): Promise<P5BatchCaseOutcome> => {
    const input = await buildResearchEngineInput({
      context: LOCAL_OWNER_PRINCIPAL,
      taskId: definition.taskId,
      researchConfig: DEFAULT_RESEARCH_CONFIG,
      // 与 `POST /api/tasks/[id]/research-v1` 的生产调用一致：正式执行必须组装只读 Bundle，
      // 否则引擎会以 RESEARCH_EVIDENCE_REF_INVALID 拒绝（这是路由层就存在的合同）。
      includeBundle: true,
    });
    const generation = await runResearchEngine(input);
    options.onRaw?.(definition, { chain: "v1", generationStatus: generation.report.generationStatus, report: generation.report });
    const ai = generation.report.ai;
    const status = typeof ai?.status === "string" ? ai.status : "missing";
    return {
      ok: status === "completed",
      errorCode: status === "completed" ? null : (ai?.errorCode ?? "V1_AI_NOT_COMPLETED"),
      detail: `generationStatus=${generation.report.generationStatus};ai.status=${status};ai.model=${ai?.model ?? "null"}`,
      outputSummary: summarizeReport(generation.report),
    };
  };
}

async function readResearchRevision(taskId: string): Promise<number> {
  const { prisma } = await import("@/lib/server/db");
  const task = await prisma.viralAnalysisRecord.findUnique({
    where: { id: taskId },
    select: { resultJson: true },
  });
  if (!task) throw new Error(`RESEARCH_TASK_NOT_FOUND: ${taskId}`);
  let root: Record<string, unknown> = {};
  try {
    root = asRecord(JSON.parse(task.resultJson));
  } catch {
    root = {};
  }
  const revision = asRecord(root.v5Research).researchRevision;
  return typeof revision === "number" && Number.isSafeInteger(revision) ? revision : 0;
}

/** V5 生产 invoker：真实 advisory 服务（会写隔离副本的 task resultJson 与操作收据）。 */
export function createV5ProductionInvoker(input: {
  readonly runId: string;
  readonly requested?: readonly string[];
  readonly onRaw?: P5RawCapture;
}): P5BatchCaseInvoker {
  const requested = [...(input.requested ?? V5_REQUESTED)];
  let sequence = 0;
  return async (definition: P5BatchCaseDefinition): Promise<P5BatchCaseOutcome> => {
    const expectedRevision = await readResearchRevision(definition.taskId);
    const data = await runResearchAdvisory({
      context: LOCAL_OWNER_PRINCIPAL,
      taskId: definition.taskId,
      expectedRevision,
      requested,
      // 隔离副本上允许重生成；正式数据不会走这条路径。
      confirmFinalAdvisoryRegeneration: true,
      idempotencyKey: `p5-batch:${input.runId}:${definition.id}:${sequence++}`,
    });
    input.onRaw?.(definition, {
      chain: "v5",
      researchRevision: data.researchRevision,
      deepseek: data.deepseek,
      evidenceRiskGate: data.evidenceRiskGate,
      compositeSuggestion: data.compositeSuggestion,
    });
    const deepseek = asRecord(data.deepseek);
    const status = typeof deepseek.status === "string" ? deepseek.status : "missing";
    const summary = typeof deepseek.summary === "string" ? deepseek.summary.trim() : "";
    const message = typeof deepseek.message === "string" ? `;message=${deepseek.message.slice(0, 160)}` : "";
    return {
      // V5 生成成功后的状态是 `available`（见 runResearchAdvisory 的绑定分支），不是 `completed`。
      ok: status === "available",
      errorCode: status === "available" ? null : (typeof deepseek.errorCode === "string" ? deepseek.errorCode : "V5_AI_NOT_COMPLETED"),
      detail: `deepseek.status=${status};researchRevision=${data.researchRevision};replayed=${data.replayed}${message}`,
      outputSummary: summary ? summary.slice(0, 400) : null,
    };
  };
}

/** 按链路选择生产 invoker；两链路共用同一个 runId 以隔离幂等键。 */
export function createProductionInvoker(input: {
  readonly runId: string;
  /** 真实批次用它把模型原始输出落到隔离证据目录，供逐例质量评审。 */
  readonly onRaw?: P5RawCapture;
}): P5BatchCaseInvoker {
  const v1 = createV1ProductionInvoker({ onRaw: input.onRaw });
  const v5 = createV5ProductionInvoker({ runId: input.runId, onRaw: input.onRaw });
  return (definition) => (definition.chain === "v1" ? v1(definition) : v5(definition));
}
