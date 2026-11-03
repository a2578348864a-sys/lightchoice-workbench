/**
 * 就绪检查（readiness）——无副作用、可注入依赖，供 /api/health 与单测共用。
 *
 * 目的：区分「进程还活着」与「依赖真的可用」。此前 production 下 /api/health 恒返回
 * {ok:true}，数据库不可写或证据根目录消失时仍会被启动脚本判为就绪。
 *
 * 约束（与 P2-3 要求一致）：
 * - 只做只读探针：数据库 `SELECT 1`，证据目录可读性检查；不写库、不做全库扫描；
 * - 单项超时即判失败，避免健康检查被慢依赖拖住；
 * - 只返回稳定的状态码，不返回路径、异常文本或环境变量。
 */

export type ReadinessCheckName = "database" | "evidenceStore";
export type ReadinessCheckStatus = "ok" | "unavailable" | "timeout";

export type ReadinessResult = {
  ok: boolean;
  checks: Record<ReadinessCheckName, ReadinessCheckStatus>;
};

export type ReadinessDeps = {
  database: () => Promise<unknown>;
  evidenceStore: () => Promise<unknown> | unknown;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 1500;

async function runWithTimeout(
  probe: () => Promise<unknown> | unknown,
  timeoutMs: number,
): Promise<ReadinessCheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([Promise.resolve().then(probe), timeout]);
    return result === "timeout" ? "timeout" : "ok";
  } catch {
    return "unavailable";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function evaluateReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const timeoutMs = Number.isFinite(deps.timeoutMs) && (deps.timeoutMs as number) > 0
    ? Math.trunc(deps.timeoutMs as number)
    : DEFAULT_TIMEOUT_MS;

  const [database, evidenceStore] = await Promise.all([
    runWithTimeout(deps.database, timeoutMs),
    runWithTimeout(deps.evidenceStore, timeoutMs),
  ]);

  return {
    ok: database === "ok" && evidenceStore === "ok",
    checks: { database, evidenceStore },
  };
}

/** 供路由返回的稳定错误码（不含任何依赖细节）。 */
export function readinessErrorCode(result: ReadinessResult): string {
  if (result.checks.database === "timeout") return "DATABASE_TIMEOUT";
  if (result.checks.database !== "ok") return "DATABASE_UNAVAILABLE";
  if (result.checks.evidenceStore === "timeout") return "EVIDENCE_STORE_TIMEOUT";
  if (result.checks.evidenceStore !== "ok") return "EVIDENCE_STORE_UNAVAILABLE";
  return "NOT_READY";
}
