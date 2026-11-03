import type { LarkFieldMeta } from "./types";

/**
 * Versioned logical contract for the Feishu Intelligence Hub projection.
 * Structured values are encoded as JSON text at this boundary so the
 * authoritative records remain in LightChoice/EvidenceStore, not Feishu.
 */

export type HubFieldKind = "text" | "number" | "datetime" | "json";

export type HubFieldContract = {
  /** Stable machine key used by TypeScript and schema/hash contracts. */
  readonly name: string;
  /** User-visible Feishu field label; changing this never changes the machine key. */
  readonly displayName: string;
  readonly kind: HubFieldKind;
  readonly required: boolean;
  readonly writableBy: "projection" | "projection-seed" | "decision-pull" | "ai-advisory";
};

export type HubTableContract = {
  readonly id: "T01" | "T02" | "T03" | "T04" | "T05" | "T06";
  /** Stable logical table name retained for internal compatibility. */
  readonly name: string;
  /** User-visible Feishu table name. */
  readonly displayName: string;
  readonly fields: readonly HubFieldContract[];
  readonly logicalUniqueKey: readonly string[];
};

const FIELD_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  subjectKey: "主体键",
  asin: "ASIN",
  marketplace: "销售站点",
  productTitle: "商品标题",
  category: "商品类目",
  productFactSnapshot: "商品事实快照",
  factHash: "事实哈希",
  packetHash: "研究包哈希",
  metricNature: "指标性质",
  provenanceRefs: "来源证据引用",
  researchStatus: "研究状态",
  nextAction: "下一步动作",
  personalReview: "个人复盘",
  decisionStatus: "决策状态",
  projectedAt: "投影时间",
  AI_summary: "AI 摘要",
  schemaVersion: "结构版本",
  taskId: "任务 ID",
  revision: "修订版本",
  generatedAt: "生成时间",
  evidenceHash: "证据哈希",
  price: "售价",
  currency: "货币",
  fbaFee: "FBA 费用",
  landedCost: "到岸成本",
  netProfit: "净利润",
  breakEvenPrice: "盈亏平衡价格",
  stressMargin: "压力情景利润率",
  riskGate: "风险门禁",
  riskCoverage: "风险覆盖情况",
  evidenceSufficiency: "证据充分性",
  vocSummary: "买家声音摘要",
  keywordSummary: "关键词摘要",
  assumptions: "假设条件",
  evidenceRefs: "证据引用",
  missingFields: "缺失字段",
  packetStatus: "研究包状态",
  AI_interpretation: "AI 解读",
  aggregationKey: "聚合键",
  aggregationVersion: "聚合版本",
  sourceType: "来源类型",
  timeWindowStart: "统计开始时间",
  timeWindowEnd: "统计结束时间",
  failureMode: "问题类型",
  painPointTag: "痛点标签",
  frequency: "出现频次",
  sampleCount: "样本数量",
  coverageStatus: "覆盖状态",
  representativeSnippet: "代表性原文",
  contentHash: "内容哈希",
  aggregatedAt: "聚合时间",
  AI_voiceInterpretation: "AI 买家声音解读",
  keyword: "关键词",
  source: "数据来源",
  observedAt: "观测时间",
  window: "统计周期",
  searchVolume: "搜索量",
  volumeUnit: "搜索量单位",
  rank: "排名",
  trend: "趋势",
  competition: "竞争程度",
  keywordHash: "关键词数据哈希",
  AI_keywordIdea: "AI 关键词建议",
  conceptId: "概念 ID",
  reportHash: "报告哈希",
  targetCustomer: "目标客户",
  useCases: "使用场景",
  primaryPainPoints: "核心痛点",
  specs: "产品规格",
  differentiation: "差异化方向",
  priceRange: "价格区间",
  costRange: "成本区间",
  marginAssumptions: "利润率假设",
  risks: "风险项",
  missingValidations: "待验证事项",
  confirmedFacts: "已确认事实",
  aiSummary: "AI 摘要",
  decision: "人工决策",
  decisionNotes: "决策备注",
  reviewerIdentity: "审核人身份",
  reviewedAt: "审核时间",
  expectedPacketHash: "预期研究包哈希",
  humanDecision: "人工决策状态",
  watchTargetId: "监控目标 ID",
  monitoringRunId: "监控运行 ID",
  eventKey: "事件键",
  runAt: "运行时间",
  changeSummary: "变化摘要",
  severity: "严重程度",
  eventStatus: "事件状态",
  AI_explanation: "AI 说明",
};

const displayNameFor = (name: string): string => {
  const displayName = FIELD_DISPLAY_NAMES[name];
  if (!displayName) throw new Error(`Missing Chinese display name for V5 Hub field: ${name}`);
  return displayName;
};

const projection = (name: string, kind: HubFieldKind = "text", required = false): HubFieldContract => ({
  name,
  displayName: displayNameFor(name),
  kind,
  required,
  writableBy: "projection",
});

const decision = (name: string, kind: HubFieldKind = "text"): HubFieldContract => ({
  name,
  displayName: displayNameFor(name),
  kind,
  required: false,
  writableBy: "decision-pull",
});

/** Current T02 version token seeded for a later human decision Pull/CAS. */
const decisionVersionSeed = (name: string): HubFieldContract => ({
  name,
  displayName: displayNameFor(name),
  kind: "text",
  required: false,
  writableBy: "projection-seed",
});

const advisory = (name: string): HubFieldContract => ({
  name,
  displayName: displayNameFor(name),
  kind: "text",
  required: false,
  writableBy: "ai-advisory",
});

export const V5_HUB_SCHEMA_VERSION = "v5-feishu-hub.v1" as const;

export const V5_HUB_TABLES: readonly HubTableContract[] = [
  {
    id: "T01",
    name: "T01 Commodity Master",
    displayName: "T01 商品主表",
    fields: [
      projection("subjectKey", "text", true),
      projection("asin", "text", true),
      projection("marketplace", "text", true),
      projection("productTitle"),
      projection("category"),
      projection("productFactSnapshot", "json"),
      projection("factHash"),
      projection("packetHash"),
      projection("metricNature"),
      projection("provenanceRefs", "json"),
      projection("researchStatus"),
      projection("decisionStatus"),
      projection("nextAction"),
      projection("projectedAt", "datetime"),
      advisory("AI_summary"),
    ],
    logicalUniqueKey: ["subjectKey"],
  },
  {
    id: "T02",
    name: "T02 Research Packets",
    displayName: "T02 研究数据包",
    fields: [
      projection("schemaVersion", "text", true),
      projection("subjectKey", "text", true),
      projection("asin", "text", true),
      projection("marketplace", "text", true),
      projection("taskId"),
      projection("revision", "number"),
      projection("generatedAt", "datetime", true),
      projection("factHash", "text", true),
      projection("evidenceHash", "text", true),
      projection("packetHash", "text", true),
      projection("price", "number"),
      projection("currency"),
      projection("fbaFee", "number"),
      projection("landedCost", "number"),
      projection("netProfit", "number"),
      projection("breakEvenPrice", "number"),
      projection("stressMargin", "number"),
      projection("riskGate"),
      projection("riskCoverage", "json"),
      projection("evidenceSufficiency", "json"),
      projection("vocSummary", "json"),
      projection("keywordSummary", "json"),
      projection("assumptions", "json"),
      projection("evidenceRefs", "json"),
      projection("missingFields", "json"),
      projection("packetStatus"),
      advisory("AI_summary"),
      advisory("AI_interpretation"),
      decision("decision"),
      decision("decisionNotes"),
    ],
    logicalUniqueKey: ["packetHash"],
  },
  {
    id: "T03",
    name: "T03 Buyer Voice VOC",
    displayName: "T03 买家声音",
    fields: [
      projection("subjectKey", "text", true),
      projection("aggregationKey", "text", true),
      projection("aggregationVersion", "text", true),
      projection("marketplace"),
      projection("sourceType"),
      projection("timeWindowStart", "datetime"),
      projection("timeWindowEnd", "datetime"),
      projection("failureMode"),
      projection("painPointTag"),
      projection("frequency", "number"),
      projection("sampleCount", "number"),
      projection("coverageStatus"),
      projection("representativeSnippet"),
      projection("evidenceRefs", "json", true),
      projection("contentHash"),
      projection("aggregatedAt", "datetime"),
      advisory("AI_voiceInterpretation"),
    ],
    logicalUniqueKey: ["subjectKey", "aggregationKey", "aggregationVersion"],
  },
  {
    id: "T04",
    name: "T04 Keyword Intelligence",
    displayName: "T04 关键词情报",
    fields: [
      projection("subjectKey", "text", true),
      projection("keyword", "text", true),
      projection("marketplace", "text", true),
      projection("source", "text", true),
      projection("observedAt", "datetime"),
      projection("window"),
      projection("searchVolume", "number"),
      projection("volumeUnit"),
      projection("rank", "number"),
      projection("trend"),
      projection("competition"),
      projection("metricNature", "text", true),
      projection("provenanceRefs", "json", true),
      projection("keywordHash"),
      advisory("AI_keywordIdea"),
    ],
    logicalUniqueKey: ["subjectKey", "keyword", "marketplace", "source", "window"],
  },
  {
    id: "T05",
    name: "T05 Product Concepts",
    displayName: "T05 产品概念",
    fields: [
      projection("conceptId", "text", true),
      projection("subjectKey", "text", true),
      projection("taskId"),
      projection("revision", "number", true),
      projection("reportHash"),
      projection("factHash", "text", true),
      projection("evidenceHash", "text", true),
      projection("targetCustomer", "json"),
      projection("useCases", "json"),
      projection("primaryPainPoints", "json"),
      projection("specs", "json"),
      projection("differentiation", "json"),
      projection("priceRange", "json"),
      projection("costRange", "json"),
      projection("marginAssumptions", "json"),
      projection("risks", "json"),
      projection("missingValidations", "json"),
      projection("evidenceRefs", "json"),
      projection("confirmedFacts", "json"),
      projection("aiSummary"),
      decision("decision"),
      decision("decisionNotes"),
      decision("personalReview"),
      decision("reviewerIdentity"),
      decision("reviewedAt", "datetime"),
      decisionVersionSeed("expectedPacketHash"),
      projection("humanDecision"),
      projection("projectedAt", "datetime"),
    ],
    logicalUniqueKey: ["conceptId", "revision"],
  },
  {
    id: "T06",
    name: "T06 Monitoring Alerts",
    displayName: "T06 监控事件",
    fields: [
      projection("watchTargetId", "text", true),
      projection("monitoringRunId", "text", true),
      projection("eventKey", "text", true),
      projection("subjectKey", "text", true),
      projection("runAt", "datetime", true),
      projection("changeSummary", "json"),
      projection("severity"),
      projection("eventStatus"),
      projection("evidenceRefs", "json"),
      projection("packetHash"),
      projection("projectedAt", "datetime"),
      advisory("AI_explanation"),
    ],
    logicalUniqueKey: ["watchTargetId", "monitoringRunId", "eventKey"],
  },
] as const;

/** Feishu field type IDs; JSON is deliberately stored as text, not a second fact store. */
export const FEISHU_FIELD_TYPE_BY_KIND: Readonly<Record<HubFieldKind, number>> = {
  text: 1,
  json: 1,
  number: 2,
  datetime: 5,
};

export const FEISHU_HUB_FIELD_BINDING_MODE = "FIELD_NAME" as const;

export type HubRemoteSchemaValidation = {
  readonly isValid: boolean;
  readonly missingFields: readonly string[];
  readonly unexpectedFields: readonly string[];
  readonly duplicateFields: readonly string[];
  readonly incompatibleFields: readonly {
    fieldName: string;
    expectedType: number;
    actualType: number;
  }[];
  /** Field IDs are reported for diagnostics only; record payloads bind by field name. */
  readonly fieldIdsByDisplayName: Readonly<Record<string, string>>;
};

/** Compare the API/UI field readback with the localized contract without binding to mutable field IDs. */
export function validateV5HubRemoteSchema(
  tableId: HubTableContract["id"],
  remoteFields: readonly LarkFieldMeta[],
): HubRemoteSchemaValidation {
  const table = V5_HUB_TABLES.find((candidate) => candidate.id === tableId);
  if (!table) throw new Error(`Unknown V5 Hub table: ${tableId}`);

  const expected = new Map(table.fields.map((field) => [field.displayName, field]));
  const remote = new Map(remoteFields.map((field) => [field.fieldName.trim(), field]));
  const missingFields: string[] = [];
  const unexpectedFields: string[] = [];
  const duplicateFields: string[] = [];
  const incompatibleFields: Array<{ fieldName: string; expectedType: number; actualType: number }> = [];
  const fieldIdsByDisplayName: Record<string, string> = {};

  const remoteNameCounts = new Map<string, number>();
  for (const field of remoteFields) {
    const name = field.fieldName.trim();
    remoteNameCounts.set(name, (remoteNameCounts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of remoteNameCounts) {
    if (count > 1) duplicateFields.push(name);
  }

  for (const [displayName, field] of expected) {
    const actual = remote.get(displayName);
    if (!actual) {
      missingFields.push(displayName);
      continue;
    }
    fieldIdsByDisplayName[displayName] = actual.fieldId;
    const expectedType = FEISHU_FIELD_TYPE_BY_KIND[field.kind];
    const isCompatible = actual.type === expectedType
      || (field.name === "decision" && (actual.type === 1 || actual.type === 3));
    if (!isCompatible) {
      incompatibleFields.push({ fieldName: displayName, expectedType, actualType: actual.type });
    }
  }

  for (const field of remoteFields) {
    const name = field.fieldName.trim();
    if (!expected.has(name) && !(field.isPrimary && name === "记录名称")) unexpectedFields.push(name);
  }

  return {
    isValid: missingFields.length === 0 && unexpectedFields.length === 0 && duplicateFields.length === 0 && incompatibleFields.length === 0,
    missingFields,
    unexpectedFields,
    duplicateFields,
    incompatibleFields,
    fieldIdsByDisplayName,
  };
}

/**
 * Feishu record payloads are keyed by visible field name in the current
 * BaseClient contract. Keep internal callers on stable English keys and map
 * them to the localized Feishu labels at this explicit boundary.
 */
export function mapHubFieldsToFeishuDisplayNames(
  tableId: HubTableContract["id"],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const table = V5_HUB_TABLES.find((candidate) => candidate.id === tableId);
  if (!table) throw new Error(`Unknown V5 Hub table: ${tableId}`);

  const contractByName = new Map(table.fields.map((field) => [field.name, field]));
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const field = contractByName.get(name);
    if (!field) throw new Error(`${tableId}: field is not in schema contract: ${name}`);
    if (field.writableBy !== "projection" && field.writableBy !== "projection-seed") {
      throw new Error(`${tableId}: field is not projection-writable: ${name}`);
    }
    mapped[field.displayName] = value;
  }
  return mapped;
}

/** Stable logical key helper for already-localized projection payloads. */
export function v5HubLogicalKeyFromDisplayFields(
  tableId: HubTableContract["id"],
  fields: Readonly<Record<string, unknown>>,
): string {
  const table = V5_HUB_TABLES.find((candidate) => candidate.id === tableId);
  if (!table) throw new Error(`Unknown V5 Hub table: ${tableId}`);
  const values = table.logicalUniqueKey.map((key) => {
    const contract = table.fields.find((field) => field.name === key);
    if (!contract) throw new Error(`V5_HUB_LOGICAL_KEY_FIELD_MISSING:${tableId}:${key}`);
    const value = fields[contract.displayName];
    if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
      throw new Error(`V5_HUB_PROJECTION_KEY_MISSING:${tableId}:${key}`);
    }
    return [contract.displayName, String(value)] as const;
  });
  return values.length === 1 ? values[0][1] : JSON.stringify(values);
}

export function validateV5HubSchema(): readonly string[] {
  const errors: string[] = [];
  const tableIds = new Set<string>();
  const tableNames = new Set<string>();
  const tableDisplayNames = new Set<string>();

  for (const table of V5_HUB_TABLES) {
    if (tableIds.has(table.id)) errors.push(`${table.id}: duplicate table id`);
    if (tableNames.has(table.name)) errors.push(`${table.id}: duplicate table name`);
    tableIds.add(table.id);
    tableNames.add(table.name);
    if (!table.displayName.trim()) errors.push(`${table.id}: missing Chinese table display name`);
    if (!/[\u4e00-\u9fff]/.test(table.displayName)) errors.push(`${table.id}: table display name must contain Chinese`);
    if (tableDisplayNames.has(table.displayName)) errors.push(`${table.id}: duplicate table display name`);
    tableDisplayNames.add(table.displayName);

    const fieldNames = new Set<string>();
    const fieldDisplayNames = new Set<string>();
    for (const field of table.fields) {
      if (fieldNames.has(field.name)) errors.push(`${table.id}: duplicate field ${field.name}`);
      fieldNames.add(field.name);
      if (!field.displayName.trim()) errors.push(`${table.id}: ${field.name} has no display name`);
      if (!/[\u4e00-\u9fff]/.test(field.displayName) && field.displayName !== "ASIN") {
        errors.push(`${table.id}: ${field.name} display name must be Chinese or an approved standard abbreviation`);
      }
      if (fieldDisplayNames.has(field.displayName)) errors.push(`${table.id}: duplicate field display name ${field.displayName}`);
      fieldDisplayNames.add(field.displayName);
    }
    for (const key of table.logicalUniqueKey) {
      if (!fieldNames.has(key)) errors.push(`${table.id}: unique key field ${key} is missing`);
    }
  }

  const packets = V5_HUB_TABLES.find(({ id }) => id === "T02");
  for (const hash of ["packetHash", "factHash", "evidenceHash"]) {
    if (!packets?.fields.some((field) => field.name === hash)) errors.push(`T02: ${hash} is missing`);
  }
  return errors;
}
