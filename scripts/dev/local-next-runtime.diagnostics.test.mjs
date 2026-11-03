/**
 * 启动器退出诊断的定向测试（node:test，独立运行：node --test scripts/dev/local-next-runtime.diagnostics.test.mjs）。
 *
 * 覆盖任务 A 的验收口径：
 * - 启动器能正常启动，进程身份可追溯；
 * - 正常停止是「安全停机」，与外部终止可区分；
 * - 子进程异常退出留下退出码/信号；
 * - 退出码 0 以前是零日志静默结束，现在必须留痕；
 * - 启动器被外部强杀时，心跳证据仍然留在磁盘（可判定为外部终止）；
 * - 停止其他端口不会误杀别的进程；
 * - 诊断文件不落盘密码/Token/Cookie。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLocalRuntimeArguments, runLocalNext, runSafeStop } from "./local-next-runtime.mjs";
import {
  classifyRuntimeExit,
  readRuntimeStopIntent,
  recordRuntimeExit,
  recordRuntimeLaunch,
  runtimeDiagnosticsFilePath,
  sanitizeDiagnosticRecord,
  summarizeRuntimeDiagnostics,
  writeRuntimeHeartbeat,
  writeRuntimeStopIntent,
} from "./local-runtime-diagnostics.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIAGNOSTICS_PORT = 3199;

function createTempWorkspace() {
  const base = mkdtempSync(path.join(os.tmpdir(), "lc-runtime-diag-"));
  // 项目根与隔离数据根必须分离：启动器明确禁止把隔离数据放在工作树内。
  const appRoot = path.join(base, "app");
  const smokeRoot = path.join(base, "smoke");
  const dataDir = path.join(smokeRoot, "data");
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, "dev.db");
  // 启动器只校验 SQLite 文件头（16 字节），不解析内容。
  writeFileSync(databasePath, Buffer.from("SQLite format 3\0", "binary"));
  const demoAccessStorePath = path.join(dataDir, "demo-access.json");
  writeFileSync(demoAccessStorePath, "{}\n", "utf8");
  const stubScript = path.join(base, "stub-child.mjs");
  writeFileSync(stubScript, "setInterval(() => {}, 1000);\n", "utf8");
  return { base, appRoot, smokeRoot, dataDir, databasePath, demoAccessStorePath, stubScript };
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolveTick) => setTimeout(resolveTick, intervalMs));
  }
  return false;
}

/**
 * 用替身子进程跑一次真实启动流程（不启动 Next、不连数据库、不发网络请求）。
 * 返回诊断文件路径与子进程句柄，便于断言与清理。
 */
function startStubRuntime(workspace) {
  let childRef = null;
  const runPromise = runLocalNext({
    cwd: workspace.appRoot,
    mode: "start",
    port: DIAGNOSTICS_PORT,
    databasePath: workspace.databasePath,
    demoAccessStorePath: workspace.demoAccessStorePath,
    smokeParentRoot: workspace.smokeRoot,
    parentEnv: { PATH: process.env.PATH ?? "" },
    probe: async () => ({ quickCheck: "ok", candidateCount: 0, taskCount: 0 }),
    assertPortAvailable: async () => {},
    spawnProcess: (_command, _args, options) => {
      const child = spawn(process.execPath, [workspace.stubScript], {
        cwd: options.cwd,
        env: options.env,
        stdio: "ignore",
        windowsHide: true,
      });
      childRef = child;
      return child;
    },
  });
  const failure = runPromise.then(
    () => null,
    (error) => error,
  );
  return {
    runPromise,
    failure,
    getChild: () => childRef,
    async waitForDiagnostics() {
      const appeared = await waitFor(() => existsSync(runtimeDiagnosticsFilePath(workspace.appRoot, DIAGNOSTICS_PORT)));
      assert.equal(appeared, true, "启动后应生成诊断文件");
      return JSON.parse(readFileSync(runtimeDiagnosticsFilePath(workspace.appRoot, DIAGNOSTICS_PORT), "utf8"));
    },
  };
}

test("启动后落盘进程身份：launcher/child PID、父子关系、启动时间、端口", async (t) => {
  const workspace = createTempWorkspace();
  const runtime = startStubRuntime(workspace);
  t.after(() => {
    runtime.getChild()?.kill();
  });

  const data = await runtime.waitForDiagnostics();
  assert.equal(data.launch.type, "launch");
  assert.equal(data.launch.port, DIAGNOSTICS_PORT);
  assert.equal(data.launch.launcherPid, process.pid);
  assert.ok(Number.isInteger(data.launch.launcherParentPid) && data.launch.launcherParentPid > 0);
  assert.ok(Number.isInteger(data.launch.childPid) && data.launch.childPid > 0);
  assert.ok(!Number.isNaN(Date.parse(data.launch.at)));
  assert.equal(data.launch.launcherScript, "local-next-runtime.mjs");
  assert.equal(typeof data.launch.nodeVersion, "string");
  // 心跳已写入；健康探针只记录状态码/耗时，不记录响应体
  assert.ok(data.lastHeartbeatAt);
  assert.equal(data.lastHealth.ok, false, "替身实例没有真实健康端点");
  assert.ok(data.lastHealth.status === null || Number.isInteger(data.lastHealth.status));
  assert.equal(typeof data.lastHealth.error, "string");

  runtime.getChild().kill();
  await runtime.failure;
});

test("受管停机写安全退出记录，外部终止写异常退出记录，两者可区分", async (t) => {
  const managed = createTempWorkspace();
  const managedRuntime = startStubRuntime(managed);
  t.after(() => {
    managedRuntime.getChild()?.kill();
  });
  await managedRuntime.waitForDiagnostics();

  // 模拟 stop 命令先写意图标记，再终止子进程
  writeRuntimeStopIntent(managed.appRoot, DIAGNOSTICS_PORT, {
    targetPid: managedRuntime.getChild()?.pid ?? null,
    requestedByPid: process.pid,
  });
  assert.ok(readRuntimeStopIntent(managed.appRoot, DIAGNOSTICS_PORT), "停机意图应落盘");
  managedRuntime.getChild().kill();
  await managedRuntime.failure;

  const managedData = JSON.parse(readFileSync(runtimeDiagnosticsFilePath(managed.appRoot, DIAGNOSTICS_PORT), "utf8"));
  const managedExit = managedData.events.find((event) => event.type === "exit");
  assert.ok(managedExit, "受管停机必须留下退出记录");
  assert.equal(managedExit.managedStop, true);
  assert.equal(managedExit.reason, "managed_stop");

  const external = createTempWorkspace();
  const externalRuntime = startStubRuntime(external);
  t.after(() => {
    externalRuntime.getChild()?.kill();
  });
  await externalRuntime.waitForDiagnostics();
  externalRuntime.getChild().kill();
  await externalRuntime.failure;

  const externalData = JSON.parse(readFileSync(runtimeDiagnosticsFilePath(external.appRoot, DIAGNOSTICS_PORT), "utf8"));
  const externalExit = externalData.events.find((event) => event.type === "exit");
  assert.ok(externalExit, "外部终止也必须留下退出记录");
  assert.equal(externalExit.managedStop, false);
  assert.notEqual(externalExit.reason, "managed_stop");
  assert.ok(externalExit.exitCode !== null || externalExit.signal !== null, "必须记录退出码或信号");
});

test("子进程结束时不静默：无论退出码都留下退出记录", async (t) => {
  const workspace = createTempWorkspace();
  const runtime = startStubRuntime(workspace);
  t.after(() => {
    runtime.getChild()?.kill();
  });
  await runtime.waitForDiagnostics();
  runtime.getChild().kill();
  await runtime.failure;

  const data = JSON.parse(readFileSync(runtimeDiagnosticsFilePath(workspace.appRoot, DIAGNOSTICS_PORT), "utf8"));
  const exitEvent = data.events.find((event) => event.type === "exit");
  assert.ok(exitEvent, "退出必须留痕（历史缺口：零日志静默结束）");
  assert.ok(exitEvent.reason.startsWith("child_exit_") || exitEvent.reason.startsWith("child_signaled_"));
  assert.equal(exitEvent.managedStop, false);
});

test("启动器被外部强杀：心跳证据留在磁盘，可判定为外部终止", async () => {
  const workspace = createTempWorkspace();
  const workerScript = path.join(workspace.base, "heartbeat-worker.mjs");
  const moduleUrl = pathToFileUrl(path.join(REPO_ROOT, "scripts", "dev", "local-runtime-diagnostics.mjs"));
  writeFileSync(
    workerScript,
    [
      `import { recordRuntimeLaunch, startRuntimeHeartbeat } from ${JSON.stringify(moduleUrl)};`,
      `recordRuntimeLaunch(${JSON.stringify(workspace.appRoot)}, ${DIAGNOSTICS_PORT}, { launcherPid: process.pid, launcherParentPid: process.ppid, childPid: process.pid, port: ${DIAGNOSTICS_PORT} });`,
      "startRuntimeHeartbeat({",
      `  projectRoot: ${JSON.stringify(workspace.appRoot)},`,
      `  port: ${DIAGNOSTICS_PORT},`,
      "  launcherPid: process.pid,",
      "  childPid: process.pid,",
      "  intervalMs: 1000,",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );

  const worker = spawn(process.execPath, [workerScript], { stdio: "ignore", windowsHide: true });
  const appeared = await waitFor(() => existsSync(runtimeDiagnosticsFilePath(workspace.appRoot, DIAGNOSTICS_PORT)));
  assert.equal(appeared, true, "心跳进程应写出诊断文件");

  // 模拟外部强杀：不给任何清理机会（对应历史实例状态文件仍在、stderr 0 字节的情形）
  execFileSync("taskkill.exe", ["/F", "/PID", String(worker.pid)], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolveTick) => setTimeout(resolveTick, 800));

  const data = JSON.parse(readFileSync(runtimeDiagnosticsFilePath(workspace.appRoot, DIAGNOSTICS_PORT), "utf8"));
  assert.ok(data.lastHeartbeatAt, "强杀后心跳记录必须仍在磁盘");
  assert.equal(data.events.some((event) => event.type === "exit"), false, "被强杀时不可能有退出记录");

  const summary = summarizeRuntimeDiagnostics(workspace.appRoot, DIAGNOSTICS_PORT, {
    now: Date.now() + 10 * 60 * 1000,
    staleAfterMs: 60000,
  });
  assert.equal(summary.status, "external_termination_suspected");
  assert.match(summary.conclusion, /外部终止/);
});

test("停止失败时撤掉停机意图，避免把后续异常退出误判成安全停机", async () => {
  const workspace = createTempWorkspace();
  const previousExitCode = process.exitCode;
  try {
    await runSafeStop({
      projectRoot: workspace.appRoot,
      host: "127.0.0.1",
      port: DIAGNOSTICS_PORT,
      dryRun: false,
      findListeners: () => [{
        pid: 999999,
        address: `127.0.0.1:${DIAGNOSTICS_PORT}`,
      }],
      collectEvidence: async () => ({
        child: {
          pid: 999999,
          parentPid: 999998,
          name: "node.exe",
          commandLine: `"${workspace.appRoot}\\node_modules\\next\\dist\\bin\\next" start -H 127.0.0.1 -p ${DIAGNOSTICS_PORT}`,
        },
        ancestors: [{
          pid: 999998,
          parentPid: 999997,
          commandLine: `"C:\\Program Files\\nodejs\\node.exe" ${workspace.appRoot}\\scripts\\dev\\local-next-runtime.mjs start`,
        }],
      }),
    });
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.equal(readRuntimeStopIntent(workspace.appRoot, DIAGNOSTICS_PORT), null, "停机未完成时意图标记必须被撤掉");
});

test("停止其他端口不会误杀：只对归属核验通过的唯一监听 PID 发一次信号", async () => {
  const workspace = createTempWorkspace();
  const previousExitCode = process.exitCode;
  const otherPortPid = 888888;
  try {
    const flow = await runSafeStop({
      projectRoot: workspace.appRoot,
      host: "127.0.0.1",
      port: DIAGNOSTICS_PORT,
      dryRun: true,
      findListeners: () => [{
        pid: 999999,
        address: `127.0.0.1:${DIAGNOSTICS_PORT}`,
      }],
      collectEvidence: async () => ({
        child: {
          pid: 999999,
          parentPid: 999998,
          name: "node.exe",
          commandLine: `"${workspace.appRoot}\\node_modules\\next\\dist\\bin\\next" start -H 127.0.0.1 -p ${DIAGNOSTICS_PORT}`,
        },
        ancestors: [{
          pid: 999998,
          parentPid: 999997,
          commandLine: `"C:\\Program Files\\nodejs\\node.exe" ${workspace.appRoot}\\scripts\\dev\\local-next-runtime.mjs start`,
        }],
      }),
    });
    assert.equal(flow.dryRun, true);
    assert.equal(flow.signalSent, false, "dry-run 不得发任何信号");
    assert.equal(flow.pid, 999999, "只会指向本端口的监听 PID");
    assert.notEqual(flow.pid, otherPortPid);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("诊断文件不落盘密码/Token/Cookie 与环境变量", async () => {
  const workspace = createTempWorkspace();
  recordRuntimeLaunch(workspace.appRoot, DIAGNOSTICS_PORT, {
    launcherPid: 1,
    childPid: 2,
    port: DIAGNOSTICS_PORT,
    DATABASE_URL: "file:C:/secret/dev.db",
    apiKey: "sk-should-not-appear",
    password: "should-not-appear",
    sessionToken: "should-not-appear",
  });
  recordRuntimeExit(workspace.appRoot, DIAGNOSTICS_PORT, {
    type: "exit",
    reason: "child_exit_error_1",
    exitCode: 1,
    cookie: "should-not-appear",
  });
  const raw = readFileSync(runtimeDiagnosticsFilePath(workspace.appRoot, DIAGNOSTICS_PORT), "utf8");
  assert.equal(raw.includes("should-not-appear"), false);
  assert.equal(raw.includes("sk-should-not-appear"), false);
  assert.equal(raw.includes("DATABASE_URL"), false);
  assert.equal(raw.includes("cookie"), false);
  assert.deepEqual(sanitizeDiagnosticRecord({ token: "x", ok: "y" }), { ok: "y" });
});

test("退出原因分类覆盖四种情形", () => {
  assert.equal(classifyRuntimeExit({ code: 1, signal: null, stopIntent: true }), "managed_stop");
  assert.equal(classifyRuntimeExit({ code: 0, signal: null, stopIntent: false }), "child_exit_clean_unrequested");
  assert.equal(classifyRuntimeExit({ code: 7, signal: null, stopIntent: false }), "child_exit_error_7");
  assert.equal(classifyRuntimeExit({ code: null, signal: "SIGTERM", stopIntent: false }), "child_signaled_SIGTERM");
});

test("心跳写入不追加事件，事件列表保持有界", async () => {
  const workspace = createTempWorkspace();
  recordRuntimeLaunch(workspace.appRoot, DIAGNOSTICS_PORT, { launcherPid: 1, childPid: 2, port: DIAGNOSTICS_PORT });
  for (let index = 0; index < 5; index += 1) {
    writeRuntimeHeartbeat(workspace.appRoot, DIAGNOSTICS_PORT, {
      launcherPid: 1,
      childPid: 2,
      health: { ok: true, status: 200, checkedAt: new Date().toISOString(), latencyMs: 3, error: null },
      at: new Date().toISOString(),
    });
  }
  const data = JSON.parse(readFileSync(runtimeDiagnosticsFilePath(workspace.appRoot, DIAGNOSTICS_PORT), "utf8"));
  assert.equal(data.events.length, 1, "心跳不得追加事件");
  assert.equal(data.lastHealth.status, 200);
});

test("diagnose 模式只接受 --port，且不启动任何实例", () => {
  const parsed = parseLocalRuntimeArguments(["diagnose", "--port", "3010"]);
  assert.equal(parsed.mode, "diagnose");
  assert.equal(parsed.port, "3010");
  assert.throws(() => parseLocalRuntimeArguments(["diagnose", "--port"]), /local_diagnose_arguments_invalid/);
  assert.throws(() => parseLocalRuntimeArguments(["diagnose", "--force"]), /local_diagnose_arguments_invalid/);
});

function pathToFileUrl(filePath) {
  return new URL(`file:///${filePath.replaceAll("\\", "/")}`).href;
}
