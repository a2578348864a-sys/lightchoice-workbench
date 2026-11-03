/**
 * PH4-H0 SellerSprite 可见 Tooltip 序列 → Research 适配验收（真实隔离附件）
 *
 * ⚠️ 本文件已按 PH4-H0 Consumer 收口要求重写：
 *  - 精确指向**可信新附件** att-4fddc36e5f8a02e94b98ba6c（不再读 .tmp 临时副本，
 *    也不再以「首个匹配文件」方式选取）；
 *  - 完整 SHA-256 与 subjectKey 精确一致，不接受任意 64 位十六进制；
 *  - 明确断言不可信旧附件 att-ee863c6（采集时刻不可信）零数值消费、零引用。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adaptV3HistoricalTrendAttachment,
  deduplicateTrendObservations,
  summarizeTrendObservations,
} from "@/lib/server/research/v3EvidenceResearchAdapter";

const SUBJECT = "amazon:US:B07Z5K2X2C";
const LIVE_STORE_ROOT = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_DIR;
const LIVE_FIXTURE_TESTS_ENABLED = process.env.LIGHTCHOICE_LIVE_EVIDENCESTORE_TESTS === "1" && Boolean(LIVE_STORE_ROOT);
const SUBJECT_DIR = LIVE_STORE_ROOT
  ? join(LIVE_STORE_ROOT, "owner-v1", "subjects", "amazon%3AUS%3AB07Z5K2X2C")
  : "";

/** 真实附件的文件名 = contentHash（EvidenceStore 内容寻址），因此可精确定位。 */
const NEW_HASH = "c4e94f23307cd9b65dae8e649cd3698a96ebb31a3eb26e6a87662efa7b3da1c5";
const NEW_ATTACHMENT = "att-4fddc36e5f8a02e94b98ba6c";
const OLD_HASH = "842749c176d4c8eb56c1429a195903beb4c389e5f31bfe0d4c218e629fb08b78";
const OLD_ATTACHMENT = "att-ee863c6fedb167ee5ebaac08";

function loadExact(hash: string, attachmentId: string): Record<string, unknown> {
  const att = JSON.parse(readFileSync(`${SUBJECT_DIR}/a-${hash}.json`, "utf8")) as Record<string, unknown>;
  // 精确身份：附件 ID、哈希、主体键三者都必须完全一致，任一不符即失败。
  expect(att.attachmentId).toBe(attachmentId);
  expect(att.contentHash).toBe(hash);
  expect(att.subjectKey).toBe(SUBJECT);
  return att;
}

describe.skipIf(!LIVE_FIXTURE_TESTS_ENABLED)("PH4-H0 可信新附件 → Research 适配（真实隔离 EvidenceStore）", () => {
  let att = {} as Record<string, unknown>;
  beforeAll(() => {
    att = loadExact(NEW_HASH, NEW_ATTACHMENT);
  });

  it("附件身份与来源字段（精确，不做模糊匹配）", () => {
    expect(att.kind).toBe("v3_historical_trend_v1");
    expect(att.sourceType).toBe("sellersprite_plugin");
    const payload = att.payload as Record<string, unknown>;
    expect(payload.subjectKey).toBe(SUBJECT);
    expect(payload.acquisitionMode).toBe("DOM_DIRECT");
    expect(payload.metricNature).toBe("provider_estimate");
  });

  it("采集时刻可信：晚于浏览器观察时刻、且不晚于消费时刻", () => {
    const captured = Date.parse(String(att.capturedAt));
    expect(Number.isNaN(captured)).toBe(false);
    const data = (att.payload as Record<string, unknown>).data as Record<string, unknown>;
    const observed = Date.parse(String(data.browserObservedAt));
    expect(Number.isNaN(observed)).toBe(false);
    // 观察 ≤ 采集
    expect(observed).toBeLessThanOrEqual(captured);
    // 采集不得晚于当前时刻（超出时钟容差即不可信）
    expect(captured).toBeLessThanOrEqual(Date.now());
    // 不得是旧附件那个客户端写死的时间
    expect(att.capturedAt).not.toBe("2026-10-09T12:30:00.000Z");
  });

  it("适配为按期间分布的 TrendObservation（期间 ≠ 采集日）", () => {
    const obs = adaptV3HistoricalTrendAttachment(att as never, SUBJECT);
    expect(obs.length).toBeGreaterThan(15);
    const periods = [...new Set(obs.map((o) => o.capturedDate))].sort();
    expect(periods[0]).toMatch(/^20\d{2}-\d{2}/);
    expect(obs.every((o) => o.capturedDate !== String(att.capturedAt).slice(0, 10))).toBe(true);
    expect(obs.every((o) => o.sourceType === "sellersprite_plugin")).toBe(true);
    expect(obs.every((o) => o.valueKind === "estimated")).toBe(true);
    expect(obs.every((o) => o.evidenceRefs.length === 1 && o.evidenceRefs[0] === `attachment:${NEW_ATTACHMENT}`)).toBe(true);
  });

  it("计数与占比是不同字段，未混成同一指标", () => {
    const obs = adaptV3HistoricalTrendAttachment(att as never, SUBJECT);
    const fields = new Set(obs.map((o) => o.field));
    expect([...fields].some((f) => f.includes("自然流量") && !f.includes("sharePct"))).toBe(true);
    expect([...fields].some((f) => f.includes("sharePct"))).toBe(true);
  });

  it("单一 (期间, 字段) 只有一个观察点（不重复计数）", () => {
    const obs = adaptV3HistoricalTrendAttachment(att as never, SUBJECT);
    const keys = obs.map((o) => `${o.capturedDate}|${o.field}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe.skipIf(!LIVE_FIXTURE_TESTS_ENABLED)("PH4-H0 不可信旧附件 → 必须被消费层拒绝", () => {
  let att = {} as Record<string, unknown>;
  beforeAll(() => {
    att = loadExact(OLD_HASH, OLD_ATTACHMENT);
  });

  it("旧附件的采集时刻不可追溯（浏览器直采但缺观察时刻），且与当前时刻无关", () => {
    const payload = att.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    // 该附件 capturedAt 由客户端写死，且**没有**记录浏览器观察时刻 → 时刻无从追溯。
    // 注意：断言不依赖「capturedAt 是未来时间」——该前提会随现实时间推进而失效，
    // 真正的门禁依据是「浏览器直采来源必须自证观察时刻」。
    expect(String(att.capturedAt)).toBe("2026-10-09T12:30:00.000Z");
    expect(data.browserObservedAt).toBeUndefined();
    expect(payload.acquisitionMode).toBe("DOM_DIRECT");
    // 无论当前时刻如何推进，资格结论都必须稳定为不可信。
    const results = [
      new Date("2026-10-09T12:20:00.000Z"),
      new Date("2026-10-09T13:00:00.000Z"),
      new Date("2026-10-10T12:30:00.000Z"),
    ].map((now) => adaptV3HistoricalTrendAttachment(att as never, SUBJECT, { now }).length);
    expect(results).toEqual([0, 0, 0]);
  });

  it("旧附件产生零数值观察", () => {
    expect(adaptV3HistoricalTrendAttachment(att as never, SUBJECT)).toHaveLength(0);
  });

  it("新旧混合时旧附件既不产生观察也不进入摘要引用", () => {
    const fresh = loadExact(NEW_HASH, NEW_ATTACHMENT);
    const fromOld = adaptV3HistoricalTrendAttachment(att as never, SUBJECT);
    const fromNew = adaptV3HistoricalTrendAttachment(fresh as never, SUBJECT);
    const merged = deduplicateTrendObservations([], [...fromOld, ...fromNew]);
    const summary = summarizeTrendObservations(merged);

    expect(merged).toHaveLength(fromNew.length);
    expect(summary?.evidenceRefs ?? []).not.toContain(`attachment:${OLD_ATTACHMENT}`);
    expect(summary?.evidenceRefs ?? []).toContain(`attachment:${NEW_ATTACHMENT}`);
  });

  it("旧附件即使 subjectKey 匹配也不放行（不得按 ID 拉黑，也不得靠主体匹配蒙混）", () => {
    expect(att.subjectKey).toBe(SUBJECT);
    expect(adaptV3HistoricalTrendAttachment(att as never, SUBJECT)).toHaveLength(0);
  });
});
