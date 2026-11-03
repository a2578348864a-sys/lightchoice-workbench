import "server-only";

import { getTenantAccessToken } from "./auth";
import { defaultLarkFetch } from "./transport";
import type { LarkConfig, LarkFieldMeta, LarkTableFieldInput, LarkTableMeta } from "./types";

export class LarkApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly larkCode?: number,
  ) {
    super(message);
    this.name = "LarkApiError";
  }
}

export type LarkBitableRecord<T = Record<string, unknown>> = {
  readonly record_id: string;
  readonly fields: T;
  readonly created_by?: { readonly id: string };
  readonly created_time?: number;
  readonly last_modified_by?: { readonly id: string };
  readonly last_modified_time?: number;
};

export type LarkCreateTableInput = {
  readonly name: string;
  readonly default_view_name?: string;
  readonly fields?: readonly LarkTableFieldInput[];
};

export type LarkClientOptions = {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** 飞书 Bitable batch API 的请求级幂等标识。重试同一 HTTP 请求时保持不变。 */
  readonly clientToken?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

function larkHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

async function requestWithRetry<T>(
  url: string,
  init: RequestInit,
  options: LarkClientOptions = {},
): Promise<T> {
  const fetcher = options.fetcher ?? defaultLarkFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timer);
      const isTimeout = fetchErr instanceof Error && fetchErr.name === "AbortError";
      if (attempt <= maxRetries && isTimeout) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      throw new LarkApiError(
        isTimeout ? "lark_api_timeout" : "lark_api_network_error",
        isTimeout ? `飞书接口请求超时 (${timeoutMs}ms)` : `飞书网络连接失败: ${fetchErr instanceof Error ? fetchErr.message : "未知"}`,
        isTimeout ? 504 : 502,
      );
    } finally {
      clearTimeout(timer);
    }

    // 429 速率限制重试
    if (response.status === 429 && attempt <= maxRetries) {
      const resetHeader = response.headers.get("x-ogw-ratelimit-reset");
      const waitSeconds = resetHeader ? Number.parseFloat(resetHeader) : 1;
      const waitMs = Number.isFinite(waitSeconds) && waitSeconds > 0
        ? Math.min(waitSeconds * 1000, 3000)
        : 1000 * attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LarkApiError(
        "lark_api_invalid_json",
        `飞书响应无法被解析为 JSON (HTTP ${response.status})`,
        502,
      );
    }

    if (
      typeof payload !== "object"
      || payload === null
      || typeof (payload as { code?: unknown }).code !== "number"
    ) {
      throw new LarkApiError(
        "lark_api_malformed_response",
        "飞书响应结构不符合开放平台规范",
        502,
      );
    }

    const data = payload as {
      code: number;
      msg?: string;
      data?: T;
    };

    if (data.code !== 0) {
      throw new LarkApiError(
        `lark_api_failed_${data.code}`,
        `飞书 API 调用失败 (${data.code}): ${data.msg || "未知错误"}`,
        response.status >= 400 ? response.status : 400,
        data.code,
      );
    }

    return (data.data ?? {}) as T;
  }
}

/**
 * 读取多维表格字段列表。
 */
export async function listTableFields(
  config: LarkConfig,
  options: LarkClientOptions = {},
): Promise<readonly LarkFieldMeta[]> {
  const token = await getTenantAccessToken(config, { fetcher: options.fetcher });
  const url = `${config.openApiDomain}/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/fields?page_size=100`;

  const result = await requestWithRetry<{
    items?: readonly {
      field_id: string;
      field_name: string;
      type: number;
      ui_type: string;
      is_primary?: boolean;
    }[];
  }>(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
    options,
  );

  const items = result.items || [];
  return items.map((item) => ({
    fieldId: item.field_id,
    fieldName: item.field_name,
    type: item.type,
    uiType: item.ui_type,
    isPrimary: item.is_primary,
  }));
}

/** 列出当前 Base 内的数据表，不修改远端状态。 */
export async function listTables(
  config: LarkConfig,
  options: LarkClientOptions = {},
): Promise<readonly LarkTableMeta[]> {
  const token = await getTenantAccessToken(config, { fetcher: options.fetcher });
  const items: LarkTableMeta[] = [];
  let pageToken: string | undefined;

  while (true) {
    const url = new URL(`${config.openApiDomain}/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables`);
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const result = await requestWithRetry<{
      items?: readonly { table_id: string; name: string }[];
      has_more?: boolean;
      page_token?: string;
    }>(url.toString(), { method: "GET", headers: larkHeaders(token) }, options);

    items.push(...(result.items ?? []).map((item) => ({ tableId: item.table_id, name: item.name })));
    if (!result.has_more) break;
    if (!result.page_token) {
      throw new LarkApiError("lark_api_pagination_invalid", "飞书 tables 列表返回 has_more，但缺少 page_token。", 502);
    }
    pageToken = result.page_token;
  }

  return items;
}

/** 在指定 Base 内新增数据表。 */
export async function createTable(
  config: LarkConfig,
  table: LarkCreateTableInput,
  options: LarkClientOptions = {},
): Promise<string> {
  const token = await getTenantAccessToken(config, { fetcher: options.fetcher });
  const url = `${config.openApiDomain}/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables`;
  const result = await requestWithRetry<{ table_id?: string }>(
    url,
    {
      method: "POST",
      headers: larkHeaders(token),
      body: JSON.stringify({ table }),
    },
    options,
  );
  if (!result.table_id) {
    throw new LarkApiError("lark_api_missing_table_id", "飞书创建数据表响应缺少 table_id。", 502);
  }
  return result.table_id;
}

/** 在指定数据表内新增字段。只接受官方公开字段参数。 */
export async function createTableField(
  config: LarkConfig,
  field: LarkTableFieldInput,
  options: LarkClientOptions = {},
): Promise<string | undefined> {
  const token = await getTenantAccessToken(config, { fetcher: options.fetcher });
  const url = `${config.openApiDomain}/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/fields`;
  const result = await requestWithRetry<{ field_id?: string }>(
    url,
    {
      method: "POST",
      headers: larkHeaders(token),
      body: JSON.stringify(field),
    },
    options,
  );
  return result.field_id;
}

/**
 * 解析飞书回读的文本字段值。
 *
 * 飞书 `records/search` 对文本字段的回读形态并不唯一：
 * - 多行文本：`[{ text: "B0XXX", type: "text" }]`
 * - 单行文本 / 部分场景：纯 `string`
 * - 空值：`null` 或字段缺失
 *
 * 历史实现在幂等查重时只接受 `string`，导致真实 Base 上 ASIN 永远读成空字符串，
 * 已有记录索引恒为空 → 每次同步都 create，产生重复记录（真实环境已复现）。
 * 该函数把上述形态统一归一为去空白字符串。
 */
export function readBitableTextValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item !== null && typeof item === "object") {
          const text = (item as { text?: unknown }).text;
          if (typeof text === "string") return text;
          const name = (item as { name?: unknown }).name;
          if (typeof name === "string") return name;
        }
        return "";
      })
      .join("")
      .trim();
  }
  if (value !== null && typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text.trim();
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return name.trim();
  }
  return "";
}

/**
 * 按照条件查询记录（用于通过 ASIN 检查是否存在以保证幂等）。
 */
export async function searchTableRecords(
  config: LarkConfig,
  query: {
    fieldNames?: readonly string[];
    filter?: Record<string, unknown>;
    pageSize?: number;
    /** Request platform-generated created/modified actor and timestamp metadata. */
    automaticFields?: boolean;
    /** Phase 5 records an app-stable identity only; broader tenant/developer IDs are not enabled here. */
    userIdType?: "open_id";
  },
  options: LarkClientOptions = {},
): Promise<readonly LarkBitableRecord[]> {
  const token = await getTenantAccessToken(config, { fetcher: options.fetcher });
  const pageSize = query.pageSize ?? 100;
  const bodyPayload: Record<string, unknown> = {};
  if (query.fieldNames && query.fieldNames.length > 0) {
    bodyPayload.field_names = query.fieldNames;
  }
  if (query.filter) {
    bodyPayload.filter = query.filter;
  }
  if (query.automaticFields !== undefined) {
    bodyPayload.automatic_fields = query.automaticFields;
  }

  const items: {
    record_id: string;
    fields: Record<string, unknown>;
    created_by?: { id?: string };
    created_time?: number;
    last_modified_by?: { id?: string };
    last_modified_time?: number;
  }[] = [];
  let pageToken: string | undefined;

  while (true) {
    const searchUrl = new URL(
      `${config.openApiDomain}/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records/search`,
    );
    searchUrl.searchParams.set("page_size", String(pageSize));
    if (pageToken) searchUrl.searchParams.set("page_token", pageToken);
    if (query.userIdType) searchUrl.searchParams.set("user_id_type", query.userIdType);

    const result = await requestWithRetry<{
      items?: readonly {
        record_id: string;
        fields: Record<string, unknown>;
        created_by?: { id?: string };
        created_time?: number;
        last_modified_by?: { id?: string };
        last_modified_time?: number;
      }[];
      total?: number;
      has_more?: boolean;
      page_token?: string;
    }>(
      searchUrl.toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(bodyPayload),
      },
      options,
    );

    items.push(...(result.items || []));
    if (!result.has_more) break;
    if (!result.page_token) {
      throw new LarkApiError(
        "lark_api_pagination_invalid",
        "飞书 records/search 返回 has_more，但缺少 page_token。",
        502,
      );
    }
    pageToken = result.page_token;
  }

  return items.map((item) => ({
    record_id: item.record_id,
    fields: item.fields,
    ...(typeof item.created_by?.id === "string" ? { created_by: { id: item.created_by.id } } : {}),
    ...(typeof item.created_time === "number" && Number.isFinite(item.created_time) ? { created_time: item.created_time } : {}),
    ...(typeof item.last_modified_by?.id === "string" ? { last_modified_by: { id: item.last_modified_by.id } } : {}),
    ...(typeof item.last_modified_time === "number" && Number.isFinite(item.last_modified_time) ? { last_modified_time: item.last_modified_time } : {}),
  }));
}

/**
 * 批量新增记录。
 */
export async function batchCreateRecords(
  config: LarkConfig,
  records: readonly { fields: Record<string, unknown> }[],
  options: LarkClientOptions = {},
): Promise<readonly LarkBitableRecord[]> {
  if (records.length === 0) return [];
  const token = await getTenantAccessToken(config, { fetcher: options.fetcher });
  const requestUrl = new URL(
    `${config.openApiDomain}/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records/batch_create`,
  );
  if (options.clientToken) requestUrl.searchParams.set("client_token", options.clientToken);

  const result = await requestWithRetry<{
    records?: readonly {
      record_id: string;
      fields: Record<string, unknown>;
    }[];
  }>(
    requestUrl.toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ records }),
    },
    options,
  );

  return (result.records || []).map((r) => ({
    record_id: r.record_id,
    fields: r.fields,
  }));
}

/**
 * 批量更新记录。
 */
export async function batchUpdateRecords(
  config: LarkConfig,
  records: readonly { record_id: string; fields: Record<string, unknown> }[],
  options: LarkClientOptions = {},
): Promise<readonly LarkBitableRecord[]> {
  if (records.length === 0) return [];
  const token = await getTenantAccessToken(config, { fetcher: options.fetcher });
  const requestUrl = new URL(
    `${config.openApiDomain}/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables/${encodeURIComponent(config.tableId)}/records/batch_update`,
  );
  if (options.clientToken) requestUrl.searchParams.set("client_token", options.clientToken);

  const result = await requestWithRetry<{
    records?: readonly {
      record_id: string;
      fields: Record<string, unknown>;
    }[];
  }>(
    requestUrl.toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ records }),
    },
    options,
  );

  return (result.records || []).map((r) => ({
    record_id: r.record_id,
    fields: r.fields,
  }));
}
