/**
 * PH4-H0 历史趋势来源资格判定 + 去重边界（纯 Fixture，无真实附件）
 *
 * 与 `ph4H0SellerSpriteTrendReadback.live.test.ts`（真实隔离 EvidenceStore）**分开标注**：
 * 本文件不依赖任何真实附件，只验证资格判定函数的纯函数契约。
 */
import { describe, expect, it } from "vitest";

import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import {
  adaptV3HistoricalTrendAttachment,
  deduplicateTrendObservations,
  evaluateHistoricalTrendSourceEligibility,
  summarizeTrendObservations,
} from "@/lib/server/research/v3EvidenceResearchAdapter";
import { buildTrendObservation, type TrendObservation } from "@/lib/sourceLayer/v2/contracts";

const SUBJECT = "amazon:US:B0FIXT0001";
const HASH_A = "a".repeat(64);
const ATT_A = "att-fixture-a";

const NOW = new Date("2026-10-09T12:00:00.000Z");

function attachment(overrides: {
attachmentId?: string;
  contentHash?: string;
  capturedAt?: string;
  acquisitionMode?: string;
  subjectKey?: string;
  browserObservedAt?: string | null;
  series?: Array<Record<string, unknown>>;
}): SourceEvidenceAttachment {
  return {
    attachmentId: overrides.attachmentId ?? ATT_A,
    kind: "v3_historical_trend_v1",
    sourceType: "sellersprite_plugin",
    subjectKey: overrides.subjectKey ?? SUBJECT,
    sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0FIXT0001&marketId=1",
    capturedAt: overrides.capturedAt ?? "2026-10-09T11:00:00.000Z",
    contentHash: overrides.contentHash ?? HASH_A,
    capturedFromVisibleDom: true,
    payload: {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: "historical_trend",
      subjectKey: overrides.subjectKey ?? SUBJECT,
      marketplace: "US",
      capturedAt: overrides.capturedAt ?? "2026-10-09T11:00:00.000Z",
      provider: "SellerSprite",
      sourceSurface: "SellerSprite keyword reverse tooltip",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0FIXT0001&marketId=1",
      providerUpdatedAt: null,
      // 与真实 SellerSprite 历史趋势附件一致：freshness 走 cadenceKey 语义。
      freshness: {
        cadenceKey: "historical_window",
        ttlMs: 2_592_000_000,
        providerUpdatedAt: null,
        ageMs: null,
        state: "unknown",
      },
      acquisitionMode: overrides.acquisitionMode ?? "DOM_DIRECT",
      metricNature: "provider_estimate",
      status: "AVAILABLE_WITH_LIMITATION",
      // status=AVAILABLE_WITH_LIMITATION 时正式契约要求至少一条 limitation。
      limitations: ["provider_estimate_series"],
      identity: { asin: "B0FIXT0001", parentAsin: null, keyword: null, query: null, category: null },
      data: {
        // 浏览器直采来源必须自证观察时刻（资格门禁要求）。
        // 默认给一个早于 capturedAt 的合法观察时刻；传null 可模拟「无法追溯」。
        ...(overrides.browserObservedAt === null
          ? {}
          : { browserObservedAt: overrides.browserObservedAt ?? "2026-10-09T10:59:59.000Z" }),
        series: overrides.series ?? [
          { date: "2026-07", 自然流量: 100 },
          { date: "2026-08", 自然流量: 120 },
          { date: "2026-09", 自然流量: 150 },
        ],
      },
      evidenceOnly: true,
    },
  } as unknown as SourceEvidenceAttachment;
}

describe("PH4-H0 来源资格判定（纯 Fixture）", () => {
  it("合法 DOM_DIRECT 来源 → VERIFIED_NUMERIC_SOURCE", () => {
    const att = attachment({});
    const parsed = { subjectKey: String((att.payload as Record<string, unknown>).subjectKey), acquisitionMode: "DOM_DIRECT", data: (att.payload as Record<string, unknown>).data } as never;
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("VERIFIED_NUMERIC_SOURCE");
    expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now: NOW })).toHaveLength(3);
  });

  it("采集时刻不可解析 → INVALID_CAPTURE_TIME（零观察）", () => {
    const att = attachment({ capturedAt: "not-a-timestamp" });
    const parsed = { subjectKey: String((att.payload as Record<string, unknown>).subjectKey), acquisitionMode: "DOM_DIRECT", data: (att.payload as Record<string, unknown>).data } as never;
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("INVALID_CAPTURE_TIME");
    expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now: NOW })).toHaveLength(0);
  });

  it("浏览器直采缺观察时刻 → INVALID_CAPTURE_TIME（零观察，且与消费时刻无关）", () => {
    const att = attachment({ capturedAt: "2026-10-09T12:30:00.000Z", browserObservedAt: null });
    const parsed = { subjectKey: String((att.payload as Record<string, unknown>).subjectKey), acquisitionMode: "DOM_DIRECT", data: (att.payload as Record<string, unknown>).data } as never;
    // 三个消费时刻都判为不可信—— 时间推进不会让不可信证据"转正"。
    for (const now of [new Date("2026-10-09T12:20:00.000Z"), new Date("2026-10-09T13:00:00.000Z"), new Date("2026-10-10T12:30:00.000Z")]) {
      expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now }))
        .toBe("INVALID_CAPTURE_TIME");
      expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now })).toHaveLength(0);
    }
  });

  it("观察时刻晚于采集时刻（时序自相矛盾）→ INVALID_CAPTURE_TIME", () => {
    const att = attachment({ capturedAt: "2026-10-09T12:00:00.000Z", browserObservedAt: "2026-10-09T12:30:00.000Z" });
    const parsed = { subjectKey: String((att.payload as Record<string, unknown>).subjectKey), acquisitionMode: "DOM_DIRECT", data: (att.payload as Record<string, unknown>).data } as never;
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("INVALID_CAPTURE_TIME");
    expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now: NOW })).toHaveLength(0);
  });

  it("窄时钟漂移仍在容差内 → 仍视为合法（不误伤合法来源）", () => {
    // 观察时刻略晚于 capturedAt（小幅时钟漂移，2 秒）→ 仍在容差内
    const att = attachment({ capturedAt: "2026-10-09T12:00:00.000Z", browserObservedAt: "2026-10-09T12:00:02.000Z" });
    const parsed = { subjectKey: String((att.payload as Record<string, unknown>).subjectKey), acquisitionMode: "DOM_DIRECT", data: (att.payload as Record<string, unknown>).data } as never;
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("VERIFIED_NUMERIC_SOURCE");
  });

  it("浏览器直采缺失 browserObservedAt → INVALID_CAPTURE_TIME（时刻无从追溯）", () => {
    const att = attachment({ browserObservedAt: null });
    const parsed = { subjectKey: String((att.payload as Record<string, unknown>).subjectKey), acquisitionMode: "DOM_DIRECT", data: (att.payload as Record<string, unknown>).data } as never;
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("INVALID_CAPTURE_TIME");
    expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now: NOW })).toHaveLength(0);
  });

  it("消费时刻不得影响资格判定（同一证据在任意 now 下结论一致）", () => {
    const att = attachment({});
    const parsed = { subjectKey: String((att.payload as Record<string, unknown>).subjectKey), acquisitionMode: "DOM_DIRECT", data: (att.payload as Record<string, unknown>).data } as never;
    const results = [
      new Date("2026-10-09T12:20:00.000Z"),
      new Date("2026-10-09T13:00:00.000Z"),
      new Date("2026-10-10T12:30:00.000Z"),
      new Date("2030-01-01T00:00:00.000Z"),
    ].map((now) => evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now }));
    expect(new Set(results).size, "资格判定必须与消费时刻无关").toBe(1);
  });

  it("SCREENSHOT_EVIDENCE → 数值观察为 0（截图不能证明数值）", () => {
    const att = attachment({ acquisitionMode: "SCREENSHOT_EVIDENCE" });
    const parsed = { subjectKey: SUBJECT, acquisitionMode: "SCREENSHOT_EVIDENCE" } as never;
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("SCREENSHOT_ONLY");
    expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now: NOW })).toHaveLength(0);
  });

  it("主体不一致 → UNVERIFIED_SOURCE_IDENTITY（零观察）", () => {
    const att = attachment({ subjectKey: "amazon:US:B0OTHER0001" });
    const parsed = {
      subjectKey: "amazon:US:B0OTHER0001",
      acquisitionMode: "DOM_DIRECT",
      data: (att.payload as Record<string, unknown>).data,
    } as never;
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: att, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("UNVERIFIED_SOURCE_IDENTITY");
    expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now: NOW })).toHaveLength(0);
  });

  it("payload 内自我声明的标记不能替代可信判定", () => {
    // 浏览器直采但**时序自相矛盾**：观察时刻比采集时刻晚 10 分钟。
    // 即使 payload 里带各种「已锁定」「已验证」标记也必须拒绝 ——
    // 标记可由写入方自行填写，不构成证明。
    const att = attachment({ capturedAt: "2026-10-09T11:00:00.000Z", browserObservedAt: "2026-10-09T11:10:00.000Z" });
    const payload = att.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    data.identity_locked = true;
    data.visible_tooltip_hover_identity_locked = true;
    data.verified = true;
    data.identityEcho = { input: "B0FIXT0001", urlAsin: "B0FIXT0001" };
    expect(adaptV3HistoricalTrendAttachment(att, SUBJECT, { now: NOW })).toHaveLength(0);
  });
});

describe("PH4-H0 去重与冲突边界（纯 Fixture）", () => {
  function obs(period: string, field: string, value: number, ref: string): TrendObservation {
    return buildTrendObservation({
      observationId: `x:${period}:${field}:${ref}`,
      subjectKey: SUBJECT,
      field,
      value,
      valueKind: "estimated",
      sourceType: "sellersprite_plugin",
      capturedAt: `${period}-01T00:00:00.000Z`,
      evidenceRefs: [ref],
    });
  }

  it("同一 (主体, 期间, 字段) 的同值重复只保留一个时间点（不重复计数）", () => {
    const v3 = [obs("2026-07", "自然流量", 100, "attachment:new")];
    const legacy = [obs("2026-07", "自然流量", 100, "attachment:legacy")];
    const merged = deduplicateTrendObservations(legacy, v3);
    // dedupeKey = hash(subjectKey, field, capturedDate, semanticContentHash)
    // 语义 contentHash 含 value 与 evidenceRefs，因此仅附件引用不同的两点 dedupeKey 不同；
    // 但 (subject, date, field) 唯一 —— 同一时间点只应出现一次，不得计入两个趋势点。
    const semanticKeys = merged.map((o) => `${o.subjectKey}|${o.capturedDate}|${o.field}`);
    expect(new Set(semanticKeys).size).toBe(1);
    // summary 层也只算一个时间点
    const s = summarizeTrendObservations(merged);
    expect(s?.timeWindow).toContain("2026-07");
  });

  it("V3 优先：同语义点以V3 为准", () => {
    const v3 = [obs("2026-07", "自然流量", 100, "attachment:new")];
    const legacy = [obs("2026-07", "自然流量", 100, "attachment:legacy")];
    const merged = deduplicateTrendObservations(legacy, v3);
    expect(merged.length).toBeGreaterThanOrEqual(1);
    expect(merged.some((o) => o.evidenceRefs.includes("attachment:new"))).toBe(true);
  });

  it("不同字段 / 不同 ASIN 不合并", () => {
    const a = obs("2026-07", "自然流量", 100, "attachment:new");
    const b = obs("2026-07", "广告流量", 50, "attachment:new");
    const other = buildTrendObservation({
      observationId: "x:other",
      subjectKey: "amazon:US:B0OTHER0001",
      field: "自然流量",
      value: 100,
      valueKind: "estimated",
      sourceType: "sellersprite_plugin",
      capturedAt: "2026-07-01T00:00:00.000Z",
      evidenceRefs: ["attachment:new"],
    });
    const merged = deduplicateTrendObservations([other], [a, b]);
    // dedupeKey 含 subjectKey+field+capturedDate+contentHash → 跨 ASIN / 跨字段都不合并
    expect(merged.filter((o) => o.subjectKey === "amazon:US:B0OTHER0001")).toHaveLength(1);
    expect(merged.filter((o) => o.subjectKey === SUBJECT)).toHaveLength(2);
    expect(new Set(merged.map((o) => o.dedupeKey)).size).toBe(3);
  });

  it("单个有效时间点 → direction=unknown（不得声明稳定）", () => {
    const s = summarizeTrendObservations([obs("2026-07", "自然流量", 100, "attachment:new")]);
    expect(s?.metrics["自然流量"].direction).toBe("unknown");
  });

  it("多个有效时间点使用正式趋势规则", () => {
    const s = summarizeTrendObservations([
      obs("2026-07", "自然流量", 100, "attachment:new"),
      obs("2026-08", "自然流量", 120, "attachment:new"),
      obs("2026-09", "自然流量", 150, "attachment:new"),
    ]);
    expect(s?.metrics["自然流量"].direction).toBe("rising");
  });

  it("Keepa 窗口聚合指标仍是窗口语义，不冒充逐月时间点", () => {
    const keepa = attachment({
      attachmentId: "att-keepa-fixture",
      contentHash: "b".repeat(64),
      acquisitionMode: "FILE_EXPORT",
      series: [],
    });
    const payload = keepa.payload as Record<string, unknown>;
    (payload.data as Record<string, unknown>).timeSeries = { "90d-low": 12.5, "30d-low": null };
    (payload.data as Record<string, unknown>).series = undefined;
    (payload.data as Record<string, unknown>).sourceFileSha256 = "c".repeat(64);
    delete (payload.data as Record<string, unknown>).browserObservedAt;
    const parsed = {
      subjectKey: SUBJECT,
      acquisitionMode: "FILE_EXPORT",
      data: payload.data,
    } as never;
    // 文件导入来源不做浏览器观察时刻要求 → 不被 SellerSprite 门禁误伤
    expect(evaluateHistoricalTrendSourceEligibility({ attachment: keepa, parsed, expectedSubjectKey: SUBJECT, now: NOW }))
      .toBe("VERIFIED_NUMERIC_SOURCE");
  });
});