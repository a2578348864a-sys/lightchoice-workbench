import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/server/db";
import { getFeishuConnectionStatus } from "@/lib/server/v5FeishuService";
import { V5CoreError, okResponse } from "@/lib/server/v5CoreCommon";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { listResearch } from "@/lib/server/v5ResearchService";
import { hashJson, parseJsonRecord } from "@/lib/server/v5CoreCommon";
import { readMarketWorkflowMetadata } from "@/lib/marketWorkflow/metadata";
import { resolveWorkflowActionTarget, resolveWorkflowStage } from "@/lib/workflow/workflowResolver";
import { projectMarketMetricDisplaySummary } from "@/lib/marketScan/marketDisplayProjection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    if (auth.context.mode !== "owner") throw new V5CoreError("FORBIDDEN", "当前主体不允许读取正式工作台摘要。", 403);
    const [source, marketRows, sourceItems, researchResult] = await Promise.all([
      prisma.productBatch.count({ where: { ownerSubject: "owner:v1", archivedAt: null } }),
      prisma.marketScan.findMany({
        where: { ownerScope: "owner:v1", archivedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true, scanName: true, marketplace: true, createdAt: true, updatedAt: true, sampleDefinitionJson: true, sampleHash: true, metricsJson: true, metricsVersion: true, sampleCount: true },
      }),
      prisma.productBatchItem.count({ where: { archivedAt: null } }),
      listResearch({ context: auth.context, view: "all", light: true }),
    ]);
    const market = marketRows.length;
    const marketWorkflow = marketRows.map((scan) => readMarketWorkflowMetadata(parseJsonRecord(scan.sampleDefinitionJson), {
      scanId: scan.id,
      sampleHash: scan.sampleHash,
      metricsHash: hashJson(parseJsonRecord(scan.metricsJson)),
      metricsVersion: scan.metricsVersion,
    }));
    const marketSampleCount = marketRows.reduce((sum, scan) => sum + Math.max(0, scan.sampleCount), 0);
    const marketDecisionPendingCount = marketWorkflow.filter((workflow) => !workflow.stale && (workflow.effectiveGateStatus === "PENDING" || workflow.effectiveGateStatus === "VALIDATE_MORE")).length;
    const marketProceedCount = marketWorkflow.filter((workflow) => !workflow.stale && workflow.effectiveGateStatus === "PROCEED").length;
    const representativeCount = marketWorkflow.reduce((sum, workflow) => (
      sum + (!workflow.stale && workflow.effectiveGateStatus === "PROCEED" ? workflow.metadata.representatives.items.length : 0)
    ), 0);
    const researchTaskCount = researchResult.items.filter((item) => typeof item.taskId === "string" && item.taskId.length > 0).length;
    const productBriefCount = researchResult.items.filter((item) => item.hasProductBrief === true).length;

    const decisionQueue = researchResult.items
      .filter((r) => r.businessStage === "needs_decision")
      .slice(0, 5)
      .map((r) => ({
        taskId: r.taskId as string,
        asin: r.asin as string,
        title: (r.title as string | null) ?? null,
        image: (r.image as string | null) ?? null,
        brand: (r.brand as string | null) ?? null,
        category: (r.category as string | null) ?? null,
        deepseekSummary: null,
        riskGateStatus: (r.systemSuggestion as Record<string, unknown> | undefined)?.status as string | null ?? null,
        compositeSuggestion: ((r.systemSuggestion as Record<string, unknown> | undefined)?.composite as any) ?? "no_suggestion",
        updatedAt: r.updatedAt as string,
      }));

    const counts = {
      sourceBatches: source,
      sourceItems,
      marketScans: market,
      marketSamples: marketSampleCount,
      researchTotal: researchResult.counts.all,
      researchNeedsChoice: researchResult.counts.needs_decision,
      researchInProgress: researchResult.counts.ready,
      choiceProceed: researchResult.counts.proceed,
      choiceWatch: researchResult.counts.pause + researchResult.counts.validate_more,
      choiceDrop: researchResult.counts.drop,
      archived: researchResult.counts.archived,
    };

    // 决策状态分项只读计数：暂缓观察（pause）与需补充验证（validate_more）是不同语义，
    // 不再只合并为 choiceWatch；旧字段继续保留以兼容既有消费方。
    const decision = {
      paused: researchResult.counts.pause,
      validateMore: researchResult.counts.validate_more,
    };

    const pipeline = {
      source: { totalBatches: source, totalItems: sourceItems },
      market: { totalScans: market, totalSamples: marketSampleCount },
      research: { inProgress: researchResult.counts.ready, needsChoice: researchResult.counts.needs_decision },
      choices: {
        total: researchResult.counts.proceed + researchResult.counts.pause + researchResult.counts.validate_more + researchResult.counts.drop,
        proceed: researchResult.counts.proceed,
        watch: researchResult.counts.pause + researchResult.counts.validate_more,
        drop: researchResult.counts.drop,
      },
    };

    const workflow = resolveWorkflowStage({
      sourceBatchCount: source,
      sourceItemCount: sourceItems,
      marketScanCount: market,
      marketSampleCount,
      marketDecisionPendingCount,
      marketProceedCount,
      representativeCount,
      researchTaskCount,
      productDecisionCount: researchResult.counts.needs_decision,
      productGateProceedCount: researchResult.counts.proceed,
      productBriefCount,
    });

    // D0-006：动作必须绑定同主体对象（带 taskId/scanId 的 URL）；
    // 没有合格对象时返回无 subject 的阶段性动作，前端不得拼接任意商品卡片。
    const briefTargets = researchResult.items
      .filter((item) =>
        typeof item.taskId === "string" && item.taskId.length > 0
        && (item.hasProductBrief === true || item.businessStage === "proceed"),
      )
      .slice(0, 20)
      .map((item) => ({
        taskId: item.taskId as string,
        asin: (item.asin as string) ?? "",
        title: (item.title as string | null) ?? null,
        image: (item.image as string | null) ?? null,
        hasBrief: item.hasProductBrief === true,
        businessStage: item.businessStage as string,
      }));
    const pendingScanTargets: Array<{ scanId: string; scanName: string }> = [];
    const proceedScanTargets: Array<{ scanId: string; scanName: string }> = [];
    marketRows.forEach((row, index) => {
      const entry = marketWorkflow[index];
      if (!entry || entry.stale) return;
      if (entry.effectiveGateStatus === "PENDING" || entry.effectiveGateStatus === "VALIDATE_MORE") {
        pendingScanTargets.push({ scanId: row.id, scanName: row.scanName });
      } else if (entry.effectiveGateStatus === "PROCEED") {
        proceedScanTargets.push({ scanId: row.id, scanName: row.scanName });
      }
    });
    const nextAction = resolveWorkflowActionTarget(
      workflow.stage,
      {
        decisionTargets: decisionQueue.map((entry) => ({
          taskId: entry.taskId,
          asin: entry.asin,
          title: entry.title,
          image: entry.image,
        })),
        briefTargets,
        pendingScanTargets,
        proceedScanTargets,
      },
      workflow.action,
    );

    return NextResponse.json(
      okResponse({
        source: { batchCount: source, itemCount: sourceItems },
        market: { scanCount: market, sampleCount: marketSampleCount },
        research: { taskCount: researchResult.counts.all, pendingCandidateCount: researchResult.counts.ready },
        counts,
        decision,
        pipeline,
        decisionQueue,
        recentScans: marketRows.slice(0, 5).map((scan) => {
          const metrics = projectMarketMetricDisplaySummary(parseJsonRecord(scan.metricsJson));
          return { scanId: scan.id, scanName: scan.scanName, marketplace: scan.marketplace, sampleCount: scan.sampleCount,
            medianPrice: scan.marketplace === "US" && metrics.medianPrice !== null ? { amount: metrics.medianPrice, currency: "USD" } : null,
            cr5: metrics.cr5, createdAt: scan.createdAt.toISOString(), updatedAt: scan.updatedAt.toISOString() };
        }),
        workflowStage: workflow.stage,
        nextAction,
        feishu: getFeishuConnectionStatus(),
      }).body,
    );
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
