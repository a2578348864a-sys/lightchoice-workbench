/**
 * 采集运行范围门禁（默认关闭批量）。
 *
 * `LOCAL_ACQUISITION_ENABLED` 只回答「本机是否允许真实采集」，不区分采集形态。
 * 本模块把「允许到哪一层」单独拆出来，避免为了单 ASIN 采集而同时放开批量执行器：
 *
 *   - 未设置 / 其他值 → `single_asin_only`：批量任务创建、自动分轮、执行器启动一律拒绝；
 *   - 显式 `batch_and_single` → 才允许批量 BCR 流程与执行器。
 *
 * 判定只看服务端 `process.env`，不接受客户端传入；所有调用点都在
 * 租约获取、业务写入与 worker 启动之前，fail-closed。
 */
export const ACQUISITION_SCOPE_ENV = "V5_ACQUISITION_SCOPE";

export type AcquisitionScope = "single_asin_only" | "batch_and_single";

export function resolveAcquisitionScope(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AcquisitionScope {
  return env[ACQUISITION_SCOPE_ENV] === "batch_and_single" ? "batch_and_single" : "single_asin_only";
}

/** 批量采集（BCR 创建 / 自动分轮 / 执行器）是否被允许；缺省为 false。 */
export function isBatchCaptureScopeAllowed(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return resolveAcquisitionScope(env) === "batch_and_single";
}

export const BATCH_CAPTURE_SCOPE_DISABLED_MESSAGE =
  "当前实例只允许人工触发的单 ASIN 详情采集；批量采集、自动分轮与执行器已按运行范围门禁关闭。";
