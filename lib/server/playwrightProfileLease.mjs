import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

const LOCK_ROOT = join(homedir(), ".lightchoice-v5", "profile-locks");
const PROCESS_INSTANCE_ID = randomUUID();

function normalizeProfilePath(profileDir, platform = process.platform, cwd = process.cwd()) {
  const absolutePath = isAbsolute(profileDir) ? profileDir : resolve(cwd, profileDir);
  let normalizedPath = normalize(absolutePath).replace(/[\\/]+$/u, "");
  if (platform === "win32") {
    normalizedPath = normalizedPath.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  }
  return normalizedPath;
}

async function resolveCanonicalProfilePath(profileDir) {
  const absolutePath = resolve(profileDir);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return absolutePath;
    throw error;
  }
}

function lockPathForCanonicalPath(canonicalPath, lockRoot) {
  const pathKey = normalizeProfilePath(canonicalPath);
  const identity = createHash("sha256").update(pathKey).digest("hex");
  return join(lockRoot, `${identity}.lock`);
}

function createProfileInUseError(state) {
  const message = state === "stale_owner_process"
    ? "Amazon Capture Profile 留有已退出进程的锁；系统正在通过串行恢复确认其所有权。"
    : state === "lock_transition_in_progress"
      ? "Amazon Capture Profile 正在进行锁状态切换；本次未启动浏览器，请稍后重试。"
      : "Amazon Capture Profile 已被占用，或现有锁状态无法确认；本次未启动浏览器。";
  const error = new Error(message);
  error.code = "PROFILE_IN_USE";
  error.state = state;
  return error;
}

function createLockUnavailableError() {
  const error = new Error("无法安全建立 Amazon Capture Profile 独占锁；本次未启动浏览器。");
  error.code = "PROFILE_LOCK_UNAVAILABLE";
  error.state = "owner_state_unknown";
  return error;
}

function createProfileOwnershipLostError() {
  const error = new Error("Amazon Capture Profile 租约所有权或状态已变化；系统未删除无法确认归属的锁。请先检查浏览器进程后再重试。");
  error.code = "PROFILE_LOCK_OWNERSHIP_LOST";
  error.state = "owner_state_unknown";
  return error;
}

function createProfileBrowserCloseError(cause) {
  const error = new Error("Amazon Capture 浏览器未能确认关闭；Profile 租约已保留，避免并发启动。请检查浏览器进程后再重试。", { cause });
  error.code = "PROFILE_BROWSER_CLOSE_FAILED";
  error.state = "browser_close_unconfirmed";
  return error;
}

async function readOwner(lockPath) {
  try {
    const value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (
      value?.version !== 1
      || !Number.isSafeInteger(value.pid)
      || value.pid < 1
      || typeof value.host !== "string"
      || typeof value.processInstanceId !== "string"
      || typeof value.leaseToken !== "string"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function classifyExistingLock(lockPath) {
  const owner = await readOwner(lockPath);
  if (!owner || owner.host !== hostname()) return "owner_state_unknown";

  try {
    process.kill(owner.pid, 0);
    // A live PID may be the owner or a PID-reused process. We cannot safely
    // distinguish them without an OS process-creation identity, so fail closed.
    return "owner_alive_or_pid_reused";
  } catch (error) {
    if (error?.code === "ESRCH") return "stale_owner_process";
    return "owner_state_unknown";
  }
}

/** Return the lock directory for diagnostics and isolated tests. */
export async function getProfileLockDirectory(profileDir, options = {}) {
  const canonicalPath = await resolveCanonicalProfilePath(profileDir);
  return lockPathForCanonicalPath(canonicalPath, options.lockRoot ?? LOCK_ROOT);
}

function transitionOwnerFor(path, leaseToken) {
  return {
    version: 1,
    pid: process.pid,
    host: hostname(),
    processInstanceId: PROCESS_INSTANCE_ID,
    leaseToken,
    profileIdentity: createHash("sha256").update(path).digest("hex"),
    acquiredAt: new Date().toISOString(),
  };
}

async function createTransitionDirectory(path) {
  const leaseToken = randomUUID();
  let renameAttempted = false;
  const stagingPath = `${path}.claim-${process.pid}-${leaseToken}`;
  try {
    await mkdir(stagingPath);
    await writeFile(join(stagingPath, "owner.json"), JSON.stringify(transitionOwnerFor(path, leaseToken)), { flag: "wx" });
    try { await realpath(path); await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined); return null; } catch (error) { if (error?.code !== "ENOENT") throw createLockUnavailableError(); }
    renameAttempted = true;
    await rename(stagingPath, path);
    return leaseToken;
  } catch {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    try {
      await realpath(path);
      return null;
    } catch (error) {
      if (error?.code === "ENOENT") { if (renameAttempted) return null; throw createLockUnavailableError(); }
      throw createLockUnavailableError();
    }
  }
}

async function reclaimStaleTransitionDirectory(path) {
  let owner;
  try {
    await realpath(path);
    owner = await readOwner(path);
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw createLockUnavailableError();
  }

  const expectedIdentity = createHash("sha256").update(path).digest("hex");
  if (!owner || owner.profileIdentity !== expectedIdentity
    || await classifyExistingLock(path) !== "stale_owner_process") return "held";

  // Rename is the single-winner recovery claim. The owner record has already
  // been published atomically, so a dead claimant cannot leave a half lock.
  const retiredPath = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw createLockUnavailableError();
  }

  const retiredOwner = await readOwner(retiredPath);
  if (!retiredOwner || retiredOwner.leaseToken !== owner.leaseToken
    || retiredOwner.profileIdentity !== expectedIdentity
    || await classifyExistingLock(retiredPath) !== "stale_owner_process") {
    throw createProfileOwnershipLostError();
  }
  await rm(retiredPath, { recursive: true, force: false });
  return "reclaimed";
}

async function acquireTransitionGuard(lockPath, waitMs = 0) {
  const guardPath = `${lockPath}.transition`;
  const deadline = Date.now() + waitMs;
  while (true) {
    const leaseToken = await createTransitionDirectory(guardPath);
    if (leaseToken) return createTransitionRelease(guardPath, leaseToken);

    const recovery = await reclaimStaleTransitionDirectory(guardPath);
    if (recovery === "missing" || recovery === "reclaimed") continue;
    if (Date.now() >= deadline) throw createProfileInUseError("lock_transition_in_progress");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createTransitionRelease(guardPath, leaseToken) {
  let released = false;
  return async function releaseTransitionGuard() {
    if (released) return;
    const currentOwner = await readOwner(guardPath);
    const expectedIdentity = createHash("sha256").update(guardPath).digest("hex");
    if (!currentOwner || currentOwner.leaseToken !== leaseToken || currentOwner.profileIdentity !== expectedIdentity) {
      const error = new Error("Profile 锁切换保护的所有权已变化；未删除任何锁目录。");
      error.code = "PROFILE_LOCK_OWNERSHIP_LOST";
      throw error;
    }
    await rm(guardPath, { recursive: true, force: false });
    released = true;
  };
}

export async function acquirePlaywrightProfileLock(profileDir, options = {}) {
  if (typeof profileDir !== "string" || profileDir.trim().length === 0) {
    throw createLockUnavailableError();
  }

  let canonicalPath;
  try {
    canonicalPath = await resolveCanonicalProfilePath(profileDir);
  } catch {
    throw createLockUnavailableError();
  }

  const lockRoot = options.lockRoot ?? LOCK_ROOT;
  const lockPath = lockPathForCanonicalPath(canonicalPath, lockRoot);
  let releaseTransitionGuard;
  try {
    await mkdir(lockRoot, { recursive: true });
    releaseTransitionGuard = await acquireTransitionGuard(lockPath, options.transitionWaitMs ?? 0);
  } catch (error) {
    if (error?.code === "PROFILE_IN_USE") throw error;
    throw createLockUnavailableError();
  }

  const leaseToken = randomUUID();
  const owner = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    processInstanceId: PROCESS_INSTANCE_ID,
    leaseToken,
    profileIdentity: createHash("sha256").update(normalizeProfilePath(canonicalPath)).digest("hex"),
    acquiredAt: new Date().toISOString(),
  };
  const stagingPath = `${lockPath}.claim-${process.pid}-${leaseToken}`;

  try {
    let lockExists = true;
    try {
      await realpath(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") lockExists = false;
      else throw createLockUnavailableError();
    }

    if (lockExists) {
      const state = await classifyExistingLock(lockPath);
      if (state !== "stale_owner_process") throw createProfileInUseError(state);

      // Only remove a same-host lock whose process is confirmed absent. The
      // transition guard serializes stale recovery against other claimants.
      await rm(lockPath, { recursive: true, force: false });
    }

    // Publish a complete lock directory atomically. A crash while preparing
    // the owner record leaves only an ignored claim directory, never an
    // ownerless active lock.
    await mkdir(stagingPath);
    await writeFile(join(stagingPath, "owner.json"), JSON.stringify(owner), { flag: "wx" });
    await rename(stagingPath, lockPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    if (error?.code === "PROFILE_IN_USE") throw error;
    try {
      await realpath(lockPath);
      throw createProfileInUseError(await classifyExistingLock(lockPath));
    } catch (stateError) {
      if (stateError?.code === "PROFILE_IN_USE") throw stateError;
      if (stateError?.code !== "ENOENT") throw createLockUnavailableError();
    }
    throw createLockUnavailableError();
  } finally {
    await releaseTransitionGuard();
  }

  let released = false;
  return async function releasePlaywrightProfileLock() {
    if (released) return;
    const releaseGuard = await acquireTransitionGuard(lockPath, options.releaseTransitionWaitMs ?? 1000);
    try {
      let lockExists = true;
      try {
        await realpath(lockPath);
      } catch (error) {
        if (error?.code === "ENOENT") lockExists = false;
        else throw createLockUnavailableError();
      }
      if (!lockExists) {
        released = true;
        return;
      }
      const currentOwner = await readOwner(lockPath);
      if (!currentOwner || currentOwner.leaseToken !== leaseToken) throw createProfileOwnershipLostError();
      await rm(lockPath, { recursive: true, force: false });
      released = true;
    } finally {
      await releaseGuard();
    }
  };
}

/**
 * Launch a persistent context under the shared profile lock. A failed launch
 * releases its own lease; a failed close deliberately retains it fail-closed.
 */
export async function launchPersistentContextWithProfileLock(profileDir, launch, options = {}) {
  const release = await acquirePlaywrightProfileLock(profileDir, options);
  let context;
  try {
    context = await launch();
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      if (error && typeof error === "object") error.cleanupError = cleanupError;
    }
    throw error;
  }

  let browserClosed = false;
  let released = false;
  return {
    context,
    close: async () => {
      if (released) return;
      if (!browserClosed) {
        try {
          await context.close();
          browserClosed = true;
        } catch (error) {
          throw createProfileBrowserCloseError(error);
        }
      }
      await release();
      released = true;
    },
  };
}

