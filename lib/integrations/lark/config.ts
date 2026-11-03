import "server-only";

import type { LarkConfig } from "./types";

const REQUIRED_KEYS = [
  "LARK_APP_ID",
  "LARK_APP_SECRET",
  "LARK_BASE_APP_TOKEN",
  "LARK_BASE_TABLE_ID",
] as const;

function readEnv(key: string, fallbackKey?: string): string {
  const primary = process.env[key]?.trim();
  if (primary) return primary;
  if (fallbackKey) {
    const fallback = process.env[fallbackKey]?.trim();
    if (fallback) return fallback;
  }
  return "";
}

export type GetLarkConfigResult =
  | { readonly ok: true; readonly config: LarkConfig }
  | { readonly ok: false; readonly missingKeys: readonly string[] };

export function getLarkConfig(): GetLarkConfigResult {
  const appId = readEnv("LARK_APP_ID", "FEISHU_APP_ID");
  const appSecret = readEnv("LARK_APP_SECRET", "FEISHU_APP_SECRET");
  const appToken = readEnv("LARK_BASE_APP_TOKEN", "FEISHU_BASE_APP_TOKEN");
  const tableId = readEnv("LARK_BASE_TABLE_ID", "FEISHU_BASE_TABLE_ID");
  const openApiDomain = readEnv("LARK_OPEN_API_DOMAIN", "FEISHU_OPEN_API_DOMAIN") || "https://open.feishu.cn";

  const missing: string[] = [];
  if (!appId) missing.push("LARK_APP_ID");
  if (!appSecret) missing.push("LARK_APP_SECRET");
  if (!appToken) missing.push("LARK_BASE_APP_TOKEN");
  if (!tableId) missing.push("LARK_BASE_TABLE_ID");

  if (missing.length > 0) {
    return { ok: false, missingKeys: missing };
  }

  return {
    ok: true,
    config: {
      appId,
      appSecret,
      appToken,
      tableId,
      openApiDomain: openApiDomain.replace(/\/+$/, ""),
    },
  };
}

/**
 * 商品池使用独立的数据表配置。
 *
 * 这里刻意不回退到 LARK_BASE_TABLE_ID：商品池字段契约不满足时，必须 fail-closed，
 * 不能因为新配置缺失而再次访问旧 Research Export 表。
 */
export function getLarkCommodityPoolConfig(): GetLarkConfigResult {
  const appId = readEnv("LARK_APP_ID", "FEISHU_APP_ID");
  const appSecret = readEnv("LARK_APP_SECRET", "FEISHU_APP_SECRET");
  const appToken = readEnv("LARK_BASE_APP_TOKEN", "FEISHU_BASE_APP_TOKEN");
  const tableId = readEnv("LARK_COMMODITY_POOL_TABLE_ID");
  const openApiDomain = readEnv("LARK_OPEN_API_DOMAIN", "FEISHU_OPEN_API_DOMAIN") || "https://open.feishu.cn";

  const missing: string[] = [];
  if (!appId) missing.push("LARK_APP_ID");
  if (!appSecret) missing.push("LARK_APP_SECRET");
  if (!appToken) missing.push("LARK_BASE_APP_TOKEN");
  if (!tableId) missing.push("LARK_COMMODITY_POOL_TABLE_ID");

  if (missing.length > 0) {
    return { ok: false, missingKeys: missing };
  }

  return {
    ok: true,
    config: {
      appId,
      appSecret,
      appToken,
      tableId,
      openApiDomain: openApiDomain.replace(/\/+$/, ""),
    },
  };
}

export function isLarkConfigured(): boolean {
  return getLarkConfig().ok;
}

export type RedactedLarkConfig = {
  readonly configured: boolean;
  readonly appId?: string;
  readonly appToken?: string;
  readonly tableId?: string;
  readonly openApiDomain?: string;
  readonly missingKeys?: readonly string[];
};

export function getRedactedLarkConfig(): RedactedLarkConfig {
  const result = getLarkConfig();
  if (!result.ok) {
    return {
      configured: false,
      missingKeys: result.missingKeys,
    };
  }
  return {
    configured: true,
    appId: result.config.appId,
    appToken: result.config.appToken,
    tableId: result.config.tableId,
    openApiDomain: result.config.openApiDomain,
  };
}
