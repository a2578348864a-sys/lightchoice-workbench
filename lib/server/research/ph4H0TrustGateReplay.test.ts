/**
 * 任务一：跨时间重放资格失效复现（确定性，Fixture，不依赖当前时钟）
 *
 * 目的：证明「仅比较 attachment.capturedAt 与消费时刻 now」的门禁，
 * 会让同一个不可信旧附件随着现实时间前进而重新获得可信资格。
 */
import { describe, expect, it } from "vitest";
import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import {
  adaptV3HistoricalTrendAttachment,
  evaluateHistoricalTrendSourceEligibility,
} from "@/lib/server/research/v3EvidenceResearchAdapter";
import { allowedEvidenceRefsOf } from "@/lib/server/v5ResearchService";

const SUBJECT = "amazon:US:B0FIXT0001";
const OLD_CAPTURED_AT = "2026-10-09T12:30:00.000Z"; // 旧附件：客户端写死的未来时间
const OLD_ATTACHMENT = "att-fixture-old";
const OLD_HASH = "1".repeat(64);

const NOW_A = new Date("2026-10-09T12:20:00.000Z"); // 声称时间之前
const NOW_B = new Date("2026-10-09T13:00:00.000Z"); // 声称时间之后 30 分钟
const NOW_C = new Date("2026-10-10T12:30:00.000Z"); // 一天之后

function oldAttachment(): SourceEvidenceAttachment {
  return {
    attachmentId: OLD_ATTACHMENT,
    kind: "v3_historical_trend_v1",
    sourceType: "sellersprite_plugin",
    subjectKey: SUBJECT,
    sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0FIXT0001&marketId=1",
    capturedAt: OLD_CAPTURED_AT,
    contentHash: OLD_HASH,
    capturedFromVisibleDom: true,
    payload: {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: "historical_trend",
      subjectKey: SUBJECT,
      marketplace: "US",
      capturedAt: OLD_CAPTURED_AT,
      provider: "SellerSprite",
      sourceSurface: "SellerSprite keyword reverse tooltip",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/?q=B0FIXT0001&marketId=1",
      providerUpdatedAt: null,
      freshness: { cadenceKey: "historical_window", ttlMs: 2_592_000_000, providerUpdatedAt: null, ageMs: null, state: "unknown" },
      acquisitionMode: "DOM_DIRECT",
      metricNature: "provider_estimate",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["provider_estimate_series"],
      identity: { asin: "B0FIXT0001", parentAsin: null, keyword: null, query: null, category: null },
      data: {
        series: [
          { date: "2026-07", "自然流量": 100 },
          { date: "2026-08", "自然流量": 120 },
        ],
        // 真实旧附件特征：**没有** browserObservedAt / identityEcho
        // （其采集时刻由客户端写死，无可追溯的观察时刻）
        collectionMethod: "visible_tooltip_hover",
      },
      evidenceOnly: true,
    },
  } as unknown as SourceEvidenceAttachment;
}

const parsedFor = (att: SourceEvidenceAttachment) => ({
  subjectKey: SUBJECT,
  acquisitionMode: "DOM_DIRECT",
  data: (att.payload as Record<string, unknown>).data,
  payload: att.payload,
}) as never;

describe("PH4-H0 跨时间重放资格诊断", () => {
  it("记录旧附件在三个消费时刻的资格 / 观察数 / 白名单", () => {
    const att = oldAttachment();
    const parsed = parsedFor(att);

    const rows = [
      { label: "A(声称时间之前)", now: NOW_A },
      { label: "B(声称时间之后30分钟)", now: NOW_B },
      { label: "C(一天之后)", now: NOW_C },
    ].map(({ label, now }) => {
      const eligibility = evaluateHistoricalTrendSourceEligibility({
        attachment: att,
        parsed,
        expectedSubjectKey: SUBJECT,
        now,
      });
      const observations = adaptV3HistoricalTrendAttachment(att, SUBJECT, { now });
      const allow = allowedEvidenceRefsOf({
        trendObservations: observations.map((o) => ({ evidenceRefs: o.evidenceRefs })),
      });
      return {
        label,
        eligibility,
        observations: observations.length,
        refAllowed: allow.includes(`attachment:${OLD_ATTACHMENT}`),
      };
    });

    console.log("[T1] " + JSON.stringify(rows, null, 1));

    // 核心门禁：资格不得因消费时间前进而从不可信变为可信。
    const eligibilityValues = rows.map((r) => r.eligibility);
    const observationValues = rows.map((r) => r.observations);
    const refValues = rows.map((r) => r.refAllowed);

    console.log("[T1] eligibilitySet=", JSON.stringify([...new Set(eligibilityValues)]));
    console.log("[T1] observationsSet=", JSON.stringify([...new Set(observationValues)]));
    console.log("[T1] refAllowedSet=", JSON.stringify([...new Set(refValues)]));
    console.log(
      "[T1] TIME_DEPENDENT_REQUALIFICATION=",
      new Set(eligibilityValues).size > 1 ? "YES" : "NO",
    );

    // 本断言在修复前应失败（这正是本轮要修的缺陷）。
    expect(new Set(eligibilityValues).size, "资格必须与消费时刻无关").toBe(1);
    expect(new Set(observationValues).size, "观察数必须与消费时刻无关").toBe(1);
    expect(new Set(refValues).size, "白名单必须与消费时刻无关").toBe(1);
    // 且旧附件在任何时刻都不得产生可信数值消费
    expect(eligibilityValues).toEqual(["INVALID_CAPTURE_TIME", "INVALID_CAPTURE_TIME", "INVALID_CAPTURE_TIME"]);
    expect(observationValues).toEqual([0, 0, 0]);
    expect(refValues).toEqual([false, false, false]);
  });

  it("反向门禁：具备可追溯观察时刻的新附件，在任何消费时刻都应合法", () => {
    const base = oldAttachment();
    const payload = base.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    // 真实新附件特征：observed ≤ captured，且间隔在毫秒级
    data.browserObservedAt = "2026-10-09T12:29:59.900Z";
    data.identityEcho = { input: "B0FIXT0001", urlAsin: "B0FIXT0001" };
    data.collectionMethod = "visible_tooltip_hover_identity_locked";
    // 注意：parsed 必须反映改动后的 payload（正式 adapter 内部走parseV3ModuleEvidence，
    // 这里直传判定函数，因此两者需一致）。
    const att = {
      ...base,
      attachmentId: "att-fixture-new",
      contentHash: "2".repeat(64),
    } as SourceEvidenceAttachment;
    const parsed = parsedFor(att);

    const rows = [
      { label: "A", now: NOW_A },
      { label: "B", now: NOW_B },
      { label: "C", now: NOW_C },
    ].map(({ label, now }) => {
      const eligibility = evaluateHistoricalTrendSourceEligibility({
        attachment: att,
        parsed,
        expectedSubjectKey: SUBJECT,
        now,
      });
      const observations = adaptV3HistoricalTrendAttachment(att, SUBJECT, { now });
      const allow = allowedEvidenceRefsOf({
        trendObservations: observations.map((o) => ({ evidenceRefs: o.evidenceRefs })),
      });
      return {
        label,
        eligibility,
        observations: observations.length,
        refAllowed: allow.includes(`attachment:${att.attachmentId}`),
      };
    });

    console.log("[T1-new] " + JSON.stringify(rows, null, 1));
    // 消费时刻不得影响判定：三个时刻结论必须完全一致且为 VERIFIED
    expect(rows.map((r) => r.eligibility)).toEqual([
      "VERIFIED_NUMERIC_SOURCE",
      "VERIFIED_NUMERIC_SOURCE",
      "VERIFIED_NUMERIC_SOURCE",
    ]);
    expect(rows.map((r) => r.observations)).toEqual([2, 2, 2]);
    expect(rows.map((r) => r.refAllowed)).toEqual([true, true, true]);
  });

  it("时序颠倒的观察时刻（observed晚于 captured）必须被拒，且与消费时刻无关", () => {
    const base = oldAttachment();
    const payload = base.payload as Record<string, unknown>;
    (payload.data as Record<string, unknown>).browserObservedAt = "2026-10-09T12:40:00.000Z";
    const att = { ...base, attachmentId: "att-fixture-inverted" } as SourceEvidenceAttachment;
    const parsed = parsedFor(att);

    const values = [NOW_A, NOW_B, NOW_C].map((now) => ({
      now: now.toISOString(),
      eligibility: evaluateHistoricalTrendSourceEligibility({
        attachment: att,
        parsed,
        expectedSubjectKey: SUBJECT,
        now,
      }),
      observations: adaptV3HistoricalTrendAttachment(att, SUBJECT, { now }).length,
    }));
    console.log("[T1-inverted] " + JSON.stringify(values, null, 1));
    expect(values.map((v) => v.eligibility)).toEqual([
      "INVALID_CAPTURE_TIME",
      "INVALID_CAPTURE_TIME",
      "INVALID_CAPTURE_TIME",
    ]);
    expect(values.map((v) => v.observations)).toEqual([0, 0, 0]);
  });
});