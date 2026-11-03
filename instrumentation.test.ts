import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ startScheduler: vi.fn() }));

vi.mock("@/lib/server/continuousMonitoringScheduler", () => ({
  startContinuousMonitoringScheduler: mocks.startScheduler,
  // V6 退役后的真实门禁：调度器永久关闭，任何环境变量都不能重新开启。
  continuousMonitoringSchedulerConfigEnabled: () => false,
}));

import { register } from "./instrumentation";

const originalRuntime = process.env.NEXT_RUNTIME;
const originalSchedulerOptIn = process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER;
const originalSchedulerGuard = process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER;

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
  if (originalSchedulerOptIn === undefined) delete process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER;
  else process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER = originalSchedulerOptIn;
  if (originalSchedulerGuard === undefined) delete process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER;
  else process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER = originalSchedulerGuard;
  mocks.startScheduler.mockReset();
});

describe("Next instrumentation scheduler guard", () => {
  it("keeps the scheduler off by default in the Node runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER;
    delete process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER;

    await register();

    expect(mocks.startScheduler).not.toHaveBeenCalled();
  });

  it("keeps the retired scheduler off even when the legacy opt-in variable is set", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER = "1";
    delete process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER;

    await register();

    expect(mocks.startScheduler).not.toHaveBeenCalled();
  });

  it("keeps the scheduler off when disable overrides explicit enable", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER = "1";
    process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER = "1";

    await register();

    expect(mocks.startScheduler).not.toHaveBeenCalled();
  });

  it("never starts the scheduler for non-Node runtimes", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER = "1";
    delete process.env.V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER;

    await register();

    expect(mocks.startScheduler).not.toHaveBeenCalled();
  });
});
