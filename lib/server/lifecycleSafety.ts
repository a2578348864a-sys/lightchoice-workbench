import { prisma } from "./db";
import { MARKET_OPPORTUNITY_OWNER_SCOPE } from "@/lib/marketOpportunity/types";

export interface LifecycleDeletionCheckResult {
  canDelete: boolean;
  canArchive: boolean;
  reason?: string;
  linkedEntityName?: string;
  code: "allowed" | "protected_reference" | "protected_decision" | "not_found";
}

/**
 * 候选品删除与归档安全审计：
 * 若已转换/关联为 Task (convertedTaskId !== null)，禁止物理删除，仅允许移出池/归档。
 */
export async function checkCandidateDeletionSafety(candidateId: string): Promise<LifecycleDeletionCheckResult> {
  const candidate = await prisma.opportunityCandidate.findUnique({
    where: { id: candidateId },
    select: { id: true, name: true, convertedTaskId: true, status: true },
  });

  if (!candidate) {
    return { canDelete: false, canArchive: false, code: "not_found", reason: "候选品不存在。" };
  }

  if (candidate.convertedTaskId) {
    return {
      canDelete: false,
      canArchive: true,
      code: "protected_reference",
      linkedEntityName: `任务 ID: ${candidate.convertedTaskId}`,
      reason: "该候选品已转入商品研究任务，受业务证据链保护禁止物理删除。可将其移出研究池。",
    };
  }

  return { canDelete: true, canArchive: true, code: "allowed" };
}

/**
 * 市场扫描删除与归档安全审计：
 * 若已被细分市场机会引用 (latestMarketScanId 或 scanRefsJson 包含该 ID)，禁止物理删除。
 */
export async function checkMarketScanDeletionSafety(scanId: string): Promise<LifecycleDeletionCheckResult> {
  const scan = await prisma.marketScan.findUnique({
    where: { id: scanId },
    select: { id: true, scanName: true },
  });

  if (!scan) {
    return { canDelete: false, canArchive: false, code: "not_found", reason: "市场扫描不存在。" };
  }

  const linkedOpp = await prisma.nicheOpportunity.findFirst({
    where: {
      OR: [
        { latestMarketScanId: scanId },
        { scanRefsJson: { contains: scanId } },
      ],
    },
    select: { id: true, name: true },
  });

  if (linkedOpp) {
    return {
      canDelete: false,
      canArchive: true,
      code: "protected_reference",
      linkedEntityName: linkedOpp.name,
      reason: `该市场扫描已被市场机会「${linkedOpp.name}」引用，受证据链保护禁止物理删除。`,
    };
  }

  return { canDelete: true, canArchive: true, code: "allowed" };
}

/**
 * 细分市场机会删除与归档安全审计：
 * 若已产生人工决断 (CONTINUE / DROP / WATCH 等)、已发起抽样代表品研究或已生成产品概念，
 * 属于正式业务决策资产，绝对禁止物理抹除，仅允许设置归档状态。
 */
export async function checkMarketOpportunityDeletionSafety(opportunityId: string): Promise<LifecycleDeletionCheckResult> {
  const opp = await prisma.nicheOpportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true,
      name: true,
      humanDecisionJson: true,
      representativeSetJson: true,
      conceptSnapshotJson: true,
    },
  });

  if (!opp) {
    return { canDelete: false, canArchive: false, code: "not_found", reason: "市场机会不存在。" };
  }

  // 检查是否有人工决断
  let hasActiveDecision = false;
  if (opp.humanDecisionJson) {
    try {
      const parsed = JSON.parse(opp.humanDecisionJson);
      if (parsed?.status && parsed.status !== "PENDING" && parsed.status !== "DRAFT") {
        hasActiveDecision = true;
      }
    } catch {}
  }

  // 检查是否有代表品研究
  let hasRepresentativeResearch = false;
  if (opp.representativeSetJson) {
    try {
      const parsed = JSON.parse(opp.representativeSetJson);
      if (Array.isArray(parsed?.items) && parsed.items.some((it: any) => it.researchStatus && it.researchStatus !== "not_started")) {
        hasRepresentativeResearch = true;
      }
    } catch {}
  }

  // 检查是否有产品概念
  const hasConcept = !!opp.conceptSnapshotJson;

  if (hasActiveDecision || hasRepresentativeResearch || hasConcept) {
    return {
      canDelete: false,
      canArchive: true,
      code: "protected_decision",
      linkedEntityName: opp.name,
      reason: "该市场机会已产生人工决断、代表品研究或产品概念提案，受审计溯源保护禁止物理删除。请使用归档功能。",
    };
  }

  return { canDelete: true, canArchive: true, code: "allowed" };
}

/**
 * 商品研究任务 (ViralAnalysisRecord) 删除与归档安全审计：
 * 若决策状态已拍板 (approved/rejected/etc) 或已生成研究报告/文案事实，禁止物理删除。
 */
export async function checkTaskDeletionSafety(taskId: string): Promise<LifecycleDeletionCheckResult> {
  if (typeof (prisma as unknown as { viralAnalysisRecord?: { findUnique?: unknown } })?.viralAnalysisRecord?.findUnique !== "function") {
    return { canDelete: true, canArchive: true, code: "allowed" };
  }

  const task = await prisma.viralAnalysisRecord.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, decisionStatus: true, resultJson: true },
  });

  if (!task) {
    return { canDelete: false, canArchive: false, code: "not_found", reason: "研究任务不存在。" };
  }

  const isDecided = task.decisionStatus && task.decisionStatus !== "pending" && task.decisionStatus !== "draft";
  let hasReport = false;
  if (task.resultJson) {
    try {
      const parsed = JSON.parse(task.resultJson);
      if (parsed?.report || parsed?.confirmedFacts || parsed?.commercial) {
        hasReport = true;
      }
    } catch {}
  }

  if (isDecided || hasReport) {
    return {
      canDelete: false,
      canArchive: true,
      code: "protected_decision",
      linkedEntityName: task.title || taskId,
      reason: "该研究任务已产生人工拍板决断或研究产物，受业务事实链保护禁止物理删除。请使用归档功能。",
    };
  }

  return { canDelete: true, canArchive: true, code: "allowed" };
}
