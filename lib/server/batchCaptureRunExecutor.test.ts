import { describe, expect, it, vi } from "vitest";

import { createBatchCaptureRunExecutor, sanitizeDriveMessage } from "./batchCaptureRunExecutor";
import type { BatchCaptureRun } from "./batchCaptureRun";

// 批量 BCR 用例需显式声明运行范围；生产缺省仍为 single_asin_only（只允许单 ASIN）。
process.env.V5_ACQUISITION_SCOPE = "batch_and_single";

const owner = { mode: "owner" as const, token: "" };
const batchId = "batch-executor-01";

function run(status: BatchCaptureRun["status"], runId = "run-01"): BatchCaptureRun {
  return { runId, batchId, status, version: 1 } as BatchCaptureRun;
}

describe("batch capture run bounded executor", () => {
  it("starts exactly one bounded drive per run and dedups concurrent triggers", async () => {
    let resolveDrive!: () => void;
    const driveGate = new Promise<void>((resolveGate) => { resolveDrive = resolveGate; });
    const drive = vi.fn(async () => {
      await driveGate;
      return run("COMPLETED");
    });
    const executor = createBatchCaptureRunExecutor({
      service: { getRun: async () => run("WAITING"), drive } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
    });

    const first = await executor.ensureRunning({ context: owner, batchId });
    const second = await executor.ensureRunning({ context: owner, batchId });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(executor.activeCount()).toBe(1);

    resolveDrive();
    await executor.waitForIdle();
    expect(drive).toHaveBeenCalledTimes(1);
    expect(executor.activeCount()).toBe(0);
  });

  it("一次启动默认开启有界自动重试（allowRetry 默认 true，显式 false 才关闭）", async () => {
    const driveArgs: Array<Record<string, unknown>> = [];
    const drive = vi.fn(async (input: Record<string, unknown>) => {
      driveArgs.push(input);
      return run("PARTIAL");
    });
    const executor = createBatchCaptureRunExecutor({
      service: { getRun: async () => run("WAITING"), drive } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
    });

    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();
    // 默认：自动重试开启（否则真实续采会停在一片后需要人工点重试）
    expect(driveArgs[0]?.allowRetry).toBe(true);

    driveArgs.length = 0;
    await executor.ensureRunning({ context: owner, batchId, allowRetry: false });
    await executor.waitForIdle();
    expect(driveArgs[0]?.allowRetry).toBe(false);
  });

  it("does not start a drive for a terminal or paused run", async () => {
    const drive = vi.fn(async () => run("COMPLETED"));
    const getRun = vi.fn(async () => run("PAUSED"));
    const executor = createBatchCaptureRunExecutor({
      service: { getRun, drive } as never,
      env: () => ({}) as NodeJS.ProcessEnv,
    });
    const result = await executor.ensureRunning({ context: owner, batchId });
    expect(result.started).toBe(false);
    expect(result.status).toBe("PAUSED");
    expect(drive).not.toHaveBeenCalled();
  });

  it("reports a bounded drive error without leaking it and clears the active slot", async () => {
    const errors: Array<{ batchId: string; code: string }> = [];
    const executor = createBatchCaptureRunExecutor({
      service: {
        getRun: async () => run("WAITING"),
        drive: async () => { throw Object.assign(new Error("busy"), { code: "BATCH_CAPTURE_JOB_BUSY" }); },
      } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
      onError: (info) => errors.push(info),
    });
    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();
    expect(errors).toEqual([expect.objectContaining({ batchId, code: "BATCH_CAPTURE_JOB_BUSY" })]);
    expect(executor.activeCount()).toBe(0);
  });

  it("P0-3) onError 收到结构化诊断（batchId/runId/错误码/名称/消息）", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const executor = createBatchCaptureRunExecutor({
      service: {
        getRun: async () => run("WAITING"),
        drive: async () => { throw Object.assign(new Error("任务状态已被其他操作更新"), { code: "BATCH_CAPTURE_CAS_CONFLICT" }); },
      } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
      onError: (info) => seen.push(info as unknown as Record<string, unknown>),
    });
    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      batchId, runId: "run-01", code: "BATCH_CAPTURE_CAS_CONFLICT", errorName: "Error",
    });
    expect(String(seen[0].message)).toContain("任务状态已被其他操作更新");
  });

  it("P0-3) 诊断消息经过脱敏与限长，不携带凭据", () => {
    const dirty = "cookie=SECRET_TOKEN_ABC123; Authorization: Bearer abcdefghijklmnop";
    const clean = sanitizeDriveMessage(dirty);
    expect(clean).not.toContain("Bearer");
    expect(clean.length).toBeLessThanOrEqual(200);
    expect(sanitizeDriveMessage("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it("a new trigger resumes the same run after the previous bounded drive stopped", async () => {
    let status: BatchCaptureRun["status"] = "RUNNING";
    const drive = vi.fn(async () => {
      status = "COMPLETED";
      return run(status);
    });
    const executor = createBatchCaptureRunExecutor({
      service: { getRun: async () => run(status), drive } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
    });
    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();
    const resumed = await executor.ensureRunning({ context: owner, batchId });
    expect(resumed.started).toBe(false);
    expect(resumed.status).toBe("COMPLETED");
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it("D2-1E) 环境未启用时同步拒绝：返回 errorCode 并持久化 run 级回执，绝不伪装成已启动", async () => {
    const noteExecutionBlocked = vi.fn(async () => null);
    const drive = vi.fn(async () => run("COMPLETED"));
    const executor = createBatchCaptureRunExecutor({
      service: { getRun: async () => run("WAITING"), drive, noteExecutionBlocked } as never,
      env: () => ({}) as NodeJS.ProcessEnv,
    });
    const result = await executor.ensureRunning({ context: owner, batchId });
    expect(result.started).toBe(false);
    expect(result.errorCode).toBe("LOCAL_ENVIRONMENT_REQUIRED");
    expect(result.runId).toBe("run-01");
    expect(result.status).toBe("WAITING");
    expect(drive).not.toHaveBeenCalled();
    expect(noteExecutionBlocked).toHaveBeenCalledTimes(1);
    expect(noteExecutionBlocked).toHaveBeenCalledWith(expect.objectContaining({
      batchId, runId: "run-01", code: "LOCAL_ENVIRONMENT_REQUIRED",
    }));
    expect(executor.activeCount()).toBe(0);
  });

  it("D2-1E) 异步 drive 失败也写入 run 级回执（不再只有进程日志）", async () => {
    const noteExecutionBlocked = vi.fn(async () => null);
    const executor = createBatchCaptureRunExecutor({
      service: {
        getRun: async () => run("WAITING"),
        drive: async () => { throw Object.assign(new Error("busy"), { code: "BATCH_CAPTURE_JOB_BUSY" }); },
        noteExecutionBlocked,
      } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
    });
    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();
    expect(noteExecutionBlocked).toHaveBeenCalledTimes(1);
    expect(noteExecutionBlocked).toHaveBeenCalledWith(expect.objectContaining({
      batchId, runId: "run-01", code: "BATCH_CAPTURE_JOB_BUSY",
    }));
  });
});

describe("执行器正常结束时的代次确认", () => {
  it("以 PARTIAL 正常结束时也确认本代次已停止（不再需要人工恢复）", async () => {
    const acks: Array<Record<string, unknown>> = [];
    let driveOwner: string | null = null;
    const drive = vi.fn(async (input: Record<string, unknown>) => {
      driveOwner = String(input.leaseOwner);
      return { ...run("PARTIAL"), executionEpoch: 3 };
    });
    const executor = createBatchCaptureRunExecutor({
      service: {
        getRun: async () => run("WAITING"),
        drive,
        acknowledgeStop: async (input: Record<string, unknown>) => { acks.push(input); return null; },
      } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
    });
    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();

    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ batchId, runId: "run-01", executionEpoch: 3, leaseOwner: driveOwner });
  });

  it("预算耗尽等 PARTIAL 终态、以及 COMPLETED 都会确认代次", async () => {
    for (const status of ["PARTIAL", "COMPLETED", "FAILED", "HUMAN_REQUIRED"] as const) {
      const acks: Array<Record<string, unknown>> = [];
      const executor = createBatchCaptureRunExecutor({
        service: {
          getRun: async () => run("WAITING"),
          drive: async () => ({ ...run(status), executionEpoch: 4 }),
          acknowledgeStop: async (input: Record<string, unknown>) => { acks.push(input); return null; },
        } as never,
        env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
      });
      await executor.ensureRunning({ context: owner, batchId });
      await executor.waitForIdle();
      expect(acks, `status=${status}`).toHaveLength(1);
      expect(acks[0]).toMatchObject({ executionEpoch: 4 });
    }
  });

  it("异常退出也确认本代次（避免下一次追加预算被永久阻塞）", async () => {
    const acks: Array<Record<string, unknown>> = [];
    const executor = createBatchCaptureRunExecutor({
      service: {
        getRun: async () => ({ ...run("RUNNING"), executionEpoch: 5 }),
        drive: async () => { throw Object.assign(new Error("boom"), { code: "BATCH_CAPTURE_JOB_BUSY" }); },
        noteExecutionBlocked: async () => null,
        acknowledgeStop: async (input: Record<string, unknown>) => { acks.push(input); return null; },
      } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
    });
    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ executionEpoch: 5 });
  });

  it("确认只用自己持有的代次号，不采信后来变大的最新值（旧执行器不得覆盖新代次）", async () => {
    const acks: Array<Record<string, unknown>> = [];
    const executor = createBatchCaptureRunExecutor({
      service: {
        // 新代次已接手：getRun 返回更大的 executionEpoch
        getRun: async () => ({ ...run("RUNNING"), executionEpoch: 9 }),
        drive: async () => ({ ...run("PARTIAL"), executionEpoch: 3 }),
        acknowledgeStop: async (input: Record<string, unknown>) => { acks.push(input); return null; },
      } as never,
      env: () => ({ LOCAL_ACQUISITION_ENABLED: "true", V5_ACQUISITION_SCOPE: "batch_and_single" }) as unknown as NodeJS.ProcessEnv,
    });
    await executor.ensureRunning({ context: owner, batchId });
    await executor.waitForIdle();
    expect(acks).toHaveLength(1);
    // 服务端会因代次不匹配拒绝；执行器绝不能提交 9
    expect(acks[0].executionEpoch).toBe(3);
  });
});
