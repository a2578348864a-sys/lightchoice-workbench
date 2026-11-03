/**
 * V1/V5 输出预算与超时的**唯一配置来源**。
 *
 * 为什么单独抽一个模块：输出上限同时被三处消费——API Route 的入参夹取、
 * `DEFAULT_RESEARCH_CONFIG`、以及批次费用闸的 `CHAIN_OUTPUT_CAP_TOKENS`。
 * 三处不一致会直接触发 `OUTPUT_CAP_MISMATCH` 而拒发（2026-10-29 已踩过），
 * 所以它们必须引用同一组常量，而不是各写一个数字。
 *
 * 数值依据（2026-10-29 实测）：
 *  - 官方 `GET /models`：`deepseek-flash` = DeepSeek-V4.1-Flash，
 *    `context_window=1_048_576`、`max_output_tokens=393_216`。
 *  - 真实调用：`maxTokens=2_400` 必截断；`maxTokens=4_000` 在 #3 上旧/新提示词
 *    各 1 次也全部触顶（3_998 / 4_000，`finish_reason=length`，JSON 不闭合）。
 *  - 因此 V1 取 12_000：远低于模型 393_216 上限，且
 *    145_000（输入上限）+ 12_000 = 157_000 << 1_048_576（上下文窗口）。
 *
 * 本模块保持**零依赖**，任何一方（含 aiClient 链路）引入都不会带上 Prisma。
 */

/** V1 单次请求的最大输出 tokens（与闸的 v1 链路上限必须相等）。 */
export const V1_MAX_OUTPUT_TOKENS = 12_000;
/** V5 单次请求的最大输出 tokens（本轮不调整，保持既有值）。 */
export const V5_MAX_OUTPUT_TOKENS = 2_000;
/** 单次请求输入 tokens 的安全上限（本轮不提高）。 */
export const RESEARCH_INPUT_CAP_TOKENS = 145_000;
/** V1 默认超时；12_000 输出的生成时间明显长于 4_000（后者实测约 25s）。 */
export const V1_DEFAULT_TIMEOUT_MS = 90_000;
/** 路由允许的超时上限，给长输出留余量，仍是单次请求。 */
export const V1_MAX_TIMEOUT_MS = 120_000;
/** 路由允许的输出下限（沿用既有 800）。 */
export const V1_MIN_OUTPUT_TOKENS = 800;

/**
 * 官方模型能力（`GET /models`，2026-10-29）。
 * 仅用于断言「输入 + 输出 ≤ 上下文窗口」，不是运行期可调参数。
 */
export const DEEPSEEK_FLASH_CONTEXT_WINDOW = 1_048_576;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216;
