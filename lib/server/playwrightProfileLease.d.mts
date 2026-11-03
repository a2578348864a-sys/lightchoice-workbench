export type ProfileLeaseConflictState =
  | "owner_alive_or_pid_reused"
  | "stale_owner_process"
  | "owner_state_unknown";

export type ProfileLeaseError = Error & {
  code: "PROFILE_IN_USE" | "PROFILE_LOCK_UNAVAILABLE";
  state: ProfileLeaseConflictState;
};

export type ProfileLeaseOptions = { lockRoot?: string };

export function getProfileLockDirectory(profileDir: string, options?: ProfileLeaseOptions): Promise<string>;
export function acquirePlaywrightProfileLock(
  profileDir: string,
  options?: ProfileLeaseOptions,
): Promise<() => Promise<void>>;
export function launchPersistentContextWithProfileLock<T extends { close(): Promise<void> }>(
  profileDir: string,
  launch: () => Promise<T>,
  options?: ProfileLeaseOptions,
): Promise<{ context: T; close: () => Promise<void> }>;
