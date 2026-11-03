import {
  RESEARCH_EXPORT_BATCH_VERSION,
  type ResearchExportBatch,
  type ResearchExportRecord,
} from "./researchContracts";

/**
 * 纯函数：构建 research-export.json 的批量文件载荷。
 *
 * items 必须已经是 ResearchExportRecord；本函数不读取任务、不调用 AI、
 * 不重新计算商品事实，只负责固定版本与生成时间。
 */
export function buildResearchExportBatch(input: {
  readonly items: readonly ResearchExportRecord[];
  readonly generatedAt?: string;
}): ResearchExportBatch {
  return {
    exportVersion: RESEARCH_EXPORT_BATCH_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    items: input.items.map((item) => item),
  };
}
