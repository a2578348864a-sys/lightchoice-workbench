import type { ResearchExportRecord } from "@/lib/research/researchContracts";

export type LarkConfig = {
  readonly appId: string;
  readonly appSecret: string;
  readonly appToken: string;
  readonly tableId: string;
  readonly openApiDomain: string;
};

export type LarkIncompatibleField = {
  readonly fieldName: string;
  readonly expectedType: string;
  readonly actualType: string;
};

export type LarkFieldMeta = {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly type: number;
  readonly uiType: string;
  readonly isPrimary?: boolean;
};

export type LarkTableMeta = {
  readonly tableId: string;
  readonly name: string;
};

export type LarkTableFieldInput = {
  readonly field_name: string;
  readonly type: number;
  readonly ui_type?: string;
};

export type LarkPreflightResult = {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly baseAccessible: boolean;
  readonly tableAccessible: boolean;
  readonly writable: boolean;
  readonly appToken?: string;
  readonly tableId?: string;
  readonly missingFields: readonly string[];
  /**
   * 真实写入行所需的字段中，远端表缺失的全部字段名（必须 + 可选）。
   * 与 missingFields 同时暴露，避免「可选字段缺失」被静默掉。
   */
  readonly missingWriteFields: readonly string[];
  readonly missingOptionalFields: readonly string[];
  readonly incompatibleFields: readonly LarkIncompatibleField[];
  readonly fieldMapping: Record<string, LarkFieldMeta>;
  readonly missingConfigKeys?: readonly string[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type LarkSyncRecordAction = "created" | "updated" | "skipped" | "failed";

export type LarkSyncRecordResult = {
  readonly taskId: string;
  readonly asin: string;
  readonly action: LarkSyncRecordAction;
  readonly recordId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type LarkSyncBatchResult = {
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: readonly LarkSyncRecordResult[];
  readonly syncedAt: string;
  readonly blockedReason?: "LIVE_SYNC_BLOCKED_BY_CREDENTIALS" | string;
};

/**
 * 导出目标通用接口。
 * 业务层只消费此接口，与底层特定多维表格实现解耦。
 */
export interface ResearchExportDestination {
  preflight(): Promise<LarkPreflightResult>;
  sync(records: readonly ResearchExportRecord[]): Promise<LarkSyncBatchResult>;
}
