import type { ViralAnalysisRecord } from "@prisma/client";

/**
 * ProductResearchTask (轻选工作台 V5.1 业务标准命名)
 *
 * 业务含义：
 *   商品研判任务实体（Product Research Task），承载单个商品的研究全貌：
 *   包含研究 taskId、四维度证据（市场/评论/货源/成本）、人工核实的事实（Confirmed Facts）、
 *   人工商业决策（approved/rejected/needs_info）以及创作交接门禁状态。
 *
 * 数据库现状：
 *   底层物理存储在 Prisma 的 `ViralAnalysisRecord` 表（历史命名，type="workflow"）。
 *   大量研究快照（如 `productResearchSummary`, `researchCompletion` 等）均序列化于 `resultJson` 字段。
 *
 * 架构约束与演进原则：
 *   - 新业务代码、对外类型注解一律使用 `ProductResearchTask`，禁止在新业务逻辑中直接显式暴露 `ViralAnalysisRecord`；
 *   - 本阶段严格禁止对数据库表进行 rename migration；
 *   - 底层数据库操作继续通过 Prisma 的 `prisma.viralAnalysisRecord` 进行安全读写，保持零风险兼容。
 */
export type ProductResearchTask = ViralAnalysisRecord;

/**
 * 商品研判商业决议状态
 */
export type ProductResearchDecisionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "needs_information"
  | "continue"
  | string;
