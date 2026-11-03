import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePlaywrightProfileLock,
  getProfileLockDirectory,
  launchPersistentContextWithProfileLock,
} from "./playwrightProfileLease.mjs";

const helperUrl = pathToFileURL(join(process.cwd(), "lib/server/playwrightProfileLease.mjs")).href;
let tempRoot = "";
const children = new Set<ChildProcessWithoutNullStreams>();
const outputs = new Map<ChildProcessWithoutNullStreams, string>();

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "lightchoice-profile-lease-test-"));
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.all([...children].map((child) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("close", () => resolve()))));
  children.clear();
  outputs.clear();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

function makePaths(name = "amazon-us") {
  return {
    profileDir: join(tempRoot, "profiles", name),
    lockRoot: join(tempRoot, "locks"),
  };
}

async function expectProfileInUse(action: Promise<unknown>, state?: string) {
  try {
    await action;
    throw new Error("Expected profile lock acquisition to fail.");
  } catch (error) {
    expect(error).toMatchObject({ code: "PROFILE_IN_USE" });
    if (state) expect(error).toMatchObject({ state });
  }
}

function spawnLockWorker(profileDir: string, lockRoot: string, barrierPath: string, releasePath: string) {
  const script = `
    import { existsSync } from "node:fs";
    import { acquirePlaywrightProfileLock } from ${JSON.stringify(helperUrl)};
    const profileDir = ${JSON.stringify(profileDir)};
    const lockRoot = ${JSON.stringify(lockRoot)};
    const barrierPath = ${JSON.stringify(barrierPath)};
    const releasePath = ${JSON.stringify(releasePath)};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    console.log("READY");
    while (!existsSync(barrierPath)) await wait(5);
    try {
      const release = await acquirePlaywrightProfileLock(profileDir, { lockRoot });
      console.log("ACQUIRED");
      while (!existsSync(releasePath)) await wait(5);
      await release();
      console.log("RELEASED");
    } catch (error) {
      console.log("DENIED:" + error.code + ":" + error.state);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  children.add(child);
  outputs.set(child, "");
  child.stdout.on("data", (chunk: Buffer) => {
    outputs.set(child, `${outputs.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    outputs.set(child, `${outputs.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  return child;
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, token: string, timeoutMs = 5000) {
  if ((outputs.get(child) ?? "").includes(token)) return outputs.get(child) ?? "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for child output: ${token}`)), timeoutMs);
    const onData = () => {
      const value = outputs.get(child) ?? "";
      if (value.includes(token)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.off("close", onClose);
        resolve(value);
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      reject(new Error(`Child exited before ${token}; code=${code}; signal=${signal}; output=${outputs.get(child) ?? ""}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("close", onClose);
  });
}

async function waitForEitherOutput(child: ChildProcessWithoutNullStreams, tokens: string[], timeoutMs = 5000) {
  const current = outputs.get(child) ?? "";
  if (tokens.some((token) => current.includes(token))) return current;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for any child output: ${tokens.join(", ")}`)), timeoutMs);
    const onData = () => {
      const value = outputs.get(child) ?? "";
      if (tokens.some((token) => value.includes(token))) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.off("close", onClose);
        resolve(value);
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      reject(new Error(`Child exited before its lock outcome; code=${code}; signal=${signal}; output=${outputs.get(child) ?? ""}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("close", onClose);
  });
}

function waitForClose(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => child.once("close", () => resolve()));
}

describe("cross-process Amazon Playwright Profile lease", () => {
  it("单进程重复申请立即得到 PROFILE_IN_USE，释放后可重新获取", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const release = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });

    await expectProfileInUse(acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot }), "owner_alive_or_pid_reused");
    await release();
    const releaseAgain = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    await releaseAgain();
  });

  it("旧租约重复释放不会删除后来获取的新租约", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const oldRelease = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    const lockDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    await oldRelease();

    const newRelease = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    const newOwner = await readFile(join(lockDirectory, "owner.json"), "utf8");
    await oldRelease();
    expect(await readFile(join(lockDirectory, "owner.json"), "utf8")).toBe(newOwner);
    await expectProfileInUse(acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot }));
    await newRelease();
  });

  it("不同 Profile 可以并行获取独立锁", async () => {
    const first = makePaths("profile-one");
    const second = makePaths("profile-two");
    await Promise.all([
      mkdir(first.profileDir, { recursive: true }),
      mkdir(second.profileDir, { recursive: true }),
    ]);
    const releaseFirst = await acquirePlaywrightProfileLock(first.profileDir, { lockRoot: first.lockRoot });
    const releaseSecond = await acquirePlaywrightProfileLock(second.profileDir, { lockRoot: second.lockRoot });
    await releaseFirst();
    await releaseSecond();
  });

  it("Windows 路径大小写、分隔符和尾分隔符归一到同一锁身份", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const alternate = `${paths.profileDir.toUpperCase().replaceAll("\\", "/")}/`;
    const firstDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    const secondDirectory = await getProfileLockDirectory(alternate, { lockRoot: paths.lockRoot });
    if (process.platform === "win32") {
      expect(secondDirectory).toBe(firstDirectory);
      const release = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
      await expectProfileInUse(acquirePlaywrightProfileLock(alternate, { lockRoot: paths.lockRoot }));
      await release();
    }
  });

  it("两个独立 Node 进程同步争抢时恰好一个获取锁", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const barrierPath = join(tempRoot, "start.barrier");
    const releasePath = join(tempRoot, "release.barrier");
    const first = spawnLockWorker(paths.profileDir, paths.lockRoot, barrierPath, releasePath);
    const second = spawnLockWorker(paths.profileDir, paths.lockRoot, barrierPath, releasePath);
    await Promise.all([waitForOutput(first, "READY"), waitForOutput(second, "READY")]);
    await writeFile(barrierPath, "go");

    const [firstOutcome, secondOutcome] = await Promise.all([
      waitForEitherOutput(first, ["ACQUIRED", "DENIED:"]),
      waitForEitherOutput(second, ["ACQUIRED", "DENIED:"]),
    ]);
    const acquired = [firstOutcome, secondOutcome].filter((value) => value.includes("ACQUIRED"));
    const denied = [firstOutcome, secondOutcome].filter((value) => value.includes("DENIED:PROFILE_IN_USE:"));
    expect(acquired).toHaveLength(1);
    expect(denied).toHaveLength(1);

    await writeFile(releasePath, "release");
    await Promise.all([waitForOutput(first, "RELEASED").catch(() => undefined), waitForOutput(second, "RELEASED").catch(() => undefined)]);
    await Promise.all([first, second].map(waitForClose));
  }, 15000);

  it("两个进程同时恢复 stale 锁时只允许一个接管", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const staleBarrierPath = join(tempRoot, "stale-start.barrier");
    const staleReleasePath = join(tempRoot, "never-release.barrier");
    const staleOwner = spawnLockWorker(paths.profileDir, paths.lockRoot, staleBarrierPath, staleReleasePath);
    await waitForOutput(staleOwner, "READY");
    await writeFile(staleBarrierPath, "go");
    await waitForOutput(staleOwner, "ACQUIRED");
    const lockDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    const staleOwnerLeaseToken = (JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8")) as { leaseToken: string }).leaseToken;
    staleOwner.kill();
    await waitForClose(staleOwner);

    const barrierPath = join(tempRoot, "recovery-start.barrier");
    const releasePath = join(tempRoot, "recovery-release.barrier");
    const first = spawnLockWorker(paths.profileDir, paths.lockRoot, barrierPath, releasePath);
    const second = spawnLockWorker(paths.profileDir, paths.lockRoot, barrierPath, releasePath);
    await Promise.all([waitForOutput(first, "READY"), waitForOutput(second, "READY")]);
    await writeFile(barrierPath, "go");
    const outcomes = await Promise.all([
      waitForEitherOutput(first, ["ACQUIRED", "DENIED:"]),
      waitForEitherOutput(second, ["ACQUIRED", "DENIED:"]),
    ]);
    expect(outcomes.filter((value) => value.includes("ACQUIRED"))).toHaveLength(1);
    expect(outcomes.filter((value) => value.includes("DENIED:PROFILE_IN_USE:"))).toHaveLength(1);
    const recoveredOwner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8")) as { leaseToken: string };
    expect(recoveredOwner.leaseToken).not.toBe(staleOwnerLeaseToken);

    await writeFile(releasePath, "release");
    await Promise.all([waitForOutput(first, "RELEASED").catch(() => undefined), waitForOutput(second, "RELEASED").catch(() => undefined)]);
    await Promise.all([first, second].map(waitForClose));
    const reacquired = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    await reacquired();
  }, 15000);

  it("未知或损坏的锁状态 fail-closed，活跃持有者的锁不会被其他申请者删除", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    await mkdir(paths.lockRoot, { recursive: true });
    const lockDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    await mkdir(lockDirectory, { recursive: true });
    await expectProfileInUse(acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot }), "owner_state_unknown");
    await rm(lockDirectory, { recursive: true, force: true });

    const release = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    await expectProfileInUse(acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot }));
    expect(await readFile(join(lockDirectory, "owner.json"), "utf8")).toContain('"pid":');
    await release();
  });

  it("启动失败释放自己的锁，正常 Browser Close 后也释放", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    await expect(launchPersistentContextWithProfileLock(paths.profileDir, async () => {
      throw new Error("isolated launch failure");
    }, { lockRoot: paths.lockRoot })).rejects.toThrow("isolated launch failure");

    const first = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    await first();
    const context = { close: vi.fn(async () => undefined) };
    const leased = await launchPersistentContextWithProfileLock(paths.profileDir, async () => context, { lockRoot: paths.lockRoot });
    await leased.close();
    expect(context.close).toHaveBeenCalledOnce();
    const reacquired = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    await reacquired();
  });

  it("Browser Close 无法确认时保留租约 fail-closed", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const leased = await launchPersistentContextWithProfileLock(paths.profileDir, async () => ({
      close: async () => { throw new Error("close failed"); },
    }), { lockRoot: paths.lockRoot });
    await expect(leased.close()).rejects.toMatchObject({ code: "PROFILE_BROWSER_CLOSE_FAILED" });
    await expectProfileInUse(acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot }));
  });

  it("残留的锁转换保护无法确认所有权时 fail-closed", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const lockDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    await mkdir(`${lockDirectory}.transition`, { recursive: true });

    await expectProfileInUse(
      acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot }),
      "lock_transition_in_progress",
    );
    expect(await readFile(join(`${lockDirectory}.transition`, "owner.json"), "utf8").catch(() => null)).toBeNull();
  });

  it("未完成的原子发布暂存目录不会阻塞安全获取", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const lockDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    const abandonedTransitionClaim = `${lockDirectory}.transition.claim-interrupted`;
    const abandonedLockClaim = `${lockDirectory}.claim-interrupted`;
    await mkdir(abandonedTransitionClaim, { recursive: true });
    await mkdir(abandonedLockClaim, { recursive: true });

    const release = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    expect(await readFile(join(lockDirectory, "owner.json"), "utf8")).toContain('"leaseToken"');
    expect(await readFile(join(abandonedTransitionClaim, "owner.json"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(join(abandonedLockClaim, "owner.json"), "utf8").catch(() => null)).toBeNull();
    await release();
  });

  it("安全恢复同机已退出进程遗留的锁转换保护", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    await mkdir(paths.lockRoot, { recursive: true });
    const lockDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    const transitionPath = `${lockDirectory}.transition`;
    const profileIdentity = createHash("sha256").update(transitionPath).digest("hex");
    const script = `
      import { mkdir, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      import { hostname } from "node:os";
      import { randomUUID } from "node:crypto";
      const path = ${JSON.stringify(transitionPath)};
      await mkdir(path);
      await writeFile(join(path, "owner.json"), JSON.stringify({
        version: 1, pid: process.pid, host: hostname(), processInstanceId: randomUUID(),
        leaseToken: randomUUID(), profileIdentity: ${JSON.stringify(profileIdentity)}, acquiredAt: new Date().toISOString(),
      }));
      console.log("CREATED");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    children.add(child);
    outputs.set(child, "");
    child.stdout.on("data", (chunk: Buffer) => outputs.set(child, `${outputs.get(child) ?? ""}${chunk.toString("utf8")}`));
    child.stderr.on("data", (chunk: Buffer) => outputs.set(child, `${outputs.get(child) ?? ""}${chunk.toString("utf8")}`));
    await waitForOutput(child, "CREATED");
    await waitForClose(child);

    const release = await acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot });
    expect(await readFile(join(lockDirectory, "owner.json"), "utf8")).toContain('"leaseToken"');
    expect(await readFile(join(transitionPath, "owner.json"), "utf8").catch(() => null)).toBeNull();
    await release();
  });
});

describe("malformed owner.json fail-closed", () => {
  it("拒绝损坏的 owner.json 且保留无法验证的锁", async () => {
    const paths = makePaths();
    await mkdir(paths.profileDir, { recursive: true });
    const lockDirectory = await getProfileLockDirectory(paths.profileDir, { lockRoot: paths.lockRoot });
    await mkdir(lockDirectory, { recursive: true });
    const ownerPath = join(lockDirectory, "owner.json");
    const malformed = "{ malformed json";
    await writeFile(ownerPath, malformed, "utf8");

    await expectProfileInUse(
      acquirePlaywrightProfileLock(paths.profileDir, { lockRoot: paths.lockRoot }),
      "owner_state_unknown",
    );
    expect(await readFile(ownerPath, "utf8")).toBe(malformed);
  });
});
