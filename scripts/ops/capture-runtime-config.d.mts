export type CaptureRuntimeSummary = {
  enabled: boolean; browserMode: "persistent_profile"; sessionStatus: "not_checked";
  detailExecution: "scheduled" | "manual_only"; message: string;
};
export function readCaptureRuntimeConfig(env?: Record<string, string | undefined>): CaptureRuntimeSummary;
export function resolveAmazonCaptureProfileDirectory(env?: Record<string, string | undefined>, cwd?: string): string;
export function validatePersonalCaptureConfig(env: Record<string, string | undefined>): { field: string; code: string }[];
export function buildPersonalCaptureEnv(parentEnv: Record<string, string | undefined>, profileDirectory: string): Record<string, string | undefined>;
