import { NextRequest, NextResponse } from "next/server";
import { requireOwnerOnly } from "@/lib/server/demoGuard";
import {
  buildResearchExportBatchPreview,
  normalizeResearchExportTaskIds,
  RESEARCH_EXPORT_BATCH_MAX_ITEMS,
} from "@/lib/server/research/researchExportBatch";
import { ResearchV1InputError } from "@/lib/server/research/researchInput";
import {
  LarkBaseDestination,
  syncResearchDecisionsToCommodityPool,
  type CommodityDecisionSyncInput,
} from "@/lib/integrations/lark";
import {
  ProductResearchStoreError,
  getProductResearchDecisionState,
} from "@/lib/server/productResearchRecordStore";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof ResearchV1InputError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof ProductResearchStoreError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  const message = "同步到飞书多维表格发生异常，请稍后重试。";
  return json(
    {
      ok: false,
      error: { code: "lark_sync_failed", message },
    },
    500,
  );
}

function decisionForCommodityPool(status: string): "可做" | "不做" | "待观察" | null {
  if (status === "creative_ready") return "可做";
  if (status === "abandoned") return "不做";
  if (status === "needs_information") return "待观察";
  return null;
}

function isSubjectKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * POST /api/research-export/lark-sync
 *
 * 飞书多维表格单向同步 API。
 * 接收客户端提交的 taskIds，服务端重新读取已保存的研报与人工决策，
 * 严禁客户端篡改事实，严禁调用 AI，以 subjectKey 为业务主键执行幂等写入。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) {
    return json({ ok: false, error: { code: auth.code, message: auth.message } }, auth.status);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { ok: false, error: { code: "invalid_json", message: "请求体必须为合法 JSON。" } },
      400,
    );
  }

  if (
    typeof body !== "object"
    || body === null
    || !Array.isArray((body as { taskIds?: unknown }).taskIds)
  ) {
    return json(
      { ok: false, error: { code: "invalid_params", message: "参数 taskIds 必须为字符串数组。" } },
      400,
    );
  }

  const rawTaskIds = (body as { taskIds: unknown[] }).taskIds
    .filter((id): id is string => typeof id === "string");
  const taskIds = normalizeResearchExportTaskIds(rawTaskIds);

  if (taskIds.length === 0) {
    return json(
      { ok: false, error: { code: "task_ids_required", message: "请至少选择一个已完成研究的商品任务。" } },
      400,
    );
  }

  if (taskIds.length > RESEARCH_EXPORT_BATCH_MAX_ITEMS) {
    return json(
      {
        ok: false,
        error: {
          code: "batch_size_exceeded",
          message: `单次最多支持同步 ${RESEARCH_EXPORT_BATCH_MAX_ITEMS} 个商品。`,
        },
      },
      400,
    );
  }

  const requestedClientToken = (body as { clientToken?: unknown; client_token?: unknown }).clientToken
    ?? (body as { client_token?: unknown }).client_token;
  if (requestedClientToken !== undefined
    && (typeof requestedClientToken !== "string" || requestedClientToken.trim().length === 0)) {
    return json(
      { ok: false, error: { code: "invalid_client_token", message: "clientToken 必须是非空字符串。" } },
      400,
    );
  }
  const decisionSyncMode = (body as { mode?: unknown }).mode === "decision";

  try {
    // 重新从已持久化的数据库读取快照，确保事实源防篡改
    const preview = await buildResearchExportBatchPreview({
      context: auth.context,
      taskIds,
    });

    if (preview.items.length === 0) {
      return json(
        {
          ok: false,
          error: {
            code: "no_valid_reports",
            message: "所选任务均未保存 ResearchReport，无法同步到飞书。",
          },
        },
        // 决策面板触发的是预期的业务前置条件失败：本地决定已经成功，
        // 只是当前任务尚未保存 ResearchReport。返回业务失败体而非 HTTP 错误，
        // 避免浏览器把可恢复的 UI 状态误报为网络错误；旧批量导出行为保持 400。
        decisionSyncMode ? 200 : 400,
      );
    }

    // 新闭环：ResearchReport 已携带 subjectKey 时，只回写商品池的决策列。
    // 没有 subjectKey 的历史导出记录继续走旧 ASIN 导出兼容路径，避免改变已有批量导出行为。
    const usesCommodityPool = preview.items.every((item) => isSubjectKey(item.subjectKey));
    if (usesCommodityPool) {
      const decisions: CommodityDecisionSyncInput[] = [];
      for (const item of preview.items) {
        const state = await getProductResearchDecisionState(auth.context, item.taskId);
        const latest = state.record?.latestDecision;
        const decision = latest ? decisionForCommodityPool(latest.status) : null;
        if (!state.record || !latest || !decision) {
          return json(
            {
              ok: false,
              error: {
                code: "human_decision_required",
                message: `任务 ${item.taskId} 尚未保存有效的人工决定，已阻止同步草稿状态。`,
              },
            },
            409,
          );
        }
        decisions.push({
          subjectKey: item.subjectKey!,
          decision: {
            researchStatus: "已完成",
            decision,
            reason: latest.reason,
            nextAction: latest.nextAction,
            decidedAt: latest.decidedAt,
            reportHash: item.evidence.reportHash,
            syncedAt: new Date().toISOString(),
          },
        });
      }

      const result = await syncResearchDecisionsToCommodityPool(decisions, {
        requestClientToken: typeof requestedClientToken === "string"
          ? requestedClientToken.trim()
          : undefined,
      });
      if (result.conflictCount > 0 || result.failedCount > 0) {
        const conflict = result.conflictCount > 0;
        return json(
          {
            ok: false,
            error: {
              code: conflict ? "FEISHU_SUBJECT_KEY_CONFLICT" : "lark_sync_failed",
              message: conflict
                ? "飞书商品池存在重复 subjectKey，决策回写已 fail-closed。"
                : "决策已在工作台保存，但同步飞书商品池失败，可从页面重试。",
            },
            data: result,
          },
          conflict ? 409 : 502,
        );
      }
      return json({ ok: true, data: result });
    }

    const destination = new LarkBaseDestination();
    const result = await destination.sync(preview.items);

    return json({
      ok: true,
      data: result,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
