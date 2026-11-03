/**
 * 市场样本门槛唯一常量（客户端安全、零依赖）。
 *
 * 单独成模块的原因：`marketSamplePolicy` 依赖 `productBatchContract`（含 node:crypto），
 * 无法进入浏览器 bundle；Source UI 只需要这一个数值常量，故把常量定义放在无依赖模块，
 * `marketSamplePolicy` 再 re-export，保证全仓仍只有一个定义。
 */
export const MIN_VALID_SAMPLE_COUNT = 30 as const;
