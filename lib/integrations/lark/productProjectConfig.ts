import "server-only";

import type { LarkConfig } from "./types";

export type GetProductProjectLarkConfigResult =
  | { readonly ok: true; readonly config: LarkConfig }
  | { readonly ok: false; readonly missingKeys: readonly string[] };

function env(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

/** Product Project 使用自己的表 ID；绝不回退到机会池或 Research 表。 */
export function getProductProjectLarkConfig(): GetProductProjectLarkConfigResult {
  const appId = env("LARK_PRODUCT_PROJECT_APP_ID", "FEISHU_PRODUCT_PROJECT_APP_ID", "LARK_APP_ID", "FEISHU_APP_ID");
  const appSecret = env("LARK_PRODUCT_PROJECT_APP_SECRET", "FEISHU_PRODUCT_PROJECT_APP_SECRET", "LARK_APP_SECRET", "FEISHU_APP_SECRET");
  const appToken = env("LARK_PRODUCT_PROJECT_APP_TOKEN", "FEISHU_PRODUCT_PROJECT_APP_TOKEN", "LARK_BASE_APP_TOKEN", "FEISHU_BASE_APP_TOKEN");
  const tableId = env("LARK_PRODUCT_PROJECT_TABLE_ID", "FEISHU_PRODUCT_PROJECT_TABLE_ID");
  const openApiDomain = env("LARK_PRODUCT_PROJECT_OPEN_API_DOMAIN", "FEISHU_PRODUCT_PROJECT_OPEN_API_DOMAIN", "LARK_OPEN_API_DOMAIN", "FEISHU_OPEN_API_DOMAIN") || "https://open.feishu.cn";
  const missingKeys: string[] = [];
  if (!appId) missingKeys.push("LARK_PRODUCT_PROJECT_APP_ID");
  if (!appSecret) missingKeys.push("LARK_PRODUCT_PROJECT_APP_SECRET");
  if (!appToken) missingKeys.push("LARK_PRODUCT_PROJECT_APP_TOKEN");
  if (!tableId) missingKeys.push("LARK_PRODUCT_PROJECT_TABLE_ID");
  if (missingKeys.length > 0) return { ok: false, missingKeys };
  return {
    ok: true,
    config: { appId, appSecret, appToken, tableId, openApiDomain: openApiDomain.replace(/\/+$/u, "") },
  };
}
