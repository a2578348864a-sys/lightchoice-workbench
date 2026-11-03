import "server-only";

import type { LarkConfig } from "./types";

export type GetOpportunityLarkConfigResult =
  | { readonly ok: true; readonly config: LarkConfig }
  | { readonly ok: false; readonly missingKeys: readonly string[] };

function readEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

/**
 * 机会池使用独立的表 ID。应用凭据可专用，也可在没有专用凭据时复用已有应用凭据；
 * 绝不回退到 Research 的 LARK_BASE_TABLE_ID，避免两套业务写入同一张表。
 */
export function getOpportunityLarkConfig(): GetOpportunityLarkConfigResult {
  const appId = readEnv("LARK_OPPORTUNITY_APP_ID", "FEISHU_OPPORTUNITY_APP_ID", "LARK_APP_ID", "FEISHU_APP_ID");
  const appSecret = readEnv(
    "LARK_OPPORTUNITY_APP_SECRET",
    "FEISHU_OPPORTUNITY_APP_SECRET",
    "LARK_APP_SECRET",
    "FEISHU_APP_SECRET",
  );
  const appToken = readEnv(
    "LARK_OPPORTUNITY_APP_TOKEN",
    "FEISHU_OPPORTUNITY_APP_TOKEN",
    "LARK_BASE_APP_TOKEN",
    "FEISHU_BASE_APP_TOKEN",
  );
  const tableId = readEnv("LARK_OPPORTUNITY_TABLE_ID", "FEISHU_OPPORTUNITY_TABLE_ID");
  const openApiDomain = readEnv(
    "LARK_OPPORTUNITY_OPEN_API_DOMAIN",
    "FEISHU_OPPORTUNITY_OPEN_API_DOMAIN",
    "LARK_OPEN_API_DOMAIN",
    "FEISHU_OPEN_API_DOMAIN",
  ) || "https://open.feishu.cn";

  const missing: string[] = [];
  if (!appId) missing.push("LARK_OPPORTUNITY_APP_ID");
  if (!appSecret) missing.push("LARK_OPPORTUNITY_APP_SECRET");
  if (!appToken) missing.push("LARK_OPPORTUNITY_APP_TOKEN");
  if (!tableId) missing.push("LARK_OPPORTUNITY_TABLE_ID");
  if (missing.length > 0) return { ok: false, missingKeys: missing };

  return {
    ok: true,
    config: {
      appId,
      appSecret,
      appToken,
      tableId,
      openApiDomain: openApiDomain.replace(/\/+$/u, ""),
    },
  };
}

export function getRedactedOpportunityLarkConfig() {
  const result = getOpportunityLarkConfig();
  if (!result.ok) return { configured: false, missingKeys: result.missingKeys } as const;
  return {
    configured: true,
    appId: result.config.appId,
    appToken: result.config.appToken,
    tableId: result.config.tableId,
    openApiDomain: result.config.openApiDomain,
  } as const;
}
