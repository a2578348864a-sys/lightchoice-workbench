import "server-only";

import { createHash } from "node:crypto";
import { batchCreateRecords, batchUpdateRecords, listTableFields, readBitableTextValue, searchTableRecords, type LarkClientOptions } from "./baseClient";
import { getProductProjectLarkConfig } from "./productProjectConfig";
import type { LarkConfig, LarkFieldMeta, LarkPreflightResult } from "./types";
import type { MarketOpportunityRecordView } from "@/lib/marketOpportunity/types";
import type { ProductConceptSnapshot } from "@/lib/marketOpportunity/concept";

const FIELDS = [
  { name: "ConceptID", expectedTypes: [1], required: true },
  { name: "OpportunityID", expectedTypes: [1], required: true },
  { name: "Name", expectedTypes: [1], required: true },
  { name: "Revision", expectedTypes: [2], required: true },
  { name: "HumanDecision", expectedTypes: [1, 3], required: true },
  { name: "OpportunityURL", expectedTypes: [1, 15], required: true },
  { name: "MissingValidation", expectedTypes: [1], required: true },
  { name: "FactRefs", expectedTypes: [1], required: true },
  { name: "ResearchRefs", expectedTypes: [1], required: true },
  { name: "ExportedAt", expectedTypes: [1, 5], required: true },
] as const;

export type ProductProjectSyncResult = {
  readonly status: "SYNCED" | "FAILED";
  readonly tableId: string | null;
  readonly recordId: string | null;
  readonly viewUrl: string | null;
  readonly idempotencyKey: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

function key(concept: ProductConceptSnapshot, tableId: string): string {
  return createHash("sha256").update(`${concept.conceptId}|${tableId}|product-project.v1`, "utf8").digest("hex");
}

function fieldsOf(concept: ProductConceptSnapshot, opportunity: MarketOpportunityRecordView, appBaseUrl = ""): Record<string, unknown> {
  const opportunityUrl = `${appBaseUrl.replace(/\/+$/u, "")}/market-opportunities/${encodeURIComponent(opportunity.id)}`;
  return {
    ConceptID: concept.conceptId,
    OpportunityID: opportunity.id,
    Name: opportunity.name,
    Revision: concept.revision,
    HumanDecision: concept.humanDecision.status,
    OpportunityURL: opportunityUrl,
    MissingValidation: concept.missingValidation.join("\n"),
    FactRefs: concept.factRefs.map((ref) => `${ref.refId}:${ref.path}`).join("\n"),
    ResearchRefs: concept.researchRefs.map((ref) => `${ref.refId}:${ref.path}`).join("\n"),
    ExportedAt: new Date().toISOString(),
  };
}

function validate(fields: readonly LarkFieldMeta[]): Pick<LarkPreflightResult, "writable" | "missingFields" | "missingWriteFields" | "missingOptionalFields" | "incompatibleFields" | "fieldMapping"> {
  const byName = new Map(fields.map((field) => [field.fieldName.trim(), field]));
  const missingFields: string[] = [];
  const incompatibleFields: LarkPreflightResult["incompatibleFields"] extends readonly (infer T)[] ? T[] : never[] = [];
  const fieldMapping: Record<string, LarkFieldMeta> = {};
  for (const definition of FIELDS) {
    const field = byName.get(definition.name);
    if (!field) {
      if (definition.required) missingFields.push(definition.name);
      continue;
    }
    fieldMapping[definition.name] = field;
    if (!(definition.expectedTypes as readonly number[]).includes(field.type)) incompatibleFields.push({ fieldName: definition.name, expectedType: definition.expectedTypes.join(" | "), actualType: `${field.type} (${field.uiType})` });
  }
  return {
    writable: missingFields.length === 0 && incompatibleFields.length === 0,
    missingFields,
    missingWriteFields: missingFields,
    missingOptionalFields: [],
    incompatibleFields,
    fieldMapping,
  };
}

export async function preflightProductProjectLark(options: { readonly config?: LarkConfig; readonly clientOptions?: LarkClientOptions } = {}): Promise<LarkPreflightResult> {
  const result = options.config ? { ok: true as const, config: options.config } : getProductProjectLarkConfig();
  if (!result.ok) {
    return { configured: false, connected: false, baseAccessible: false, tableAccessible: false, writable: false, missingFields: [], missingWriteFields: [], missingOptionalFields: [], incompatibleFields: [], fieldMapping: {}, missingConfigKeys: result.missingKeys, errorCode: "LARK_PRODUCT_PROJECT_CONFIG_MISSING", errorMessage: `产品开发项目飞书配置缺失: ${result.missingKeys.join(", ")}` };
  }
  try {
    const remoteFields = await listTableFields(result.config, options.clientOptions);
    const checked = validate(remoteFields);
    return { configured: true, connected: true, baseAccessible: true, tableAccessible: true, appToken: result.config.appToken, tableId: result.config.tableId, ...checked, errorCode: checked.writable ? undefined : "PRODUCT_PROJECT_TABLE_FIELDS_MISMATCH", errorMessage: checked.writable ? undefined : "产品开发项目飞书表字段契约不完整。" };
  } catch (error) {
    return { configured: true, connected: false, baseAccessible: false, tableAccessible: false, writable: false, appToken: result.config.appToken, tableId: result.config.tableId, missingFields: [], missingWriteFields: [], missingOptionalFields: [], incompatibleFields: [], fieldMapping: {}, errorCode: (error as { code?: string }).code ?? "LARK_CONNECTION_FAILED", errorMessage: error instanceof Error ? error.message : "产品开发项目飞书连接失败。" };
  }
}

function failure(tableId: string | null, idempotencyKey: string, errorCode: string, errorMessage: string): ProductProjectSyncResult {
  return { status: "FAILED", tableId, recordId: null, viewUrl: null, idempotencyKey, errorCode, errorMessage };
}

export async function syncProductProject(input: { readonly opportunity: MarketOpportunityRecordView; readonly concept: ProductConceptSnapshot; readonly config?: LarkConfig; readonly clientOptions?: LarkClientOptions; readonly appBaseUrl?: string }): Promise<ProductProjectSyncResult> {
  if (input.concept.sourceBinding || !input.concept.opportunityId || input.concept.opportunityId !== input.opportunity.id) {
    return failure(null, key(input.concept, ""), "PRODUCT_CONCEPT_SOURCE_MISMATCH", "历史 MarketOpportunity 同步只接受绑定同一 opportunityId 的 V4 概念。");
  }
  if (input.concept.humanDecision.status !== "APPROVE") return failure(null, key(input.concept, ""), "CONCEPT_APPROVE_REQUIRED", "只有 APPROVE 的产品概念才能创建飞书 Product Project。");
  const configResult = input.config ? { ok: true as const, config: input.config } : getProductProjectLarkConfig();
  if (!configResult.ok) return failure(null, key(input.concept, ""), "LIVE_SYNC_BLOCKED_BY_CREDENTIALS", `未配置产品开发项目飞书凭据 (${configResult.missingKeys.join(", ")})，已安全拦截。`);
  const config = configResult.config;
  const idempotencyKey = key(input.concept, config.tableId);
  const preflight = await preflightProductProjectLark({ config, clientOptions: input.clientOptions });
  if (!preflight.writable) return failure(config.tableId, idempotencyKey, preflight.errorCode ?? "PREFLIGHT_FAILED", preflight.errorMessage ?? "产品开发项目飞书表预检未通过。");
  try {
    const existing = await searchTableRecords(config, { fieldNames: ["ConceptID"], filter: { conjunction: "or", conditions: [{ field_name: "ConceptID", operator: "is", value: [input.concept.conceptId] }] }, pageSize: 100 }, input.clientOptions);
    const matches = existing.filter((item) => readBitableTextValue(item.fields.ConceptID) === input.concept.conceptId);
    if (matches.length > 1) return failure(config.tableId, idempotencyKey, "DUPLICATE_PRODUCT_PROJECT_RECORDS", "同一 ConceptID 在飞书中存在多条记录，已阻止写入。");
    const rowFields = fieldsOf(input.concept, input.opportunity, input.appBaseUrl);
    if (matches.length === 1) {
      const updated = await batchUpdateRecords(config, [{ record_id: matches[0].record_id, fields: rowFields }], input.clientOptions);
      return { status: "SYNCED", tableId: config.tableId, recordId: updated[0]?.record_id ?? matches[0].record_id, viewUrl: null, idempotencyKey };
    }
    const created = await batchCreateRecords(config, [{ fields: rowFields }], input.clientOptions);
    return { status: "SYNCED", tableId: config.tableId, recordId: created[0]?.record_id ?? null, viewUrl: null, idempotencyKey };
  } catch (error) {
    return failure(config.tableId, idempotencyKey, (error as { code?: string }).code ?? "LARK_SYNC_FAILED", error instanceof Error ? error.message : "产品开发项目同步失败。");
  }
}

/** V5 Research-bound Product Project export. OpportunityID stays empty; a Research task is never relabeled as an opportunity. */
export async function syncProductProjectForResearch(input: {
  readonly concept: ProductConceptSnapshot;
  readonly researchTaskId: string;
  readonly researchTitle: string;
  readonly config?: LarkConfig;
  readonly clientOptions?: LarkClientOptions;
  readonly appBaseUrl?: string;
}): Promise<ProductProjectSyncResult> {
  if (input.concept.humanDecision.status !== "APPROVE" || !input.concept.sourceBinding
    || input.concept.sourceBinding.researchTaskId !== input.researchTaskId) {
    return failure(null, key(input.concept, ""), "CONCEPT_APPROVE_REQUIRED", "只有绑定当前 Research 且已人工 APPROVE 的概念才能同步。");
  }
  const configResult = input.config ? { ok: true as const, config: input.config } : getProductProjectLarkConfig();
  if (!configResult.ok) return failure(null, key(input.concept, ""), "LIVE_SYNC_BLOCKED_BY_CREDENTIALS", `未配置产品开发项目飞书凭据 (${configResult.missingKeys.join(", ")})，已安全拦截。`);
  const config = configResult.config;
  const idempotencyKey = key(input.concept, config.tableId);
  const preflight = await preflightProductProjectLark({ config, clientOptions: input.clientOptions });
  if (!preflight.writable) return failure(config.tableId, idempotencyKey, preflight.errorCode ?? "PREFLIGHT_FAILED", preflight.errorMessage ?? "产品开发项目飞书表预检未通过。");
  try {
    const existing = await searchTableRecords(config, { fieldNames: ["ConceptID"], filter: { conjunction: "or", conditions: [{ field_name: "ConceptID", operator: "is", value: [input.concept.conceptId] }] }, pageSize: 100 }, input.clientOptions);
    const matches = existing.filter((item) => readBitableTextValue(item.fields.ConceptID) === input.concept.conceptId);
    if (matches.length > 1) return failure(config.tableId, idempotencyKey, "DUPLICATE_PRODUCT_PROJECT_RECORDS", "同一 ConceptID 在飞书中存在多条记录，已阻止写入。");
    const appBaseUrl = (input.appBaseUrl ?? process.env.QX_PUBLIC_ORIGIN ?? "http://127.0.0.1:3010").replace(/\/+$/u, "");
    const researchUrl = `${appBaseUrl}/research/${encodeURIComponent(input.researchTaskId)}`;
    const rowFields: Record<string, unknown> = {
      ConceptID: input.concept.conceptId,
      OpportunityID: "",
      Name: input.researchTitle,
      Revision: input.concept.revision,
      HumanDecision: input.concept.humanDecision.status,
      OpportunityURL: researchUrl,
      MissingValidation: input.concept.missingValidation.join("\n"),
      FactRefs: (input.concept.traceableItems ?? []).filter((item) => item.nature === "confirmed_fact").flatMap((item) => item.evidenceRefs).join("\n"),
      ResearchRefs: input.concept.researchRefs.map((ref) => `${ref.refId}:${ref.path}`).join("\n"),
      ExportedAt: new Date().toISOString(),
    };
    if (matches.length === 1) {
      const updated = await batchUpdateRecords(config, [{ record_id: matches[0].record_id, fields: rowFields }], input.clientOptions);
      return { status: "SYNCED", tableId: config.tableId, recordId: updated[0]?.record_id ?? matches[0].record_id, viewUrl: null, idempotencyKey };
    }
    const created = await batchCreateRecords(config, [{ fields: rowFields }], input.clientOptions);
    return { status: "SYNCED", tableId: config.tableId, recordId: created[0]?.record_id ?? null, viewUrl: null, idempotencyKey };
  } catch (error) {
    return failure(config.tableId, idempotencyKey, (error as { code?: string }).code ?? "LARK_SYNC_FAILED", error instanceof Error ? error.message : "产品开发项目同步失败。");
  }
}
