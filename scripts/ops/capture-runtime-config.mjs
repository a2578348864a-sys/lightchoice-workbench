import { isAbsolute, resolve } from "node:path";

/** Pure configuration contract; no browser, network, storage or credential reads. */
export function readCaptureRuntimeConfig(env = process.env) {
  const enabled = env.LOCAL_ACQUISITION_ENABLED === "true";
  const detailSchedulerEnabled = env.V5_ENABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER === "1"
    && env.V5_DISABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER !== "1";
  return { enabled, browserMode: "persistent_profile", sessionStatus: "not_checked",
    detailExecution: detailSchedulerEnabled ? "scheduled" : "manual_only",
    message: enabled ? "Amazon 主动采集已开启；仍须检查美国出口及专用浏览器会话。"
      : "Amazon 主动采集未开启。请使用个人工作台启动配置后重新检查。" };
}

export function resolveAmazonCaptureProfileDirectory(env = process.env, cwd = process.cwd()) {
  const configured = env.AMAZON_CAPTURE_PROFILE_DIR?.trim();
  if (!configured) return resolve(cwd, ".playwright-profile", "amazon-us");
  if (!isAbsolute(configured) || configured.startsWith("\\\\") || configured.startsWith("//")) {
    throw new Error("AMAZON_CAPTURE_PROFILE_INVALID");
  }
  return resolve(configured);
}

export function validatePersonalCaptureConfig(env) {
  if (env.V5_RUNTIME_PURPOSE !== "personal-workbench") return [];
  const issues = [];
  if (env.LOCAL_ACQUISITION_ENABLED !== "true") {
    issues.push({ field: "LOCAL_ACQUISITION_ENABLED", code: "personal_capture_required" });
  }
  if (!env.AMAZON_CAPTURE_PROFILE_DIR?.trim()) {
    issues.push({ field: "AMAZON_CAPTURE_PROFILE_DIR", code: "fixed_capture_profile_required" });
  } else {
    try { resolveAmazonCaptureProfileDirectory(env); }
    catch { issues.push({ field: "AMAZON_CAPTURE_PROFILE_DIR", code: "absolute_local_path_required" }); }
  }
  for (const name of ["CONTINUOUS_MONITORING", "BATCH_DETAIL_ENRICHMENT"]) {
    if (env[`V5_ENABLE_${name}_SCHEDULER`] === "1" && env[`V5_DISABLE_${name}_SCHEDULER`] !== "1") {
      issues.push({ field: `V5_ENABLE_${name}_SCHEDULER`, code: "background_scheduler_not_authorized" });
    }
  }
  return issues;
}

/** Preserve capture settings while excluding unrelated Provider credentials. */
export function buildPersonalCaptureEnv(parentEnv, profileDirectory) {
  const env = { ...parentEnv };
  const providerPrefixes = ["FEISHU_", "LARK_", "V5_HUB_", "OPENAI_", "DEEPSEEK_", "JEV_", "AWS_", "GOOGLE_", "ANTHROPIC_", "OPENROUTER_", "GEMINI_", "DASHSCOPE_", "QWEN_", "KIMI_"];
  for (const key of Object.keys(env)) {
    if (providerPrefixes.some(prefix => key.startsWith(prefix)) || /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL$)/i.test(key)) delete env[key];
  }
  return { ...env, V5_RUNTIME_PURPOSE: "personal-workbench", LOCAL_ACQUISITION_ENABLED: "true",
    AMAZON_CAPTURE_PROFILE_DIR: profileDirectory,
    V5_ENABLE_CONTINUOUS_MONITORING_SCHEDULER: "0", V5_DISABLE_CONTINUOUS_MONITORING_SCHEDULER: "1",
    V5_ENABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER: "0", V5_DISABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER: "1",
    AI_PROVIDER: "unsupported-offline", V5_RESEARCH_PROVIDER: "", NEXT_TELEMETRY_DISABLED: "1" };
}
