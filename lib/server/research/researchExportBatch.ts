import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import { buildResearchExportRecord } from "@/lib/research/exportRecord";
import {
  mapResearchExportToLarkRecord,
  type LarkBaseRecord,
} from "@/lib/research/larkMapping";
import type { ResearchExportRecord } from "@/lib/research/researchContracts";
import {
  readResearchTaskSnapshot,
  ResearchV1InputError,
} from "./researchInput";
import { readStoredResearchDecision } from "./researchHumanReviewStore";
import { readStoredResearchReport } from "./researchReportStore";

export const RESEARCH_EXPORT_BATCH_MAX_ITEMS = 100;

export type ResearchExportBatchPreview = {
  readonly count: number;
  readonly items: readonly ResearchExportRecord[];
  readonly larkRecords: readonly LarkBaseRecord[];
};

/**
 * 保持用户选择顺序，同时去除重复 taskId。
 * 查询参数解析留在 API 层；该函数只处理已经拆分好的 ID。
 */
export function normalizeResearchExportTaskIds(taskIds: readonly string[]): string[] {
  return Array.from(new Set(
    taskIds
      .map((taskId) => taskId.trim())
      .filter(Boolean),
  ));
}

/**
 * 读取并投影一批已保存的 ResearchReport。
 *
 * 未生成 ResearchReport 的任务会被排除：这样任务列表可以把当前研究任务
 * 作为候选 ID 来源，而不会把旧任务、未完成任务或空结果伪装成可导出记录。
 * 这里没有 Research Engine、Provider 或任何外部 API 依赖。
 */
export async function buildResearchExportBatchPreview(input: {
  readonly context: AccessContext;
  readonly taskIds: readonly string[];
}): Promise<ResearchExportBatchPreview> {
  const taskIds = normalizeResearchExportTaskIds(input.taskIds);
  if (taskIds.length > RESEARCH_EXPORT_BATCH_MAX_ITEMS) {
    throw new ResearchV1InputError(
      "invalid_task_id",
      `一次最多预览 ${RESEARCH_EXPORT_BATCH_MAX_ITEMS} 个研究任务。`,
      400,
    );
  }

  const projected = await Promise.all(taskIds.map(async (taskId) => {
    let task;
    try {
      task = await readResearchTaskSnapshot(input.context, taskId);
    } catch (error) {
      // 任务列表与预览之间可能发生删除/权限变化；批量预览只保留当前仍可读的记录。
      if (error instanceof ResearchV1InputError && error.code === "task_not_found") return null;
      throw error;
    }

    const storedReport = readStoredResearchReport(task.result);
    if (!storedReport) return null;

    const exportRecord = buildResearchExportRecord({
      taskId: task.id,
      candidateId: storedReport.report.candidateId,
      report: storedReport.report,
      reportHash: storedReport.reportHash,
      decision: readStoredResearchDecision(task.result),
    });

    return {
      exportRecord,
      larkRecord: mapResearchExportToLarkRecord(exportRecord),
    };
  }));

  const items = projected.filter((item): item is NonNullable<typeof item> => item !== null);
  return {
    count: items.length,
    items: items.map((item) => item.exportRecord),
    larkRecords: items.map((item) => item.larkRecord),
  };
}
