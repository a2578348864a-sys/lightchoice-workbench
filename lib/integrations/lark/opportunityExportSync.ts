import "server-only";

import { batchCreateRecords, batchUpdateRecords, listTableFields, readBitableTextValue, searchTableRecords, type LarkBitableRecord, type LarkClientOptions } from "./baseClient";
import { getOpportunityLarkConfig } from "./opportunityConfig";
import type { LarkConfig, LarkFieldMeta, LarkPreflightResult } from "./types";
import { buildOpportunityExportRecord, opportunityExportFields, opportunityIdempotencyKey } from "@/lib/marketOpportunity/export";
import type { MarketOpportunityRecordView, OpportunityExportRecord } from "@/lib/marketOpportunity/types";

const OPPORTUNITY_TABLE_FIELDS = [
  { name: "OpportunityID", expectedTypes: [1], requiredForSync: true },
  { name: "Name", expectedTypes: [1], requiredForSync: true },
  { name: "Marketplace", expectedTypes: [1], requiredForSync: true },
  { name: "NicheKind", expectedTypes: [1], requiredForSync: true },
  { name: "LatestMarketScanID", expectedTypes: [1], requiredForSync: true },
  { name: "SampleCount", expectedTypes: [2], requiredForSync: true },
  { name: "MetricsSummary", expectedTypes: [1], requiredForSync: true },
  { name: "HumanDecision", expectedTypes: [1, 3], requiredForSync: true },
  { name: "DecisionReason", expectedTypes: [1], requiredForSync: true },
  { name: "OpportunityURL", expectedTypes: [1, 15], requiredForSync: true },
  { name: "ExportedAt", expectedTypes: [1, 5], requiredForSync: true },
] as const;

export type OpportunityLarkSyncResult = {
  readonly status: "SYNCED" | "FAILED";
  readonly tableId: string | null;
  readonly recordId: string | null;
  readonly viewUrl: string | null;
  readonly idempotencyKey: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export function validateOpportunityTableFields(
  fields: readonly LarkFieldMeta[],
): Pick<LarkPreflightResult, "writable" | "missingFields" | "missingWriteFields" | "missingOptionalFields" | "incompatibleFields" | "fieldMapping"> {
  const byName = new Map(fields.map((field) => [field.fieldName.trim(), field]));
  const missingRequiredFields: string[] = [];
  const missingOptionalFields: string[] = [];
  const incompatibleFields: LarkPreflightResult["incompatibleFields"] extends readonly (infer T)[] ? T[] : never[] = [];
  const fieldMapping: Record<string, LarkFieldMeta> = {};
  for (const definition of OPPORTUNITY_TABLE_FIELDS) {
    const field = byName.get(definition.name);
    if (!field) {
      (definition.requiredForSync ? missingRequiredFields : missingOptionalFields).push(definition.name);
      continue;
    }
    fieldMapping[definition.name] = field;
    if (!(definition.expectedTypes as readonly number[]).includes(field.type)) {
      incompatibleFields.push({
        fieldName: definition.name,
        expectedType: definition.expectedTypes.join(" | "),
        actualType: `${field.type} (${field.uiType})`,
      });
    }
  }
  const missingWriteFields = [...missingRequiredFields, ...missingOptionalFields];
  return {
    writable: missingWriteFields.length === 0 && incompatibleFields.length === 0,
    missingFields: missingRequiredFields,
    missingWriteFields,
    missingOptionalFields,
    incompatibleFields,
    fieldMapping,
  };
}

export async function preflightOpportunityLark(options: {
  readonly config?: LarkConfig;
  readonly clientOptions?: LarkClientOptions;
} = {}): Promise<LarkPreflightResult> {
  const configResult = options.config
    ? { ok: true as const, config: options.config }
    : getOpportunityLarkConfig();
  if (!configResult.ok) {
    return {
      configured: false,
      connected: false,
      baseAccessible: false,
      tableAccessible: false,
      writable: false,
      missingFields: [],
      missingWriteFields: [],
      missingOptionalFields: [],
      incompatibleFields: [],
      fieldMapping: {},
      missingConfigKeys: configResult.missingKeys,
      errorCode: "LARK_OPPORTUNITY_CONFIG_MISSING",
      errorMessage: `机会池飞书配置缺失: ${configResult.missingKeys.join(", ")}`,
    };
  }
  try {
    const remoteFields = await listTableFields(configResult.config, options.clientOptions);
    const validation = validateOpportunityTableFields(remoteFields);
    return {
      configured: true,
      connected: true,
      baseAccessible: true,
      tableAccessible: true,
      appToken: configResult.config.appToken,
      tableId: configResult.config.tableId,
      ...validation,
      errorCode: validation.writable ? undefined : "OPPORTUNITY_TABLE_FIELDS_MISMATCH",
      errorMessage: validation.writable ? undefined : "机会池飞书表字段契约不完整或类型不兼容。",
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      baseAccessible: false,
      tableAccessible: false,
      writable: false,
      appToken: configResult.config.appToken,
      tableId: configResult.config.tableId,
      missingFields: [],
      missingWriteFields: [],
      missingOptionalFields: [],
      incompatibleFields: [],
      fieldMapping: {},
      errorCode: (error as { code?: string }).code ?? "LARK_CONNECTION_FAILED",
      errorMessage: error instanceof Error ? error.message : "机会池飞书连接失败。",
    };
  }
}

function resultFailure(input: {
  readonly tableId: string | null;
  readonly idempotencyKey: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}): OpportunityLarkSyncResult {
  return { status: "FAILED", recordId: null, viewUrl: null, ...input };
}

export async function syncOpportunityExport(
  record: MarketOpportunityRecordView,
  options: {
    readonly config?: LarkConfig;
    readonly clientOptions?: LarkClientOptions;
    readonly appBaseUrl?: string;
  } = {},
): Promise<OpportunityLarkSyncResult> {
  const preGateKey = opportunityIdempotencyKey(record);
  if (record.humanDecision?.status !== "CONTINUE") {
    return resultFailure({
      tableId: null,
      idempotencyKey: preGateKey,
      errorCode: "HUMAN_CONTINUE_REQUIRED",
      errorMessage: "只有人工决策为 CONTINUE 时才允许同步机会池。",
    });
  }
  const configResult = options.config
    ? { ok: true as const, config: options.config }
    : getOpportunityLarkConfig();
  if (!configResult.ok) {
    return resultFailure({
      tableId: null,
      idempotencyKey: preGateKey,
      errorCode: "LIVE_SYNC_BLOCKED_BY_CREDENTIALS",
      errorMessage: `未配置机会池飞书凭据 (${configResult.missingKeys.join(", ")})，已安全拦截。`,
    });
  }
  const config = configResult.config;
  const idempotencyKey = opportunityIdempotencyKey(record, config.tableId);
  const preflight = await preflightOpportunityLark({ config, clientOptions: options.clientOptions });
  if (!preflight.writable) {
    return resultFailure({
      tableId: config.tableId,
      idempotencyKey,
      errorCode: preflight.errorCode ?? "PREFLIGHT_FAILED",
      errorMessage: preflight.errorMessage ?? "机会池飞书表预检未通过。",
    });
  }

  const exportRecord = buildOpportunityExportRecord(record, { appBaseUrl: options.appBaseUrl });
  const rowFields = opportunityExportFields(exportRecord);
  try {
    const existing = await searchTableRecords(config, {
      fieldNames: ["OpportunityID"],
      filter: {
        conjunction: "or",
        conditions: [{ field_name: "OpportunityID", operator: "is", value: [record.id] }],
      },
      pageSize: 100,
    }, options.clientOptions);
    const matches = existing.filter((item) => readBitableTextValue(item.fields.OpportunityID) === record.id);
    if (matches.length > 1) {
      return resultFailure({
        tableId: config.tableId,
        idempotencyKey,
        errorCode: "DUPLICATE_OPPORTUNITY_RECORDS",
        errorMessage: `OpportunityID ${record.id} 在飞书中存在 ${matches.length} 条记录，已阻止写入。`,
      });
    }
    if (matches.length === 1) {
      const updated = await batchUpdateRecords(config, [{ record_id: matches[0].record_id, fields: rowFields }], options.clientOptions);
      return {
        status: "SYNCED",
        tableId: config.tableId,
        recordId: updated[0]?.record_id ?? matches[0].record_id,
        viewUrl: null,
        idempotencyKey,
      };
    }
    const created = await batchCreateRecords(config, [{ fields: rowFields }], options.clientOptions);
    return {
      status: "SYNCED",
      tableId: config.tableId,
      recordId: created[0]?.record_id ?? null,
      viewUrl: null,
      idempotencyKey,
    };
  } catch (error) {
    return resultFailure({
      tableId: config.tableId,
      idempotencyKey,
      errorCode: (error as { code?: string }).code ?? "LARK_SYNC_FAILED",
      errorMessage: error instanceof Error ? error.message : "机会池同步失败。",
    });
  }
}

export function opportunityExportRecordForTests(record: MarketOpportunityRecordView): OpportunityExportRecord {
  return buildOpportunityExportRecord(record);
}
