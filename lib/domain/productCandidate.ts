import type { OpportunityCandidate } from "@prisma/client";

/**
 * ProductCandidate (轻选工作台 V5.1 业务标准命名)
 *
 * 业务含义：
 *   待研究商品池中的商品候选实体，承载从商品来源层（Source Layer）晋级（Promote）出的
 *   有效商品信息，包含市场指标、原始输入与研究任务转换状态。
 *
 * 数据库现状：
 *   底层物理映射 Prisma 中的 `OpportunityCandidate` 数据表（历史命名）。
 *
 * 架构约束与演进原则：
 *   - 新增业务代码、服务层入参/返回值与 UI 类型一律使用 `ProductCandidate`；
 *   - 本阶段严格禁止数据库 migration 与 schema 修改；
 *   - 底层数据库查询与持久化逻辑继续使用 Prisma 的 `prisma.opportunityCandidate`，保持零风险兼容。
 */
export type ProductCandidate = OpportunityCandidate;

/**
 * ProductCandidate 状态枚举
 */
export type ProductCandidateStatus = "pending" | "converted" | "rejected" | string;
