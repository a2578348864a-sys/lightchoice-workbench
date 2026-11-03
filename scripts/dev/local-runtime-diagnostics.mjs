/**
 * 本地运行器轻量退出诊断（无新依赖、无守护进程、无系统服务）。
 *
 * 要解决的问题：进程「无痕消失」在事后无法判定。
 * 现状缺口有两个：
 *   1) 子进程退出码为 0 时，启动器静默结束、不写任何日志；
 *   2) 启动器被外部强杀时，根本来不及写日志（实测历史实例状态文件仍在、stderr 0 字节）。
 *
 * 这里补三类可落盘证据，全部写在既有 `.next/` 状态目录里：
 *   - launch 记录：进程身份（launcher/child PID、父子关系、启动时间、端口、脚本名、Node 版本）。
 *   - 心跳记录：周期写入「最后一次存活时间 + 最后一次健康探针结果」；外部强杀后仍留在磁盘。
 *   - exit 记录：退出码/信号、是否由本仓库 stop 命令发起（安全退出）、退出前最后一次健康状态。
 *
 * 事后判定：
 *   - 有 exit 记录且 managedStop=true  → 安全停机（本仓库 stop 命令）。
 *   - 有 exit 记录且 managedStop=false → 子进程异常退出（带退出码/信号）。
 *   - 无 exit 记录且心跳停在某一时刻 → 启动器被外部终止（外部强杀特征）。
 *
 * 安全边界：只持久化白名单标量字段；不写环境变量、命令行全文、密码、Token、Cookie。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 24;
const MAX_STRING = 200;
const SENSITIVE_KEY = /(pass|secret|token|cookie|credential|api[-_]?key|authorization|bearer|session|database_url)/i;
/**
 * 落盘白名单：只有这些键允许写入诊断文件。
 * 采用白名单而不是黑名单——任何环境变量、凭据、未预期字段都会在此被丢弃。
 */
const ALLOWED_KEYS = new Set([
  "at", "type", "reason", "exitCode", "signal", "managedStop", "stopIntentAt", "uptimeMs",
  "lastHealth", "launcherPid", "launcherParentPid", "childPid", "port", "host",
  "repoRoot", "nodeVersion", "launcherScript", "ok", "status", "checkedAt", "latencyMs",
  "error", "requestedAt", "requestedByPid", "targetPid",
]);

function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value;
  }
  return null;
}

/** 白名单消毒：不在白名单的键一律丢弃，复杂结构降为 null。 */
export function sanitizeDiagnosticRecord(input = {}) {
  const output = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return output;
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (SENSITIVE_KEY.test(key)) continue;
    if (key === "lastHealth") {
      // 健康快照是嵌套对象：只保留标量字段，不做深度透传。
      output[key] = value !== null && typeof value === "object" && !Array.isArray(value)
        ? sanitizeDiagnosticRecord(value)
        : null;
      continue;
    }
    output[key] = sanitizeValue(value);
  }
  return output;
}

/** 进程是否仍然存在（只做存在性检查，不发信号）。 */
export function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

export function runtimeDiagnosticsFilePath(projectRoot, port) {
  return join(resolve(projectRoot), ".next", "local-runtime-" + Number(port) + ".diagnostics.json");
}

export function runtimeStopIntentFilePath(projectRoot, port) {
  return join(resolve(projectRoot), ".next", "local-runtime-" + Number(port) + ".stop-intent.json");
}

function writeJsonAtomic(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 新一轮启动：重置诊断文件（避免上一轮的退出记录被误读成这一轮的）。 */
export function recordRuntimeLaunch(projectRoot, port, payload = {}) {
  const file = runtimeDiagnosticsFilePath(projectRoot, port);
  const launch = { ...sanitizeDiagnosticRecord(payload), type: "launch" };
  const data = {
    schemaVersion: SCHEMA_VERSION,
    port: Number(port),
    repoRoot: String(resolve(projectRoot)),
    launch,
    launcher: {
      pid: launch.launcherPid ?? null,
      parentPid: launch.launcherParentPid ?? null,
      startedAt: launch.at ?? null,
    },
    child: { pid: launch.childPid ?? null },
    lastHeartbeatAt: null,
    lastHealth: null,
    events: [launch],
  };
  writeJsonAtomic(file, data);
  return data;
}

function readDiagnostics(projectRoot, port) {
  return readJsonFile(runtimeDiagnosticsFilePath(projectRoot, port));
}

/** 心跳更新：不追加事件，只刷新存活时间与健康状态（事件列表保持有界）。 */
export function writeRuntimeHeartbeat(projectRoot, port, { launcherPid, childPid, health = null, at } = {}) {
  const file = runtimeDiagnosticsFilePath(projectRoot, port);
  const current = readDiagnostics(projectRoot, port);
  const base = current ?? {
    schemaVersion: SCHEMA_VERSION,
    port: Number(port),
    repoRoot: String(resolve(projectRoot)),
    launch: null,
    launcher: null,
    child: null,
    lastHeartbeatAt: null,
    lastHealth: null,
    events: [],
  };
  const next = {
    ...base,
    launcher: { ...(base.launcher ?? {}), pid: Number(launcherPid ?? base.launcher?.pid) || null },
    child: { ...(base.child ?? {}), pid: Number(childPid ?? base.child?.pid) || null },
    lastHeartbeatAt: at ?? new Date().toISOString(),
    lastHealth: health === null ? (base.lastHealth ?? null) : sanitizeDiagnosticRecord(health),
  };
  writeJsonAtomic(file, next);
  return next;
}

/** 退出记录：正常停机、异常退出、外部终止都写这里；外部强杀时没有记录即为强杀特征。 */
export function recordRuntimeExit(projectRoot, port, payload = {}) {
  const file = runtimeDiagnosticsFilePath(projectRoot, port);
  const current = readDiagnostics(projectRoot, port);
  const base = current ?? {
    schemaVersion: SCHEMA_VERSION,
    port: Number(port),
    repoRoot: String(resolve(projectRoot)),
    launch: null,
    launcher: null,
    child: null,
    lastHeartbeatAt: null,
    lastHealth: null,
    events: [],
  };
  const event = { ...sanitizeDiagnosticRecord(payload), type: payload.type ?? "exit" };
  const next = {
    ...base,
    events: [...(Array.isArray(base.events) ? base.events : []), event].slice(-MAX_EVENTS),
  };
  writeJsonAtomic(file, next);
  return next;
}

/** stop 命令发起前的意图标记：让退出记录能区分「安全停机」与「被外部终止」。 */
export function writeRuntimeStopIntent(projectRoot, port, { targetPid, requestedByPid } = {}) {
  const file = runtimeStopIntentFilePath(projectRoot, port);
  writeJsonAtomic(file, {
    schemaVersion: SCHEMA_VERSION,
    port: Number(port),
    targetPid: Number(targetPid) || null,
    requestedByPid: Number(requestedByPid) || null,
    requestedAt: new Date().toISOString(),
  });
  return file;
}

export function readRuntimeStopIntent(projectRoot, port) {
  return readJsonFile(runtimeStopIntentFilePath(projectRoot, port));
}

export function clearRuntimeStopIntent(projectRoot, port) {
  try {
    unlinkSync(runtimeStopIntentFilePath(projectRoot, port));
    return true;
  } catch {
    return false;
  }
}

/** 退出原因分类：安全停机 / 干净退出（无意图）/ 异常退出 / 被信号终止。 */
export function classifyRuntimeExit({ code, signal, stopIntent } = {}) {
  if (stopIntent) return "managed_stop";
  if (signal) return "child_signaled_" + String(signal);
  if (code === 0) return "child_exit_clean_unrequested";
  return "child_exit_error_" + String(code ?? "unknown");
}

/** 健康探针：只记录状态码与耗时，不记录响应体，避免把业务数据写进诊断文件。 */
export async function probeRuntimeHealth({ host = "127.0.0.1", port, timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  if (typeof fetchImpl !== "function") {
    return { ok: false, status: null, checkedAt, latencyMs: 0, error: "fetch_unavailable" };
  }
  try {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl("http://" + host + ":" + Number(port) + "/api/health", {
        signal: controller?.signal,
        cache: "no-store",
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const status = Number(response.status);
    return {
      ok: response.ok === true,
      status: Number.isFinite(status) ? status : null,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      error: response.ok === true ? null : "http_" + status,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      error: error?.name === "AbortError" ? "timeout" : "unreachable",
    };
  }
}

/** 周期心跳：定时落盘存活时间与健康状态；unref 避免拖住进程退出。 */
export function startRuntimeHeartbeat({
  projectRoot,
  port,
  launcherPid,
  childPid,
  intervalMs = 15000,
  probeHealth = null,
} = {}) {
  let stopped = false;
  let lastHealth = null;
  const interval = Math.max(1000, Number(intervalMs) || 15000);
  const tick = async () => {
    if (stopped) return;
    if (typeof probeHealth === "function") {
      try {
        lastHealth = await probeHealth();
      } catch {
        lastHealth = { ok: false, status: null, checkedAt: new Date().toISOString(), latencyMs: 0, error: "probe_failed" };
      }
    }
    if (stopped) return;
    try {
      writeRuntimeHeartbeat(projectRoot, port, {
        launcherPid,
        childPid,
        health: lastHealth,
        at: new Date().toISOString(),
      });
    } catch {
      // 诊断写入失败不阻断运行
    }
  };
  const timer = setInterval(() => { void tick(); }, interval);
  if (typeof timer.unref === "function") timer.unref();
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    lastHealth() {
      return lastHealth;
    },
  };
}

/** 事后判定：把磁盘证据翻译成可读结论。 */
export function summarizeRuntimeDiagnostics(projectRoot, port, { now = Date.now(), staleAfterMs = 90000 } = {}) {
  const file = runtimeDiagnosticsFilePath(projectRoot, port);
  const data = readDiagnostics(projectRoot, port);
  if (!data) {
    return { status: "no_diagnostics", port: Number(port), diagnosticsFile: file, note: "该实例未启用退出诊断（启动器版本较旧或未写入）" };
  }
  const events = Array.isArray(data.events) ? data.events : [];
  const exitEvent = [...events].reverse().find((event) => event && (event.type === "exit" || event.type === "launcher_signal"));
  const lastHeartbeatAt = data.lastHeartbeatAt ?? null;
  const heartbeatAgeMs = lastHeartbeatAt ? now - Date.parse(lastHeartbeatAt) : null;
  const launcherPid = Number(data.launch?.launcherPid ?? data.launcher?.pid ?? 0);
  const launcherAlive = Number.isInteger(launcherPid) && launcherPid > 0 ? isProcessAlive(launcherPid) : null;
  let status = "unknown";
  let conclusion = "诊断信息不足，无法判定";
  if (exitEvent) {
    if (exitEvent.managedStop === true) {
      status = "stopped_managed";
      conclusion = "由本仓库 stop 命令发起的安全停机";
    } else {
      status = "stopped_unexpected";
      conclusion = "非受管停机：子进程自行退出（见退出码/信号）";
    }
  } else if (launcherAlive === false) {
    // 决定性证据：启动器进程已不存在，且没有留下任何退出记录 → 外部强制终止。
    status = "external_termination_suspected";
    conclusion = "启动器进程已不存在且没有退出记录：疑似被外部终止（强制结束）";
  } else if (lastHeartbeatAt && Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs > staleAfterMs) {
    status = "external_termination_suspected";
    conclusion = "无退出记录且心跳中断：疑似启动器被外部终止";
  } else if (lastHeartbeatAt) {
    status = "running_or_recent";
    conclusion = "心跳仍在更新：实例近期存活";
  }
  return {
    status,
    conclusion,
    port: Number(port),
    diagnosticsFile: file,
    launch: data.launch ?? null,
    launcher: data.launcher ?? null,
    launcherPid: Number.isInteger(launcherPid) && launcherPid > 0 ? launcherPid : null,
    launcherAlive,
    child: data.child ?? null,
    lastHeartbeatAt,
    lastHealth: data.lastHealth ?? null,
    heartbeatAgeMs,
    exit: exitEvent ?? null,
    events: events.slice(-8),
  };
}
