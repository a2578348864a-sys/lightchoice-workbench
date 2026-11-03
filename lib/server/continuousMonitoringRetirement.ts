/**
 * 持续监控（Continuous Monitoring）V6 正式退役的唯一服务端事实源。
 *
 * 退役范围：停止创建、修改、启停、立即检查与自动调度；保留源码、数据库历史与 EvidenceStore。
 * 写入 API 门禁与调度门禁都必须读取本模块，确保任何环境变量或启动配置都不能重新开启执行。
 */
export const CONTINUOUS_MONITORING_RETIRED = true;

export const MONITORING_RETIRED_CODE = "MONITORING_RETIRED";

export const MONITORING_RETIRED_MESSAGE =
  "持续监控已停止提供；不会创建、修改或执行新的监控任务。历史记录与采集证据仍予保留。";

export function isContinuousMonitoringRetired(): boolean {
  return CONTINUOUS_MONITORING_RETIRED;
}
