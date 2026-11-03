import type { LarkBaseRecord } from "@/lib/research/larkMapping";
import type { ResearchExportRecord } from "@/lib/research/researchContracts";
import type {
  LarkFieldMeta,
  LarkIncompatibleField,
} from "./types";

export type BitableFieldDefinition = {
  readonly name: string;
  readonly description: string;
  readonly expectedTypes: readonly number[]; // 1: Text, 2: Number, 3: SingleSelect, 15: Url, etc.
  readonly requiredForSync: boolean;
};

/**
 * 飞书多维表格标准 V1 字段规范。
 * ASIN 作为业务唯一主键，属于必须字段。
 */
export const BITABLE_V1_FIELDS: readonly BitableFieldDefinition[] = [
  // 商品信息
  { name: "ASIN", description: "Amazon ASIN 业务主键", expectedTypes: [1], requiredForSync: true },
  { name: "商品标题", description: "商品名称", expectedTypes: [1], requiredForSync: true },
  { name: "商品图片", description: "商品主图链接", expectedTypes: [1, 15], requiredForSync: false },
  { name: "类目", description: "商品所属类目", expectedTypes: [1], requiredForSync: false },
  { name: "研究链接", description: "工作台研究详情链接", expectedTypes: [1, 15], requiredForSync: false },

  // 市场数据
  { name: "当前售价", description: "当前售价", expectedTypes: [2], requiredForSync: false },
  { name: "售价币种", description: "售价币种", expectedTypes: [1, 3], requiredForSync: false },
  { name: "预估月销量", description: "预估月销量", expectedTypes: [2], requiredForSync: false },
  { name: "BSR", description: "BSR 销售排名", expectedTypes: [2], requiredForSync: false },

  // AI 研究
  { name: "研究优先级", description: "研究优先级 P1 / P2 / P3", expectedTypes: [1, 3], requiredForSync: true },
  { name: "核心机会", description: "核心商业机会", expectedTypes: [1], requiredForSync: false },
  { name: "核心风险", description: "核心风险点清单", expectedTypes: [1], requiredForSync: false },
  { name: "AI研究摘要", description: "AI 研究摘要", expectedTypes: [1], requiredForSync: false },

  // 人工复核
  { name: "人工状态", description: "人工复核决策状态", expectedTypes: [1, 3], requiredForSync: true },
  { name: "下一步动作", description: "建议下一步动作", expectedTypes: [1, 3], requiredForSync: false },
  { name: "人工备注", description: "人工复核备注", expectedTypes: [1], requiredForSync: false },

  // 数据追溯
  { name: "Task ID", description: "轻选工作台任务 ID", expectedTypes: [1], requiredForSync: true },
  { name: "Candidate ID", description: "候选商品 ID", expectedTypes: [1], requiredForSync: false },
  { name: "Report Hash", description: "研报不可变内容指纹", expectedTypes: [1], requiredForSync: true },
  { name: "报告生成时间", description: "研报生成时间戳", expectedTypes: [1, 5], requiredForSync: false },
  { name: "最近同步时间", description: "写入飞书的时间戳", expectedTypes: [1, 5], requiredForSync: false },
] as const;

export type MapToBitableRowOptions = {
  readonly syncedAt?: string;
  readonly baseUrl?: string;
};

/**
 * 将 ResearchExportRecord 与 LarkBaseRecord 投影为飞书多维表格单行键值对。
 * 纯函数，不执行网络请求。仅映射存在字段，空值给 null 或空字符串。
 */
export function mapLarkRecordToBitableRow(
  exportRecord: ResearchExportRecord,
  larkRecord: LarkBaseRecord,
  options: MapToBitableRowOptions = {},
): Record<string, unknown> {
  const syncedAt = options.syncedAt ?? new Date().toISOString();
  const researchLink = options.baseUrl
    ? `${options.baseUrl.replace(/\/+$/, "")}/tasks/${exportRecord.taskId}`
    : `/tasks/${exportRecord.taskId}`;

  const row: Record<string, unknown> = {
    ASIN: exportRecord.product.asin ?? "",
    商品标题: exportRecord.product.title ?? "",
    商品图片: exportRecord.product.image ?? "",
    类目: exportRecord.product.category ?? "",
    研究链接: researchLink,

    当前售价: exportRecord.market.price?.amount ?? null,
    售价币种: exportRecord.market.price?.currency ?? "",
    预估月销量: exportRecord.market.sales ?? null,
    BSR: exportRecord.market.bsr ?? null,

    研究优先级: exportRecord.research.priority,
    核心机会: exportRecord.research.opportunity ?? "",
    核心风险: Array.isArray(exportRecord.research.risks) && exportRecord.research.risks.length > 0
      ? exportRecord.research.risks.join("\n")
      : "",
    AI研究摘要: exportRecord.research.summary ?? "",

    人工状态: larkRecord.人工决策.决策状态 ?? "待复核",
    下一步动作: larkRecord.人工决策.下一步动作 ?? "待定",
    人工备注: larkRecord.人工决策.决策备注 ?? "",

    "Task ID": exportRecord.taskId,
    "Candidate ID": exportRecord.candidateId,
    "Report Hash": exportRecord.evidence.reportHash,
    报告生成时间: exportRecord.evidence.generatedAt,
    最近同步时间: syncedAt,
  };

  return row;
}

export type TableValidationResult = {
  readonly isValid: boolean;
  readonly missingRequiredFields: readonly string[];
  readonly missingOptionalFields: readonly string[];
  /**
   * 写入行实际需要的字段中，远端表缺失的全部字段名（必须字段 + 可选字段）。
   *
   * `mapLarkRecordToBitableRow` 会发送契约中的**全部字段名**，飞书对不存在的
   * field_name 会拒绝写入。因此「可选字段」缺失同样会让真实写入失败，
   * 不能只看 requiredForSync。
   */
  readonly missingWriteFields: readonly string[];
  readonly incompatibleFields: readonly LarkIncompatibleField[];
  readonly fieldMapping: Record<string, LarkFieldMeta>;
};

/**
 * 校验多维表格现有字段是否匹配 V1 契约。
 *
 * isValid 语义 = 「当前真实写入行可以安全发送」：
 * 必须字段齐全 + 写入所需字段齐全 + 无类型不兼容。
 * 三者任一不满足即不可写，避免 Preflight 假绿而 Sync 阶段才失败。
 */
export function validateTableFields(remoteFields: readonly LarkFieldMeta[]): TableValidationResult {
  const remoteMap = new Map<string, LarkFieldMeta>();
  for (const field of remoteFields) {
    remoteMap.set(field.fieldName.trim(), field);
  }

  const missingRequiredFields: string[] = [];
  const missingOptionalFields: string[] = [];
  const incompatibleFields: LarkIncompatibleField[] = [];
  const fieldMapping: Record<string, LarkFieldMeta> = {};

  for (const def of BITABLE_V1_FIELDS) {
    const remote = remoteMap.get(def.name);
    if (!remote) {
      if (def.requiredForSync) {
        missingRequiredFields.push(def.name);
      } else {
        missingOptionalFields.push(def.name);
      }
      continue;
    }

    fieldMapping[def.name] = remote;

    // 校验字段类型是否在预期列表中
    if (!def.expectedTypes.includes(remote.type)) {
      incompatibleFields.push({
        fieldName: def.name,
        expectedType: def.expectedTypes.join(" | "),
        actualType: `${remote.type} (${remote.uiType})`,
      });
    }
  }

  const missingWriteFields = [...missingRequiredFields, ...missingOptionalFields];

  // 必须字段缺失、写入字段缺失，或存在不兼容字段，即视为不可写
  const isValid =
    missingRequiredFields.length === 0
    && missingOptionalFields.length === 0
    && incompatibleFields.length === 0;

  return {
    isValid,
    missingRequiredFields,
    missingOptionalFields,
    missingWriteFields,
    incompatibleFields,
    fieldMapping,
  };
}
