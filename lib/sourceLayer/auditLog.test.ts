import { describe, expect, it } from "vitest";

import {
  MAX_AUDIT_DETAIL_KEYS,
  appendAuditEntries,
  appendAuditEntry,
  parseAuditLog,
  replayAuditTimeline,
  sanitizeAuditDetail,
  summarizeAuditFailures,
} from "@/lib/sourceLayer/auditLog";
import { createSourceLayerError } from "@/lib/sourceLayer/errorCodes";

const NOW = "2026-02-01T00:00:00.000Z";

describe("appendAuditEntry", () => {
  it("keeps a monotonic sequence and records the four transition fields", () => {
    const first = appendAuditEntry([], {
      eventKind: "capture_created",
      reason: "采集包创建",
      timestamp: NOW,
      nextState: "CREATED",
      captureId: "cap-1",
      subjectKey: "amazon:US:B0FH1ZXTN1",
      operator: "owner:v1",
    });
    const second = appendAuditEntry(first, {
      eventKind: "state_transition",
      reason: "检查来源可信度",
      timestamp: NOW,
      previousState: "CREATED",
      nextState: "SOURCE_CHECKING",
      captureId: "cap-1",
      subjectKey: "amazon:US:B0FH1ZXTN1",
      operator: "owner:v1",
    });
    expect(second).toHaveLength(2);
    expect(second[1].sequence).toBe(2);
    expect(second[1].previousState).toBe("CREATED");
    expect(second[1].nextState).toBe("SOURCE_CHECKING");
    expect(second[1].reason).toBe("检查来源可信度");
    expect(second[1].timestamp).toBe(NOW);
  });

  it("normalizes unknown error codes instead of passing them through", () => {
    const [entry] = appendAuditEntry([], {
      eventKind: "error",
      reason: "未知错误",
      timestamp: NOW,
      errorCode: "TOTALLY_UNKNOWN_CODE",
      operator: "owner:v1",
    });
    expect(entry.errorCode).toBe("INTERNAL_UNEXPECTED");
  });

  it("records trace fields without persisting secret-shaped values", () => {
    const [entry] = appendAuditEntry([], {
      eventKind: "diagnostic",
      reason: "采集完成",
      timestamp: NOW,
      traceId: "trace-1",
      spanId: "span-1",
      module: "CAPTURE_GATEWAY",
      phase: "persist",
      eventType: "evidence_persisted",
      severity: "info",
      evidenceRefs: ["evidence-1", "evidence-1"],
      contentHash: "hash-1",
      detail: { secretToken: "must-not-appear", count: 1 },
    });
    expect(entry.traceId).toBe("trace-1");
    expect(entry.module).toBe("CAPTURE_GATEWAY");
    expect(entry.evidenceRefs).toEqual(["evidence-1"]);
    expect(JSON.stringify(entry)).not.toContain("must-not-appear");
  });

  it("never persists secret-shaped detail keys or nested payloads", () => {
    const [entry] = appendAuditEntry([], {
      eventKind: "error",
      reason: "token leak attempt",
      timestamp: NOW,
      operator: "owner:v1",
      detail: {
        apiKey: "sk-secret",
        authorization: "Bearer x",
        cookie: "session=1",
        safeCount: 3,
        nested: { a: 1 } as unknown as string,
        nestedArray: [1, 2, 3] as unknown as string,
      },
    });
    expect(Object.keys(entry.detail).sort()).toEqual(["safeCount"]);
    expect(JSON.stringify(entry)).not.toContain("sk-secret");
  });

  it("bounds the number of detail keys", () => {
    const detail = Object.fromEntries(
      Array.from({ length: MAX_AUDIT_DETAIL_KEYS + 10 }, (_, index) => [`k${index}`, index]),
    );
    expect(Object.keys(sanitizeAuditDetail(detail)).length).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_KEYS);
  });

  it("appendAuditEntries applies every entry in order", () => {
    const entries = appendAuditEntries([], [
      { eventKind: "error", reason: "a", timestamp: NOW, operator: "owner:v1", error: createSourceLayerError("FIELD_MISSING") },
      { eventKind: "error", reason: "b", timestamp: NOW, operator: "owner:v1", error: createSourceLayerError("FIELD_CONFLICT") },
    ]);
    expect(entries.map((entry) => entry.errorCode)).toEqual(["FIELD_MISSING", "FIELD_CONFLICT"]);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
  });
});

describe("parseAuditLog", () => {
  it("returns [] for malformed logs (callers must fail closed explicitly)", () => {
    expect(parseAuditLog("nope")).toEqual([]);
    expect(parseAuditLog([{ sequence: 0 }])).toEqual([]);
  });

  it("round-trips a valid log", () => {
    const entries = appendAuditEntry([], {
      eventKind: "validation_result",
      reason: "校验结论：passed",
      timestamp: NOW,
      operator: "owner:v1",
    });
    expect(parseAuditLog(JSON.parse(JSON.stringify(entries)))).toEqual(entries);
  });

  it("rejects an unregistered error code that claims to be registered", () => {
    const [valid] = appendAuditEntry([], {
      eventKind: "error",
      reason: "x",
      timestamp: NOW,
      operator: "owner:v1",
      error: createSourceLayerError("FIELD_MISSING"),
    });
    expect(parseAuditLog([{ ...valid, errorCode: "NOT_REGISTERED" }])).toEqual([]);
  });
});

describe("replayAuditTimeline", () => {
  const entries = [
    ...appendAuditEntry([], {
      eventKind: "capture_created",
      reason: "创建",
      timestamp: NOW,
      captureId: "cap-1",
      subjectKey: "s1",
      operator: "owner:v1",
    }),
    ...appendAuditEntry([], {
      eventKind: "error",
      reason: "缺少标题",
      timestamp: NOW,
      captureId: "cap-2",
      subjectKey: "s2",
      operator: "owner:v1",
      error: createSourceLayerError("FIELD_MISSING", { field: "title" }),
    }),
  ];

  it("filters by capture id, subject key and error code", () => {
    expect(replayAuditTimeline(entries, { captureId: "cap-1" })).toHaveLength(1);
    expect(replayAuditTimeline(entries, { subjectKey: "s2" })).toHaveLength(1);
    expect(replayAuditTimeline(entries, { errorCode: "FIELD_MISSING" })).toHaveLength(1);
    expect(replayAuditTimeline(entries)).toHaveLength(2);
  });

  it("summarizes why a capture failed", () => {
    const summary = summarizeAuditFailures(replayAuditTimeline(entries, { captureId: "cap-2" }));
    expect(summary.failed).toBe(true);
    expect(summary.errorCodes).toEqual(["FIELD_MISSING"]);
    expect(summary.lastReason).toBe("缺少标题");
  });
});
