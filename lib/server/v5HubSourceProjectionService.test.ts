import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readV3ModuleEvidence: vi.fn(),
  getLarkConfig: vi.fn(),
  mapV3KeywordAttachmentsToV5HubRows: vi.fn(),
  mapCustomerVoiceAttachmentsToV5HubRows: vi.fn(),
  mapMonitoringRunToV5HubRow: vi.fn(),
  projectV5HubRecords: vi.fn(),
  reconcileV5HubRecordsReadOnly: vi.fn(),
  projectV5HubRecord: vi.fn(),
  createMonitoringRepository: vi.fn(),
}));

vi.mock("@/lib/sourceLayer/v3ModuleEvidence", () => ({ readV3ModuleEvidence: mocks.readV3ModuleEvidence }));
vi.mock("@/lib/integrations/lark/config", () => ({ getLarkConfig: mocks.getLarkConfig }));
vi.mock("@/lib/integrations/lark/v5HubProjection", () => ({
  mapV3KeywordAttachmentsToV5HubRows: mocks.mapV3KeywordAttachmentsToV5HubRows,
  mapCustomerVoiceAttachmentsToV5HubRows: mocks.mapCustomerVoiceAttachmentsToV5HubRows,
  mapMonitoringRunToV5HubRow: mocks.mapMonitoringRunToV5HubRow,
}));
vi.mock("@/lib/integrations/lark/v5HubProjectionService", () => ({
  projectV5HubRecords: mocks.projectV5HubRecords,
  reconcileV5HubRecordsReadOnly: mocks.reconcileV5HubRecordsReadOnly,
  projectV5HubRecord: mocks.projectV5HubRecord,
}));
vi.mock("@/lib/server/continuousMonitoringRepository", () => ({ createMonitoringRepository: mocks.createMonitoringRepository }));
vi.mock("@/lib/server/v5CoreCommon", () => ({
  hashJson: (value: unknown) => JSON.stringify(value),
  requireOwnerContext: (context: { mode: string }) => { if (context.mode !== "owner") throw new Error("OWNER_REQUIRED"); },
  V5CoreError: class extends Error {
    constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
  },
  withV5Receipt: async (input: { execute: () => Promise<unknown> }) => ({ value: await input.execute(), replayed: false }),
}));

import {
  projectCustomerVoiceEvidenceToV5Hub,
  projectMonitoringRunToV5Hub,
  projectV3KeywordEvidenceToV5Hub,
} from "./v5HubSourceProjectionService";

const context = { mode: "owner", token: "" } as const;
const config = { appId: "app", appSecret: "secret", appToken: "RXOabDkG0abBevsno43cSkTFnWb", tableId: "legacy", openApiDomain: "https://open.feishu.cn" };
const keywordRows = [{ logicalKey: "keyword-key", fields: { "关键词": "visible" } }];
const monitoringRow = { logicalKey: "monitoring-key", fields: { "监控运行 ID": "run-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readV3ModuleEvidence.mockResolvedValue({ evidenceStore: { attachments: [{ attachmentId: "att-1", contentHash: "a".repeat(64), capturedAt: "2026-09-26T08:00:00.000Z", kind: "v3_reverse_asin_v1" }] } });
  mocks.getLarkConfig.mockReturnValue({ ok: true, config });
  mocks.mapV3KeywordAttachmentsToV5HubRows.mockReturnValue(keywordRows);
  mocks.mapCustomerVoiceAttachmentsToV5HubRows.mockReturnValue([{ logicalKey: "voice-key", fields: { "样本数量": 1 } }]);
  mocks.projectV5HubRecords.mockResolvedValue([{ status: "CREATED", recordId: "rec-keyword" }]);
  mocks.createMonitoringRepository.mockReturnValue({
    getRun: vi.fn().mockResolvedValue({ id: "run-1", watchTargetId: "watch-1", status: "SUCCEEDED" }),
    getWatch: vi.fn().mockResolvedValue({ id: "watch-1", subjectKey: "amazon:US:B000000001" }),
  });
  mocks.mapMonitoringRunToV5HubRow.mockReturnValue(monitoringRow);
  mocks.projectV5HubRecord.mockResolvedValue({ status: "CREATED", recordId: "rec-monitoring" });
});

describe("V5 Hub source projection service", () => {
  it("reads existing EvidenceStore attachments and batch-projects only mapper output to T04", async () => {
    const result = await projectV3KeywordEvidenceToV5Hub({ context, subjectKey: "amazon:US:B000000001", idempotencyKey: "keywords-1" });
    expect(result.status).toBe("PROJECTED");
    expect(mocks.readV3ModuleEvidence).toHaveBeenCalledWith({ context, subjectKey: "amazon:US:B000000001" });
    expect(mocks.mapV3KeywordAttachmentsToV5HubRows).toHaveBeenCalledWith(expect.objectContaining({
      subjectKey: "amazon:US:B000000001",
      attachments: expect.arrayContaining([expect.objectContaining({ attachmentId: "att-1" })]),
    }));
    expect(mocks.projectV5HubRecords).toHaveBeenCalledWith({ config, tableId: "T04", rows: keywordRows });
    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
  });

  it("does not make Feishu calls when no eligible keyword evidence exists", async () => {
    mocks.mapV3KeywordAttachmentsToV5HubRows.mockReturnValueOnce([]);
    const result = await projectV3KeywordEvidenceToV5Hub({ context, subjectKey: "amazon:US:B000000001", idempotencyKey: "keywords-empty" });
    expect(result.status).toBe("NO_ELIGIBLE_EVIDENCE");
    expect(mocks.getLarkConfig).not.toHaveBeenCalled();
    expect(mocks.projectV5HubRecords).not.toHaveBeenCalled();
  });

  it("projects read-only Customer Voice aggregates to T03", async () => {
    const attachment = {
      attachmentId: "voice-attachment",
      contentHash: "a".repeat(64),
      capturedAt: "2026-09-27T00:00:00.000Z",
      kind: "customer_voice_observation_v1",
    };
    mocks.readV3ModuleEvidence.mockResolvedValueOnce({ evidenceStore: { attachments: [attachment] } });
    const result = await projectCustomerVoiceEvidenceToV5Hub({
      context, subjectKey: "amazon:US:B000000001", idempotencyKey: "voice-1",
    });
    expect(result.status).toBe("PROJECTED");
    expect(mocks.mapCustomerVoiceAttachmentsToV5HubRows).toHaveBeenCalledWith({
      subjectKey: "amazon:US:B000000001", attachments: [attachment],
    });
    expect(mocks.projectV5HubRecords).toHaveBeenCalledWith({
      config,
      tableId: "T03",
      rows: [{ logicalKey: "voice-key", fields: { "样本数量": 1 } }],
    });
  });

  it("does not call Feishu when Customer Voice evidence is absent", async () => {
    mocks.mapCustomerVoiceAttachmentsToV5HubRows.mockReturnValueOnce([]);
    const result = await projectCustomerVoiceEvidenceToV5Hub({
      context, subjectKey: "amazon:US:B000000001", idempotencyKey: "voice-empty",
    });
    expect(result.status).toBe("NO_ELIGIBLE_EVIDENCE");
    expect(mocks.getLarkConfig).not.toHaveBeenCalled();
    expect(mocks.projectV5HubRecords).not.toHaveBeenCalled();
  });

  it("rejects Visitor access before reading Customer Voice evidence", async () => {
    await expect(projectCustomerVoiceEvidenceToV5Hub({
      context: { mode: "demo" } as never,
      subjectKey: "amazon:US:B000000001",
      idempotencyKey: "voice-visitor",
    })).rejects.toThrow("OWNER_REQUIRED");
    expect(mocks.readV3ModuleEvidence).not.toHaveBeenCalled();
    expect(mocks.projectV5HubRecords).not.toHaveBeenCalled();
  });

  it("rejects Visitor access before reading evidence or projecting", async () => {
    await expect(projectV3KeywordEvidenceToV5Hub({
      context: { mode: "demo" } as never,
      subjectKey: "amazon:US:B000000001",
      idempotencyKey: "visitor-keywords",
    })).rejects.toThrow("OWNER_REQUIRED");
    expect(mocks.readV3ModuleEvidence).not.toHaveBeenCalled();
    expect(mocks.projectV5HubRecords).not.toHaveBeenCalled();
  });

  it("reads but never runs Monitoring and projects one finalized run to T06", async () => {
    const result = await projectMonitoringRunToV5Hub({ context, monitoringRunId: "run-1", idempotencyKey: "monitoring-1" });
    expect(result.status).toBe("PROJECTED");
    expect(mocks.createMonitoringRepository).toHaveBeenCalledOnce();
    expect(mocks.mapMonitoringRunToV5HubRow).toHaveBeenCalledWith({
      subjectKey: "amazon:US:B000000001", watchTargetId: "watch-1", run: expect.objectContaining({ id: "run-1" }),
    });
    expect(mocks.projectV5HubRecord).toHaveBeenCalledWith({
      config, tableId: "T06", logicalKey: monitoringRow.logicalKey, fields: monitoringRow.fields,
    });
    expect(mocks.readV3ModuleEvidence).not.toHaveBeenCalled();
  });

  it("fails closed for a missing MonitoringRun before config access or projection", async () => {
    mocks.createMonitoringRepository.mockReturnValueOnce({ getRun: vi.fn().mockResolvedValue(null) });
    await expect(projectMonitoringRunToV5Hub({ context, monitoringRunId: "missing", idempotencyKey: "monitoring-missing" }))
      .rejects.toMatchObject({ code: "MONITORING_RUN_NOT_FOUND", status: 404 });
    expect(mocks.getLarkConfig).not.toHaveBeenCalled();
    expect(mocks.projectV5HubRecord).not.toHaveBeenCalled();
  });
});
