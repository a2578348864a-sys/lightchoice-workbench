import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalRuntimeConfig,
  normalizeEvidenceStorePath,
  normalizePathText,
  normalizeCommandLineText,
  matchesNextStartEntry,
  matchesNextRuntimeEntry,
  matchesNextServerWorkerEntry,
  matchesRuntimeLauncher,
  deriveRepoRootFromNextEntry,
  runSafeStop,
  matches3011FixtureLauncher,
  validateRuntimeStateData,
  describeRuntimeState,
  decideSafeStop,
  executeConfirmedStop,
  writeRuntimeStateFileAtomically,
  deleteRuntimeStateFileIfOwned,
  parseLocalRuntimeArguments,
  isMainEntry,
  runLocalNext,
  collectOwnershipEvidence,
} from "./local-next-runtime.mjs";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/* ── fixtures ─────────────────────────────────────────────── */
const TARGET = { host: "127.0.0.1", port: 3005, repoRoot: REPO_ROOT };

const CHILD_CMD_MATCH =
  '"' + REPO_ROOT + '\\node_modules\\next\\dist\\bin\\next" start -H 127.0.0.1 -p 3005';
const LAUNCHER_CMD_MATCH =
  '"C:\\Program Files\\nodejs\\node.exe" scripts/dev/local-next-runtime.mjs start';
const LAUNCHER_CMD_FOREIGN =
  '"C:\\Program Files\\nodejs\\node.exe" something-else-entirely';

function baseEvidence(overrides = {}) {
  return {
    listeners: [{ pid: 4242, address: "127.0.0.1", port: 3005 }],
    child: { pid: 4242, name: "node.exe", commandLine: CHILD_CMD_MATCH },
    ancestors: [{ pid: 9536, commandLine: LAUNCHER_CMD_MATCH }],
    ...overrides,
  };
}
function absentState() { return { status: "absent" }; }
function validState(dataOverrides = {}) {
  return {
    status: "valid",
    data: {
      schemaVersion: 1, repoRoot: REPO_ROOT, host: "127.0.0.1", port: 3005,
      launcherPid: 9536, childPid: 4242, startedAt: "2026-01-01T00:00:00.000Z",
      ...dataOverrides,
    },
  };
}
function inputOf(overrides = {}) {
  return {
    target: overrides.target ?? TARGET,
    state: overrides.state ?? absentState(),
    evidence: overrides.evidence ?? baseEvidence(),
    dryRun: overrides.dryRun ?? false,
  };
}

/* ── 1..11,9 行为决策 ─────────────────────────────────────── */
test("P9 fixture wrapper needs exact entry, manifest, valid state and port 3011", () => {
  const command = 'node scripts/e2e/start-3011.mjs --fixture-manifest docs/reports/fixture.json';
  assert.equal(matches3011FixtureLauncher(command, REPO_ROOT), true);
  assert.equal(matches3011FixtureLauncher('node D:/other/scripts/e2e/start-3011.mjs --fixture-manifest other.json', REPO_ROOT), false);
  assert.equal(matches3011FixtureLauncher('node scripts/e2e/start-3011.mjs', REPO_ROOT), false);
  const target = { ...TARGET, port: 3011 }, evidence = baseEvidence({ listeners: [{ pid: 4242, address: "127.0.0.1", port: 3011 }], ancestors: [{ pid: 9536, commandLine: command }] });
  assert.equal(decideSafeStop({ target, evidence, state: validState({ port: 3011 }) }).decision, "proceed");
  assert.equal(decideSafeStop({ target, evidence, state: absentState() }).decision, "reject");
  assert.equal(decideSafeStop({ target, evidence, state: validState({ port: 3011, childPid: 3333 }) }).decision, "reject");
  assert.equal(decideSafeStop(inputOf({ evidence: baseEvidence({ ancestors: [{ pid: 9536, commandLine: command }] }), state: validState() })).decision, "reject");
});
test("1 无监听者：decision=none 且不发信号", () => {
  const d = decideSafeStop(inputOf({ evidence: baseEvidence({ listeners: [] }) }));
  assert.equal(d.decision, "none");
  assert.equal(d.signalSent, false);
  assert.equal(d.wouldSignalPid, null);
});

test("2 外部/陌生监听者：拒绝且无归属", () => {
  const ev = baseEvidence({
    child: { pid: 4242, name: "chrome.exe", commandLine: "C:\\other\\chrome.exe --x" },
    ancestors: [{ pid: 999, commandLine: LAUNCHER_CMD_FOREIGN }],
  });
  const d = decideSafeStop(inputOf({ evidence: ev }));
  assert.equal(d.decision, "reject");
  assert.equal(d.ownershipVerified, false);
  assert.equal(d.signalSent, false);
});

test("2b 子命令指向其他仓库 next → 拒绝", () => {
  const ev = baseEvidence({
    child: { pid: 4242, name: "node.exe", commandLine: '"D:\\other-repo\\node_modules\\next\\dist\\bin\\next" start' },
  });
  const d = decideSafeStop(inputOf({ evidence: ev }));
  assert.equal(d.decision, "reject");
});

test("Next 16 dev listener worker：验证 worker → 当前仓库 Next CLI → local runtime 的进程链", () => {
  const target = { ...TARGET, port: 3018 };
  const nextCliCommand = 'C:\\Program Files\\nodejs\\node.exe ' + REPO_ROOT + '\\node_modules\\next\\dist\\bin\\next dev -H 127.0.0.1 -p 3018';
  const workerCommand = 'C:\\Program Files\\nodejs\\node.exe ' + REPO_ROOT + '\\node_modules\\next\\dist\\server\\lib\\start-server.js';
  const launcherCommand = '"C:\\Program Files\\nodejs\\node.exe" scripts/dev/local-next-runtime.mjs dev --port 3018';
  const evidence = {
    listeners: [{ pid: 8904, address: "127.0.0.1", port: 3018 }],
    child: { pid: 8904, parentPid: 23640, name: "node.exe", commandLine: workerCommand },
    ancestors: [
      { pid: 23640, parentPid: 39684, commandLine: nextCliCommand },
      { pid: 39684, parentPid: 2316, commandLine: launcherCommand },
      { pid: 2316, parentPid: 1000, commandLine: "powershell.exe" },
    ],
  };
  const state = validState({ port: 3018, launcherPid: 39684, childPid: 23640 });
  const decision = decideSafeStop({ target, state, evidence, dryRun: true });
  assert.equal(matchesNextRuntimeEntry(nextCliCommand, REPO_ROOT), true);
  assert.equal(matchesNextStartEntry(nextCliCommand, REPO_ROOT), false);
  assert.equal(matchesNextServerWorkerEntry(workerCommand, REPO_ROOT), true);
  assert.equal(decision.decision, "proceed");
  assert.equal(decision.ownershipVerified, true);
  assert.equal(decision.wouldSignalPid, 8904, "only the live listener worker is signaled");
  assert.equal(decision.launcherPid, 39684);
});

test("Next 16 dev worker rejects mismatched manifest child PID, foreign repo, and broken parent chain", () => {
  const target = { ...TARGET, port: 3018 };
  const workerCommand = REPO_ROOT + "\\node_modules\\next\\dist\\server\\lib\\start-server.js";
  const nextCliCommand = REPO_ROOT + "\\node_modules\\next\\dist\\bin\\next dev -H 127.0.0.1 -p 3018";
  const launcherCommand = "node scripts/dev/local-next-runtime.mjs dev --port 3018";
  const evidence = {
    listeners: [{ pid: 8904, address: "127.0.0.1", port: 3018 }],
    child: { pid: 8904, parentPid: 23640, name: "node.exe", commandLine: workerCommand },
    ancestors: [
      { pid: 23640, parentPid: 39684, commandLine: nextCliCommand },
      { pid: 39684, parentPid: 2316, commandLine: launcherCommand },
    ],
  };
  const goodState = validState({ port: 3018, launcherPid: 39684, childPid: 23640 });
  const wrongChildState = validState({ port: 3018, launcherPid: 39684, childPid: 8904 });
  const wrongChild = decideSafeStop({ target, state: wrongChildState, evidence });
  assert.equal(wrongChild.decision, "reject");
  assert.ok(wrongChild.reasons.includes("state_child_pid_mismatch"));

  const foreignWorker = decideSafeStop({
    target, state: goodState,
    evidence: { ...evidence, child: { ...evidence.child, commandLine: "D:\\other-repo\\node_modules\\next\\dist\\server\\lib\\start-server.js" } },
  });
  assert.equal(foreignWorker.decision, "reject");
  assert.ok(foreignWorker.reasons.includes("child_next_entry_mismatch"));

  const brokenParent = decideSafeStop({
    target, state: goodState,
    evidence: { ...evidence, child: { ...evidence.child, parentPid: 9999 } },
  });
  assert.equal(brokenParent.decision, "reject");
  assert.ok(brokenParent.reasons.includes("listener_next_parent_mismatch"));
});

test("3 repoRoot 不匹配（valid 状态来自其他根）→ 拒绝", () => {
  const st = validState({ repoRoot: "D:/somewhere-else" });
  const d = decideSafeStop(inputOf({ state: st }));
  assert.equal(d.decision, "reject");
  assert.ok(d.reasons.some((r) => /repo_root/.test(r)));
});

test("4 损坏状态文件 → 拒绝且不出信号目标", () => {
  const st = { status: "invalid", reasons: ["json_parse_failed"] };
  const d = decideSafeStop(inputOf({ state: st }));
  assert.equal(d.decision, "reject");
  assert.equal(d.wouldSignalPid, null);
});

test("5 listener PID 与状态文件 childPid 不一致 → 拒绝", () => {
  const st = validState({ childPid: 7777 });
  const d = decideSafeStop(inputOf({ state: st }));
  assert.equal(d.decision, "reject");
  assert.ok(d.reasons.some((r) => /child_pid/.test(r)));
});

test("6 严格验证的 owned listener → 决策 proceed，目标仅为该 listener PID", () => {
  const d = decideSafeStop(inputOf({ state: validState(), dryRun: false }));
  assert.equal(d.decision, "proceed");
  assert.equal(d.ownershipVerified, true);
  assert.equal(d.wouldSignalPid, 4242);
  assert.equal(d.launcherPid, 9536);
});

test("10 legacy（无状态文件）实时三重匹配 → dry-run 通过", () => {
  const d = decideSafeStop(inputOf({ dryRun: true }));
  assert.equal(d.decision, "proceed");
  assert.equal(d.ownershipVerified, true);
});

test("10b legacy dry-run 结果面：signalSent=false", () => {
  const d = decideSafeStop(inputOf({ dryRun: true }));
  assert.equal(d.signalSent, false);
});

test("11a legacy 缺父链证据 → 拒绝", () => {
  const ev = baseEvidence({ ancestors: [] });
  const d = decideSafeStop(inputOf({ evidence: ev }));
  assert.equal(d.decision, "reject");
});

test("valid manifest + exact repo Next start listener permits stopping an orphaned managed child", () => {
  const evidence = {
    listeners: [{ pid: 4242, address: "127.0.0.1", port: 3005 }],
    child: { pid: 4242, parentPid: 9536, name: "node.exe", commandLine: CHILD_CMD_MATCH },
    ancestors: [{ pid: 9536, commandLine: "powershell.exe -NoProfile" }],
  };
  const d = decideSafeStop(inputOf({ state: validState(), evidence, dryRun: true }));
  assert.equal(d.decision, "proceed");
  assert.equal(d.ownershipVerified, true);
  assert.equal(d.orphanedManagedStart, true);
  assert.equal(d.wouldSignalPid, 4242);
  assert.equal(d.launcherPid, null, "the absent launcher is reported accurately");
});

test("orphan recovery rejects a parent PID that does not match the manifest", () => {
  const evidence = {
    listeners: [{ pid: 4242, address: "127.0.0.1", port: 3005 }],
    child: { pid: 4242, parentPid: 9536, name: "node.exe", commandLine: CHILD_CMD_MATCH },
    ancestors: [{ pid: 9999, commandLine: "powershell.exe -NoProfile" }],
  };
  const d = decideSafeStop(inputOf({ state: validState(), evidence, dryRun: true }));
  assert.equal(d.decision, "reject");
  assert.equal(d.orphanedManagedStart, false);
  assert.ok(d.reasons.includes("runtime_launcher_missing"));
});

test("orphan recovery rejects a Next start command bound to a different port", () => {
  const evidence = {
    listeners: [{ pid: 4242, address: "127.0.0.1", port: 3005 }],
    child: { pid: 4242, parentPid: 9536, name: "node.exe", commandLine: CHILD_CMD_MATCH.replace("-p 3005", "-p 3010") },
    ancestors: [{ pid: 9536, commandLine: "powershell.exe -NoProfile" }],
  };
  const d = decideSafeStop(inputOf({ state: validState(), evidence, dryRun: true }));
  assert.equal(d.decision, "reject");
  assert.equal(d.ownershipVerified, false);
  assert.equal(d.orphanedManagedStart, false);
  assert.ok(d.reasons.includes("runtime_launcher_missing"));
});

test("11b legacy 缺 Next 入口路径证据 → 拒绝", () => {
  const ev = baseEvidence({
    child: { pid: 4242, name: "node.exe", commandLine: "node server.js -p 3005" },
  });
  const d = decideSafeStop(inputOf({ evidence: ev }));
  assert.equal(d.decision, "reject");
});

/* ── executeConfirmedStop（信号一次/超时/干跑） ──────────────── */
function fakeIo(existing = true) {
  const killCalls = [];
  let listening = existing;
  const io = {
    killCalls,
    kill(pid, sig) { killCalls.push({ pid, sig }); listening = false; return true; },
    async isListening() { return listening; },
  };
  return io;
}

test("6b executeConfirmedStop：仅一次温和信号到精确 child PID", async () => {
  const decision = decideSafeStop(inputOf({}));
  const io = fakeIo(true);
  const result = await executeConfirmedStop(decision, { dryRun: false, kill: io.kill, isListening: io.isListening, waitTimeoutMs: 200, pollIntervalMs: 20 });
  assert.equal(io.killCalls.length, 1);
  assert.deepEqual(io.killCalls[0], { pid: 4242, sig: "SIGTERM" });
  assert.equal(result.stopped, true);
  assert.equal(result.released, true);
});

test("7 端口按时释放 → 成功", async () => {
  const decision = decideSafeStop(inputOf({}));
  const io = fakeIo(true);
  const result = await executeConfirmedStop(decision, { dryRun: false, kill: io.kill, isListening: io.isListening, waitTimeoutMs: 300, pollIntervalMs: 10 });
  assert.equal(result.stopped, true);
});

test("8 端口未释放 → 非零失败且没有第二次/强制终止", async () => {
  const decision = decideSafeStop(inputOf({}));
  const killCalls = [];
  const io = {
    kill(pid, sig) { killCalls.push({ pid, sig }); },
    async isListening() { return true; },
  };
  const result = await executeConfirmedStop(decision, { dryRun: false, kill: io.kill, isListening: io.isListening, waitTimeoutMs: 120, pollIntervalMs: 30 });
  assert.equal(result.stopped, false);
  assert.equal(killCalls.length, 1);
  assert.ok(result.error);
});

test("9 dry-run：ownership 可为 true 但调用数为 0、signalSent=false", async () => {
  const decision = decideSafeStop(inputOf({ dryRun: true }));
  assert.equal(decision.ownershipVerified, true);
  const io = fakeIo(true);
  const result = await executeConfirmedStop(decision, { dryRun: true, kill: io.kill, isListening: io.isListening, waitTimeoutMs: 100, pollIntervalMs: 10 });
  assert.equal(io.killCalls.length, 0);
  assert.equal(result.signalSent, false);
});

test("reject 的决策永远不被执行信号", async () => {
  const bad = decideSafeStop(inputOf({ evidence: baseEvidence({ ancestors: [] }) }));
  const io = fakeIo(true);
  await assert.rejects(() => executeConfirmedStop(bad, { dryRun: false, kill: io.kill, isListening: io.isListening }));
  assert.equal(io.killCalls.length, 0);
});

/* ── 状态文件 I/O 与内容合同 ─────────────────────────────── */
test("12 start 状态文件字段最小集：不含 env/DATABASE_URL/API key/token", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "safe-stop-test-"));
  try {
    const data = {
      schemaVersion: 1, repoRoot: REPO_ROOT, host: "127.0.0.1", port: 35555,
      launcherPid: process.pid, childPid: 4321, startedAt: "2026-08-27T00:00:00.000Z",
      DEEPSEEK_API_KEY: "SHOULD_NOT_PERSIST", DATABASE_URL: "file:leak.db", NODE_ENV: "production",
    };
    await writeRuntimeStateFileAtomically(dir, 35555, data);
    const file = path.join(dir, ".next", "local-runtime-35555.json");
    assert.equal(existsSync(file), true);
    const raw = readFileSync(file, "utf8");
    assert.match(raw, /"schemaVersion"\s*:\s*1/);
    for (const banned of ["DEEPSEEK_API_KEY", "DATABASE_URL", "NODE_ENV", "API_KEY", "TOKEN"]) {
      assert.ok(!raw.includes(banned), "状态文件不得包含 " + banned);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("12a 状态文件可审计 EvidenceStore 路径，但不落盘环境变量", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "safe-stop-evidence-store-"));
  try {
    const evidenceStorePath = path.join(dir, "canonical-source-layer-store");
    await writeRuntimeStateFileAtomically(dir, 35558, {
      schemaVersion: 1, repoRoot: REPO_ROOT, host: "127.0.0.1", port: 35558,
      launcherPid: process.pid, childPid: 4321, startedAt: "2026-08-27T00:00:00.000Z",
      evidenceStorePath,
      SOURCE_LAYER_STORE_DIR: "SHOULD_NOT_PERSIST",
    });
    const file = path.join(dir, ".next", "local-runtime-35558.json");
    const raw = readFileSync(file, "utf8");
    assert.match(raw, /"evidenceStorePath"/);
    assert.ok(!raw.includes("SOURCE_LAYER_STORE_DIR"));
    assert.equal(validateRuntimeStateData(JSON.parse(raw), { ...TARGET, port: 35558, evidenceStorePath }).ok, true);
    assert.equal(normalizeEvidenceStorePath(evidenceStorePath), evidenceStorePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("12b schemaVersion 缺失/错误 → 校验失败", () => {
  const bad = { repoRoot: REPO_ROOT, host: "127.0.0.1", port: 3005, launcherPid: 1, childPid: 2, startedAt: "2026-01-01T00:00:00Z" };
  const r = validateRuntimeStateData(bad, TARGET);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /schema_version/.test(x)));
});

test("13 清理仅删除属于当前 launcher/child 的状态记录", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "safe-stop-test-"));
  try {
    const mine = { schemaVersion: 1, repoRoot: REPO_ROOT, host: "127.0.0.1", port: 35556, launcherPid: process.pid, childPid: 1234, startedAt: "2026-08-27T00:00:00.000Z" };
    await writeRuntimeStateFileAtomically(dir, 35556, mine);
    await deleteRuntimeStateFileIfOwned(dir, 35556, { launcherPid: process.pid, childPid: 1234 });
    assert.equal(existsSync(path.join(dir, ".next", "local-runtime-35556.json")), false);

    await writeRuntimeStateFileAtomically(dir, 35557, mine);
    await deleteRuntimeStateFileIfOwned(dir, 35557, { launcherPid: process.pid, childPid: 99999 });
    assert.equal(existsSync(path.join(dir, ".next", "local-runtime-35557.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("13b describeRuntimeState：absent / valid / invalid 三态", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "safe-stop-test-"));
  try {
    const absent = describeRuntimeState(dir, 40001, TARGET);
    assert.equal(absent.status, "absent");
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "local-runtime-40002.json"), "{not json!!", "utf8");
    const invalid = describeRuntimeState(dir, 40002, TARGET);
    assert.equal(invalid.status, "invalid");
    const goodData = { schemaVersion: 1, repoRoot: REPO_ROOT, host: "127.0.0.1", port: 3005, launcherPid: 1, childPid: 2, startedAt: "2026-01-01T00:00:00Z" };
    await writeRuntimeStateFileAtomically(dir, 3005, goodData);
    const valid = describeRuntimeState(dir, 3005, TARGET);
    assert.equal(valid.status, "valid");
    assert.deepEqual(valid.data.childPid, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 解析回归 + main-entry + 归一化辅助 ─────────────────── */
test("14 start/dev/check 解析零回归", () => {
  const s = parseLocalRuntimeArguments(["start"]);
  assert.equal(s.mode, "start"); assert.equal(s.checkOnly, false); assert.equal(String(s.port), process.env.PORT || "3010");
  const dv = parseLocalRuntimeArguments(["dev"]);
  assert.equal(dv.mode, "dev");
  const ck = parseLocalRuntimeArguments(["check"]);
  assert.equal(ck.checkOnly, true); assert.equal(ck.mode, "start");
  const sp = parseLocalRuntimeArguments(["start", "--port", "3006"]);
  assert.equal(String(sp.port), "3006");
  assert.throws(() => buildLocalRuntimeConfig({ ...parseLocalRuntimeArguments(["nonsense"]), cwd: REPO_ROOT }), /start, dev or stop/);
});

test("14b stop 解析：默认非 dry-run；--dry-run 生效；--port 生效", () => {
  const a = parseLocalRuntimeArguments(["stop"]);
  assert.equal(a.mode, "stop"); assert.equal(a.dryRun, false); assert.equal(String(a.port), process.env.PORT || "3010");
  const b = parseLocalRuntimeArguments(["stop", "--dry-run"]);
  assert.equal(b.dryRun, true);
  const c = parseLocalRuntimeArguments(["stop", "--port", "3010", "--dry-run"]);
  assert.equal(c.dryRun, true); assert.equal(String(c.port), "3010");
  assert.throws(() => parseLocalRuntimeArguments(["stop", "--database-path", "x.db"]), /local_stop_arguments_invalid/);
});

test("15 静态合同：禁词扫描", async () => {
  const src = readFileSync(path.resolve(REPO_ROOT, "scripts/dev/local-next-runtime.mjs"), "utf8");
  assert.ok(!/taskkill/i.test(src));
  assert.ok(!/Stop-Process/i.test(src));
  assert.ok(!/SIGKILL/i.test(src));
  assert.ok(!/\/T\s+\/F/i.test(src));
});

test("15b 主入口守卫：导入运行器不会启动服务（isMainEntry 判定）", async () => {
  assert.equal(isMainEntry("D:/x/scripts/dev/local-next-runtime.mjs", "D:/y/test-runner.mjs"), false);
  assert.equal(isMainEntry("D:/x/scripts/dev/local-next-runtime.mjs", "D:/x/scripts/dev/local-next-runtime.mjs"), true);
});

test("路径归一化辅助：斜杠/大小写/引号/尾随分隔符", () => {
  assert.equal(normalizePathText('D:\\Repo\\A'), normalizePathText("d:/repo/a"));
  assert.equal(normalizePathText('"D:/Repo/A/"'), normalizePathText("d:/repo/a"));
});

test("16 接线：stop 模式 dry-run + 注入归属证据 → proceed 但零信号（dry-run 必须真正传达到执行层）", async () => {
  const flow = await runLocalNext({
    cwd: REPO_ROOT,
    mode: "stop",
    port: "39901",
    dryRun: true,
    parentEnv: {},
    findListeners: () => [{ address: "127.0.0.1:39901", pid: 4242 }],
    collectEvidence: async () => ({ child: { pid: 4242, name: "node.exe", commandLine: CHILD_CMD_MATCH }, ancestors: [{ pid: 9536, commandLine: LAUNCHER_CMD_MATCH }] }),
  });
  assert.equal(flow.dryRun, true);
  assert.equal(flow.signalSent, false);
  assert.equal(flow.stopped, false);
  assert.equal(flow.pid, 4242);
});

test("16b 接线：非 dry-run 但证据外部 → 拒绝且返回 null（无任何信号副作用）", async () => {
  const beforeExit = process.exitCode;
  const result = await runLocalNext({
    cwd: REPO_ROOT,
    mode: "stop",
    port: "39902",
    dryRun: false,
    parentEnv: {},
    findListeners: () => [{ address: "127.0.0.1:39902", pid: 4242 }],
    collectEvidence: async () => ({
      child: { pid: 4242, name: "chrome.exe", commandLine: "C:\\other\\chrome.exe --x" },
      ancestors: [{ pid: 999, commandLine: LAUNCHER_CMD_FOREIGN }],
    }),
  });
  if (process.exitCode === 1) process.exitCode = beforeExit;
  assert.equal(result, null);
});


test("17 真实 PowerShell 5.1 管道：中文路径 CommandLine 无损返回（无 U+FFFD）", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "safe-stop-enc-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "D:\\测试\\电商工具\\node_modules\\next\\dist\\bin\\next"], {
    cwd: dir,
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
    const evidence = await collectOwnershipEvidence(child.pid);
    assert.equal(evidence.child?.pid, child.pid, "child.pid 必须与自建进程一致");
    assert.equal(evidence.child?.parentPid, process.pid, "parentPid 必须是本测试进程");
    assert.equal(String(evidence.child?.name ?? "").toLowerCase().replace(/\.exe$/, ""), "node");
    const commandLine = String(evidence.child?.commandLine ?? "");
    assert.ok(commandLine.includes("测试"), "中文片段『测试』必须保留: " + JSON.stringify(commandLine));
    assert.ok(commandLine.includes("电商工具"), "中文片段『电商工具』必须保留: " + JSON.stringify(commandLine));
    assert.ok(commandLine.includes("node_modules"), "路径片段必须保留: " + JSON.stringify(commandLine));
    assert.ok(!/\uFFFD/.test(commandLine), "不得包含 U+FFFD 替换字符: " + JSON.stringify(commandLine));
  } finally {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5000)),
    ]);
    assert.equal(exited, true, "测试自建子进程必须在 5s 内温和退出");
  }
});

/* ── 12. 从监听进程入口反推仓库根（stop 的 cwd 回退） ──────── */

const BS = String.fromCharCode(92);
const toWin = (value) => String(value).replaceAll("/", BS);

test("deriveRepoRootFromNextEntry extracts a local absolute repo root only", () => {
  const cli = "node D:/ws/proj/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3010";
  assert.equal(deriveRepoRootFromNextEntry(cli), "D:/ws/proj");
  assert.equal(deriveRepoRootFromNextEntry(toWin(cli)), "D:/ws/proj");
  assert.equal(
    deriveRepoRootFromNextEntry(toWin('"C:/Program Files/nodejs/node.exe" "D:/ws/proj/node_modules/next/dist/bin/next" start')),
    "D:/ws/proj",
  );
  assert.equal(
    deriveRepoRootFromNextEntry(toWin("node D:/ws/proj/node_modules/next/dist/server/lib/start-server.js")),
    "D:/ws/proj",
  );
  assert.equal(deriveRepoRootFromNextEntry("node scripts/dev/local-next-runtime.mjs start"), null);
  assert.equal(deriveRepoRootFromNextEntry(toWin("node //server/share/p/node_modules/next/dist/bin/next start")), null);
  assert.equal(deriveRepoRootFromNextEntry("node something-else.js start"), null);
  assert.equal(deriveRepoRootFromNextEntry(""), null);
});

/* ── 13. stop 从其他目录调用：以实例自身仓库根重新校验 ──────── */

function makeStopFixture(stateOverrides = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lc-stop-fallback-"));
  const callerRoot = path.join(tmp, "caller-repo");
  const instanceRoot = path.join(tmp, "instance-repo");
  mkdirSync(path.join(callerRoot, ".next"), { recursive: true });
  mkdirSync(path.join(instanceRoot, ".next"), { recursive: true });
  writeFileSync(path.join(instanceRoot, ".next", "local-runtime-3010.json"), JSON.stringify({
    schemaVersion: 1,
    repoRoot: instanceRoot,
    host: "127.0.0.1",
    port: 3010,
    launcherPid: 9536,
    childPid: 4242,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...stateOverrides,
  }), "utf8");
  const evidence = {
    child: {
      pid: 4242,
      parentPid: 9536,
      name: "node.exe",
      commandLine: '"C:/nodejs/node.exe" "' + toWin(instanceRoot) + toWin("/node_modules/next/dist/bin/next") + '" start -H 127.0.0.1 -p 3010',
    },
    ancestors: [{ pid: 9536, parentPid: 1, commandLine: '"C:/nodejs/node.exe" scripts/dev/local-next-runtime.mjs start --port 3010' }],
  };
  return { tmp, callerRoot, instanceRoot, evidence };
}

function stopInput(fx) {
  return {
    projectRoot: fx.callerRoot,
    host: "127.0.0.1",
    port: 3010,
    dryRun: true,
    findListeners: () => [{ address: "127.0.0.1:3010", pid: 4242 }],
    collectEvidence: async () => fx.evidence,
  };
}

test("stop from a foreign cwd verifies ownership against the listener's own repo root", async () => {
  const fx = makeStopFixture();
  try {
    const flow = await runSafeStop(stopInput(fx));
    assert.ok(flow, "合法实例在回退校验后必须放行");
    assert.equal(flow.dryRun, true);
    assert.equal(flow.stopped, false);
    assert.equal(flow.signalSent, false);
    assert.equal(process.exitCode ?? 0, 0);
  } finally {
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("stop still refuses when the listener's own state does not match", async () => {
  const fx = makeStopFixture({ childPid: 9999 });
  try {
    const flow = await runSafeStop(stopInput(fx));
    assert.equal(flow, null, "状态文件 childPid 不一致时必须拒绝停止");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test("stop still refuses when the listener's repo root has no state file", async () => {
  const fx = makeStopFixture();
  try {
    rmSync(path.join(fx.instanceRoot, ".next", "local-runtime-3010.json"));
    const flow = await runSafeStop(stopInput(fx));
    assert.equal(flow, null, "缺少状态文件时必须拒绝停止");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
    rmSync(fx.tmp, { recursive: true, force: true });
  }
});

/* ── 14. 命令行不可读（高完整性级别进程）时的原因码 ────────── */

test("decideSafeStop distinguishes unreadable command lines from a real entry mismatch", () => {
  const target = { host: "127.0.0.1", port: 3010, repoRoot: REPO_ROOT };
  const decision = decideSafeStop({
    target,
    state: { status: "absent" },
    evidence: {
      listeners: [{ pid: 4242, address: "127.0.0.1", port: 3010 }],
      child: { pid: 4242, parentPid: 9536, name: "node.exe", commandLine: "" },
      ancestors: [{ pid: 9536, parentPid: 1, commandLine: "" }],
    },
  });
  assert.equal(decision.decision, "reject", "证据不足时必须拒绝");
  assert.ok(decision.reasons.includes("child_command_line_unavailable"), "必须给出可读性原因码");
  assert.ok(!decision.reasons.includes("child_next_entry_mismatch"), "不得把不可读误报为入口不匹配");
});
