import { isAbsolute } from "node:path";
import { validatePersonalCaptureConfig } from "./capture-runtime-config.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";

/** Pure validation. No directories, credentials, network calls or database writes. */
export function validateV5RuntimeConfig(env) {
  const issues = [...validatePersonalCaptureConfig(env)];
  for (const field of ["SOURCE_LAYER_STORE_DIR", "DEMO_ACCESS_STORE_PATH"]) {
    const value = text(env[field]);
    if (!value) issues.push({ code: "missing_config", field });
    else if (!isAbsolute(value) || value.startsWith("\\\\") || value.startsWith("//")) {
      issues.push({ code: "absolute_local_path_required", field });
    }
  }
  const database = text(env.DATABASE_URL);
  if (!database.startsWith("file:") || !isAbsolute(database.slice(5))) {
    issues.push({ code: "absolute_sqlite_url_required", field: "DATABASE_URL" });
  }
  const pairs = [
    ["FEISHU_APP_ID", "LARK_APP_ID"], ["FEISHU_APP_SECRET", "LARK_APP_SECRET"],
    ["FEISHU_BASE_APP_TOKEN", "LARK_BASE_APP_TOKEN"],
    ["FEISHU_MARKET_TABLE_ID", "LARK_BASE_TABLE_ID"],
    ["FEISHU_RESEARCH_TABLE_ID", "V5_HUB_TABLE_T02"],
  ];
  const configured = pairs.map(([field, alias]) => text(env[field]) || text(env[alias]));
  const anyFeishu = configured.some(Boolean);
  if (anyFeishu) {
    configured.forEach((value, index) => {
      if (!value) issues.push({ code: "incomplete_feishu_config", field: pairs[index][0] });
    });
  }
  return { ok: issues.length === 0, issues,
    summary: { feishu: anyFeishu ? (configured.every(Boolean) ? "configured" : "incomplete") : "disabled_unconfigured" } };
}

export function assertV5RuntimeConfig(env) {
  const result = validateV5RuntimeConfig(env);
  if (!result.ok) {
    throw new Error("v5_runtime_preflight_failed:" + result.issues.map(({ field, code }) => field + ":" + code).join(","));
  }
  return result;
}
