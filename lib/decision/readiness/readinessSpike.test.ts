/**
 * Jev Research Readiness — 零费用隔离 Spike 定向测试（安全加固版）
 *
 * 覆盖 P0-1 请求计数 / P0-2 forceRefresh 代次竞争 / P0-3 输入证据白名单 + 既有验收点。
 * 全部离线；不触网；不写任何状态；只读使用正式 R3 的真实字段快照。
 *
 * 重要声明：本测试通过**不能**证明真实 Jev 模型的判断质量。
 * 桩输出由输入确定性派生；语义矛盾检测在桩中显式留空。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJevReadinessInput,
  resolveVocThemeCredentials,
  type ReadinessSourcePort,
  type VocObservationCredential,
} from "./inputAdapter";
import { createNetworkGuard, createOfflineAdviceProvider, OFFLINE_PROVIDER_ID, type OfflineScenario } from "./offlineProvider";
import { bindingKey, createCumulativeRequestTracker, createReadinessCache, createScopedRequestTracker, inputFingerprint, isAdviceStale, runReadinessAdvisory } from "./runner";
import { parseJevReadinessAdvice, verdictEvidenceRefs } from "./schema";
import type { JevReadinessInput, ReadinessAdviceProvider } from "./types";

/* ────────────────────────────────────────────────────────────────
 * 真实样本快照（只读取自 R3 正式库，字段值原样保留）
 * ──────────────────────────────────────────────────────────────── */

const REAL_REF = {
  capB0CWPNBC4Z: "evidence:ev-cap-899f2e3e-c7e2-4a44-9a27-e4dbf9c2d1fc-3a863debc23bcf5b",
  attB0CWPNBC4Z: "attachment:att-c75d3089e2348b689bbe861e",
  attHashB0CWPNBC4Z: "attachment:3b6227df8c405ee31fbe61c70717a7ac9b28b0f35020b69093ca9db3465d2441",
  capB0HFS7K4GP: "evidence:ev-cap-932a7b64-b892-4635-b667-fae9ee5878b8-d37f2ef170049d37",
  attB0HFS7K4GP: "attachment:att-5dbfcc96ad62f0bcea514ad5",
} as const;

/** 生产白名单实际产出形态（allowedEvidenceRefsOf：evidence: + attachment: 命名空间） */
const STRICT_ALLOWLIST = [REAL_REF.capB0CWPNBC4Z, REAL_REF.attB0CWPNBC4Z, REAL_REF.attHashB0CWPNBC4Z];

/** VOC 观测标识命名空间（customerVoiceService 产出 amazon-content:<identity>） */
const VOC_REFS = {
  thin: "amazon-content:d6adb1c4e0ea856f3c6b47fbebf0a46ce8bbd00d",
  small: "amazon-content:e53ce37b9ed65a21947767faf0bc75bda1e5f19d",
} as const;

/**
 * P1-2 确定性映射：外部观测身份 → 该观测的正式 attachment 凭证。
 * 与生产一致：`lib/server/customerVoiceService.ts` 为每条观测设置
 * `evidenceRefs: ["attachment:<attachmentId>"]`，且 `refId === attachment:<attachmentId>`（已有 409 强校验）。
 */
const SAMPLE_A_TASK = "cmv795sl90002z7ukje2l9ahn"; // B0CWPNBC4Z
const SAMPLE_B_TASK = "cmv807ra30002gzsmq7al1vke"; // B0CFTP6JR4（无正式研报）
const SAMPLE_C_TASK = "cmv795sm70005z7uk29v9d837"; // B0HFS7K4GP（VOC 稀疏）

const VOC_CREDENTIALS: readonly VocObservationCredential[] = [
  { externalContentId: VOC_REFS.thin, evidenceRefs: [REAL_REF.attB0CWPNBC4Z], taskId: SAMPLE_A_TASK },
  { externalContentId: VOC_REFS.small, evidenceRefs: [REAL_REF.attB0CWPNBC4Z], taskId: SAMPLE_A_TASK },
];

function portA(overrides: Partial<ReadinessSourcePort> = {}): ReadinessSourcePort {
  return {
    taskId: SAMPLE_A_TASK,
    asin: "B0CWPNBC4Z",
    binding: { reportHash: "bf4718b75275cb4d6720c60b9998110b97968ca407e58689d669b1a1c060edb5", factHash: "6dada3e62f0f8afed36f4a9d14dc51cfab988e902a10892f5c68655a76028753", evidenceHash: "8428369a3416cc928d5d78b9ab181ac7777e9d9a636d00f4898d08503234b6d6", researchRevision: 3 },
    // 确定性 riskGate 需 EvidenceStore 边界，本 Spike 未重建 → 显式 null（不编造）
    riskGate: null,
    decisionSummary: {
      researchPriority: "P2",
      recommendedNextAction: "补充数据",
      keyReasons: ["存在真实正向信号与稳定需求", "关键商业字段缺失"],
      blockingRisks: ["利润模型未建立"],
      missingInformation: ["采购成本 (COGS)", "大类/细分 BSR 排名", "品牌与类目归属"],
    },
    narratives: [
      { text: "Luckyiren 2 片装硅胶烘焙垫在 Amazon US 以 5.99 美元在售，评分 4.6、评论数 975，页面显示过去一个月约 1000 人购买。", evidenceRefs: [...STRICT_ALLOWLIST] },
      { text: "该商品可能适合作为厨房耗材类目引流品（无引用，应为未验证假设）。", evidenceRefs: [] },
    ],
    voc: {
      independentReviewCount: 13,
      themeMentionCount: 10,
      themes: [
        { label: "垫子偏薄，影响烘焙时间与温度", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: [VOC_REFS.thin] },
        { label: "尺寸比预期小", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: [VOC_REFS.small] },
        { label: "不粘效果好，烘焙食品易脱模", reviewCount: 6, strength: "recurring", kind: "positive", evidenceRefs: [VOC_REFS.thin] },
      ],
    },
    vocObservationCredentials: VOC_CREDENTIALS,
    allowedEvidenceRefs: [...STRICT_ALLOWLIST],
    fieldPresence: { title: "present", price: "present", rating: "present", reviewCount: "present", brand: "missing", category: "missing", bsr: "missing", fbaFee: "missing", cogs: "missing", moq: "missing" },
    ...overrides,
  };
}

function portB(): ReadinessSourcePort {
  return {
    taskId: SAMPLE_B_TASK,
    asin: "B0CFTP6JR4",
    // 无正式研报：rev=0、无 reportHash（原样保留 R3 事实）
    binding: { reportHash: null, factHash: null, evidenceHash: null, researchRevision: 0 },
    riskGate: null,
    decisionSummary: null,
    narratives: [],
    voc: {
      independentReviewCount: 9,
      themeMentionCount: 8,
      themes: [{ label: "表面滑，清洗时不易固定", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: ["amazon-content:922ee3aa79da2770898c705a84a4e000b87d819c"] }],
    },
    allowedEvidenceRefs: [REAL_REF.capB0CWPNBC4Z],
    fieldPresence: { title: "present", price: "missing", rating: "missing", reviewCount: "missing", brand: "missing", category: "missing", bsr: "missing" },
  };
}

function portC(): ReadinessSourcePort {
  return {
    taskId: SAMPLE_C_TASK,
    asin: "B0HFS7K4GP",
    binding: { reportHash: "7d9cfc2741438dd278c7455d0b35099b420a50e0aedbb634c68a58b415724def", factHash: "face9c77048d5d2f0aa7be6c60dc56996a68f06bfbb07ed6b7df8cc04ba7a183", evidenceHash: "fc0428ca516dcbf8bfb29c1646ecd7399d60bceef039e7cc228150571388cc22", researchRevision: 2 },
    riskGate: null,
    decisionSummary: {
      researchPriority: "P3",
      recommendedNextAction: "补充数据",
      keyReasons: ["样本极小"],
      blockingRisks: [],
      missingInformation: ["独立评论样本不足（仅 2 条）"],
    },
    narratives: [{ text: "该商品为带卡扣边缘的防漏硅胶烘焙垫，页面快照价 15.88 美元、评分 5.0 但仅 2 条评论。", evidenceRefs: [REAL_REF.capB0HFS7K4GP] }],
    voc: {
      independentReviewCount: 2,
      themeMentionCount: 1,
      themes: [{ label: "首次扣合需较大力气", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: ["amazon-content:e1db2bf1da49168d2ae071e5c92da0eb9c1f33c4"] }],
    },
    vocObservationCredentials: [
      { externalContentId: "amazon-content:e1db2bf1da49168d2ae071e5c92da0eb9c1f33c4", evidenceRefs: [REAL_REF.attB0HFS7K4GP], taskId: SAMPLE_C_TASK },
    ],
    allowedEvidenceRefs: [REAL_REF.capB0HFS7K4GP, REAL_REF.attB0HFS7K4GP],
    fieldPresence: { title: "present", price: "present", rating: "present", reviewCount: "present", brand: "missing", category: "missing", bsr: "missing" },
  };
}

/* ────────────────────────────────────────────────────────────────
 * 测试工具：可控 Promise（禁止 sleep）+ 门控 Provider
 * ──────────────────────────────────────────────────────────────── */

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason?: unknown) => void };

function createDeferred(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 构造最小合法输出载荷（绑定与输入一致、无禁止字段、引用条目为空） */
function availableAdviceFor(input: JevReadinessInput, tag: string) {
  return {
    status: "available",
    readiness: "NEED_MORE_EVIDENCE",
    reviewQuestions: [],
    contradictions: [],
    missingEvidence: [],
    limitations: [tag],
    inputBinding: { ...input.binding },
  };
}

/** 门控 Provider：每次调用返回可控 Promise，由测试决定结算顺序（替代 sleep） */
function createGatedProvider(providerId: string) {
  const calls: { readonly input: JevReadinessInput; readonly deferred: Deferred }[] = [];
  const provider: ReadinessAdviceProvider = {
    providerId,
    advise(input: JevReadinessInput): Promise<unknown> {
      const deferred = createDeferred();
      calls.push({ input, deferred });
      return deferred.promise;
    },
  };
  return { provider, calls };
}

/* ────────────────────────────────────────────────────────────────
 * P0-1 输入指纹：稳定、完整、嵌套敏感
 * ──────────────────────────────────────────────────────────────── */

describe("P0-1 输入指纹（稳定规范化 + SHA-256）", () => {
  const base = () => buildJevReadinessInput(portA());

  it("F1 VOC reviewCount 变化 → 指纹变化", () => {
    const a = base();
    const b = buildJevReadinessInput(portA({
      voc: { ...portA().voc!, themes: [{ label: "垫子偏薄，影响烘焙时间与温度", reviewCount: 100, strength: "recurring", kind: "pain", evidenceRefs: [VOC_REFS.thin] }] },
    }));
    expect(inputFingerprint(b)).not.toBe(inputFingerprint(a));
  });

  it("F2 VOC strength 变化 → 指纹变化", () => {
    const a = base();
    const b = buildJevReadinessInput(portA({
      voc: { ...portA().voc!, themes: [{ label: "垫子偏薄，影响烘焙时间与温度", reviewCount: 1, strength: "weak", kind: "pain", evidenceRefs: [VOC_REFS.thin] }] },
    }));
    expect(inputFingerprint(b)).not.toBe(inputFingerprint(a));
  });

  it("F3 风险原因变化 → 指纹变化", () => {
    const a = base();
    const b = buildJevReadinessInput(portA({
      riskGate: { status: "blocked", hasBlockingRisk: true, blockingReasons: ["利润为负"], warningReasons: [], ruleCounts: { blocking: 1, warning: 0, notComputable: 0, passed: 3 } },
    }));
    expect(inputFingerprint(b)).not.toBe(inputFingerprint(a));
  });

  it("F4 研究叙述变化 → 指纹变化", () => {
    const a = base();
    const b = buildJevReadinessInput(portA({
      narratives: [{ text: "完全不同的研究叙述文本。", evidenceRefs: [...STRICT_ALLOWLIST] }],
    }));
    expect(inputFingerprint(b)).not.toBe(inputFingerprint(a));
  });

  it("F5 证据引用变化 → 指纹变化", () => {
    const a = base();
    const b = buildJevReadinessInput(portA({ allowedEvidenceRefs: [REAL_REF.capB0CWPNBC4Z] }));
    expect(inputFingerprint(b)).not.toBe(inputFingerprint(a));
  });

  it("F6 完全相同的输入 → 相同指纹", () => {
    expect(inputFingerprint(base())).toBe(inputFingerprint(base()));
  });

  it("F7 对象键顺序不同但语义一致 → 指纹相同", () => {
    const a: JevReadinessInput = { ...base() };
    const reordered: JevReadinessInput = {
      fieldPresence: a.fieldPresence,
      allowedEvidenceRefs: a.allowedEvidenceRefs,
      vocRefResolution: a.vocRefResolution,
      voc: a.voc,
      unverifiedNarratives: a.unverifiedNarratives,
      verifiedNarratives: a.verifiedNarratives,
      decisionSummary: a.decisionSummary,
      missingInformation: a.missingInformation,
      riskGateSummary: a.riskGateSummary,
      binding: a.binding,
      asin: a.asin,
      taskId: a.taskId,
      schema: a.schema,
    };
    expect(inputFingerprint(reordered)).toBe(inputFingerprint(a));
  });

  it("F8 会被静默丢失的输入类型 → 显式抛错，绝不静默归一", () => {
    const a = base();
    const lossy = { ...a, missingInformation: [...a.missingInformation, undefined as unknown as string] };
    expect(() => inputFingerprint(lossy)).toThrow(/UNFINGERPRINTABLE/);
  });
});

/* ────────────────────────────────────────────────────────────────
 * P0-2 证据引用校验：零未捕获异常
 * ──────────────────────────────────────────────────────────────── */

describe("P0-2 证据引用校验（严格类型 + 白名单，绝不抛未捕获异常）", () => {
  const items = [
    { name: "合法字符串 + null", refs: [REAL_REF.attB0CWPNBC4Z, null], expected: "EVIDENCE_REF_TYPE_INVALID:1" },
    { name: "合法字符串 + 数字", refs: [REAL_REF.attB0CWPNBC4Z, 42], expected: "EVIDENCE_REF_TYPE_INVALID:1" },
    { name: "合法字符串 + 对象", refs: [REAL_REF.attB0CWPNBC4Z, { refId: "x" }], expected: "EVIDENCE_REF_TYPE_INVALID:1" },
    { name: "空数组", refs: [], expected: "empty_refs" },
    { name: "非数组", refs: "attachment:att-x", expected: "EVIDENCE_REFS_NOT_ARRAY" },
    { name: "只有空白字符串", refs: ["   "], expected: "EVIDENCE_REF_EMPTY:0" },
    { name: "不在白名单中的引用", refs: ["evidence:not-in-allowlist-001"], expected: "not_in_allowlist" },
  ] as const;

  for (const item of items) {
    it(`R · ${item.name} → 明确失败（${item.expected}）且不抛异常`, () => {
      let verdict: ReturnType<typeof verdictEvidenceRefs> | undefined;
      expect(() => { verdict = verdictEvidenceRefs("一条合法的复核问题", item.refs, STRICT_ALLOWLIST); }).not.toThrow();
      expect(verdict?.accepted).toBe(false);
      expect(verdict?.reason).toBe(item.expected);
      expect(verdict?.refs).toEqual([]);
    });
  }

  it("R · 完全合法的多个引用 → 成功并返回规范化引用", () => {
    const verdict = verdictEvidenceRefs("一条合法的复核问题", [REAL_REF.attB0CWPNBC4Z, REAL_REF.capB0CWPNBC4Z], STRICT_ALLOWLIST);
    expect(verdict.accepted).toBe(true);
    expect(verdict.reason).toBe("ok");
    expect(verdict.refs).toEqual([REAL_REF.attB0CWPNBC4Z, REAL_REF.capB0CWPNBC4Z]);
  });

  it("R · 整份解析：混合类型引用不会导致未捕获异常，且整份拒收", async () => {
    const input = buildJevReadinessInput(portA());
    let outcome: ReturnType<typeof parseJevReadinessAdvice> | undefined;
    const payload = {
      status: "available",
      readiness: "READY_FOR_HUMAN_REVIEW",
      reviewQuestions: [{ text: "引用混合类型（应被拒收）", evidenceRefs: [REAL_REF.attB0CWPNBC4Z, null] }],
      contradictions: [],
      missingEvidence: [],
      limitations: [],
      inputBinding: { ...input.binding },
    };
    expect(() => { outcome = parseJevReadinessAdvice(payload, input); }).not.toThrow();
    expect(outcome?.ok).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────
 * P1-2 VOC 引用命名空间 → 正式凭证映射
 * ──────────────────────────────────────────────────────────────── */

describe("P1-2 VOC 引用映射（观测标识 → 正式 attachment 凭证）", () => {
  it("V1 提供凭证索引时，主题引用被映射为白名单内的正式凭证", () => {
    const input = buildJevReadinessInput(portA());
    // 3 个主题（2 pain + 1 positive）持有的 amazon-content 引用全部可映射
    expect(input.voc?.themes).toHaveLength(3);
    expect(input.vocRefResolution.mappedThemeRefs).toBe(3);
    expect(input.vocRefResolution.unmappedRefs).toEqual([]);
    for (const theme of input.voc?.themes ?? []) {
      expect(theme.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of theme.evidenceRefs) {
        expect(ref.startsWith("amazon-content:")).toBe(false);
        expect(input.allowedEvidenceRefs).toContain(ref);
      }
    }
  });

  it("V2 无凭证索引时保持 fail-closed：不映射、不放宽白名单、记录未解析引用", () => {
    const input = buildJevReadinessInput(portA({ vocObservationCredentials: [] }));
    expect(input.vocRefResolution.mappedThemeRefs).toBe(0);
    expect(input.voc?.themes).toEqual([]);
    expect(input.vocRefResolution.unmappedRefs).toContain(VOC_REFS.thin);
    expect(input.vocRefResolution.unmappedRefs).toContain(VOC_REFS.small);
    expect(input.allowedEvidenceRefs.some((ref) => ref.startsWith("amazon-content:"))).toBe(false);
  });

  it("V3 部分引用可映射、一条无法映射 → 仍整主题降级（不部分通过）", () => {
    const outcome = resolveVocThemeCredentials({
      taskId: SAMPLE_A_TASK,
      themes: [{ label: "未知引用主题", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: [VOC_REFS.thin, "amazon-content:unknown-identity"] }],
      credentials: VOC_CREDENTIALS,
      allowedRefs: STRICT_ALLOWLIST,
    });
    expect(outcome.mappedThemeRefs).toBe(0);
    expect(outcome.themes).toEqual([]);
    expect(outcome.downgradedThemes).toHaveLength(1);
    expect(outcome.downgradedThemes[0].reason).toBe("UNMAPPED_REF");
    expect(outcome.downgradedThemes[0].unmappedRefs).toEqual(["amazon-content:unknown-identity"]);
  });

  it("V4 凭证不在白名单内 → 整主题降级（双重保险，不放宽白名单）", () => {
    const outcome = resolveVocThemeCredentials({
      taskId: SAMPLE_A_TASK,
      themes: [{ label: "越权凭证", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: [VOC_REFS.thin] }],
      credentials: [{ externalContentId: VOC_REFS.thin, evidenceRefs: ["attachment:not-allowed-xyz"], taskId: SAMPLE_A_TASK }],
      allowedRefs: STRICT_ALLOWLIST,
    });
    expect(outcome.mappedThemeRefs).toBe(0);
    expect(outcome.themes).toEqual([]);
    expect(outcome.downgradedThemes[0].reason).toBe("REF_NOT_IN_ALLOWLIST");
  });

  it("V4b 凭证来自其他任务 → 整主题降级为 FOREIGN_SOURCE", () => {
    const outcome = resolveVocThemeCredentials({
      taskId: SAMPLE_A_TASK,
      themes: [{ label: "跨任务凭证", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: [VOC_REFS.thin] }],
      credentials: [{ externalContentId: VOC_REFS.thin, evidenceRefs: [REAL_REF.attB0CWPNBC4Z], taskId: "another-task-0001" }],
      allowedRefs: STRICT_ALLOWLIST,
    });
    expect(outcome.mappedThemeRefs).toBe(0);
    expect(outcome.themes).toEqual([]);
    expect(outcome.downgradedThemes[0].reason).toBe("FOREIGN_SOURCE");
  });

  it("V5 端到端：映射后离线桩可产出引用正式凭证的复核问题", async () => {
    const input = buildJevReadinessInput(portA());
    const result = await runReadinessAdvisory({ input, provider: createOfflineAdviceProvider("ok"), requestTracker: createScopedRequestTracker().tracker });
    expect(result.status).toBe("available");
    const voicedQuestion = (result.advice?.reviewQuestions ?? []).find((q) => q.text.includes("垫子偏薄"));
    expect(voicedQuestion).toBeDefined();
    expect(voicedQuestion?.evidenceRefs[0]).toBe(REAL_REF.attB0CWPNBC4Z);
    expect(voicedQuestion?.text).toContain("尚未复现");
  });
});

/* ────────────────────────────────────────────────────────────────
 * P0-3 输入证据白名单（非法类型零异常 + 整主题降级 + 叙述全合法）
 * ──────────────────────────────────────────────────────────────── */

describe("P0-3 输入证据白名单（非法类型零异常 + 整主题降级）", () => {
  it("V6 混入 null / 数字 / 对象等非法引用：不抛未捕获异常，且该主题整体降级", () => {
    const makeInput = () =>
      buildJevReadinessInput(portA({
        voc: {
          independentReviewCount: 13,
          themeMentionCount: 3,
          themes: [
            { label: "合法主题", reviewCount: 2, strength: "weak", kind: "pain", evidenceRefs: [VOC_REFS.thin] },
            { label: "混合非法类型", reviewCount: 1, strength: "isolated", kind: "pain", evidenceRefs: [VOC_REFS.thin, null, 42, { refId: "x" }] as unknown as string[] },
          ],
        },
      }));

    expect(makeInput).not.toThrow();
    const input = makeInput();

    // 非法类型主题不得以「部分合法引用」通过
    expect(input.voc?.themes.map((theme) => theme.label)).toEqual(["合法主题"]);
    expect(input.vocRefResolution.downgradedThemes.some((theme) => theme.label === "混合非法类型")).toBe(true);

    // 已验证 VOC 主题不得包含空引用或部分非法引用
    for (const theme of input.voc?.themes ?? []) {
      expect(theme.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of theme.evidenceRefs) {
        expect(ref.trim().length).toBeGreaterThan(0);
        expect(input.allowedEvidenceRefs).toContain(ref);
      }
    }
  });

  it("N1 Research Narrative 引用必须全部合法且在白名单内，否则整条降级为未验证", () => {
    const input = buildJevReadinessInput(portA({
      narratives: [
        { text: "合法叙述（引用全部在白名单内）。", evidenceRefs: [REAL_REF.attB0CWPNBC4Z] },
        { text: "越权叙述（引用不在白名单）。", evidenceRefs: ["evidence:not-in-allowlist-001"] },
        { text: "混合叙述（一条合法一条越权）。", evidenceRefs: [REAL_REF.attB0CWPNBC4Z, "evidence:not-in-allowlist-001"] },
      ],
    }));

    expect(input.verifiedNarratives).toHaveLength(1);
    expect(input.verifiedNarratives[0]?.text).toContain("合法叙述");
    expect(input.unverifiedNarratives).toHaveLength(2);
    expect(input.unverifiedNarratives.join(" ")).toContain("越权叙述");
    expect(input.unverifiedNarratives.join(" ")).toContain("混合叙述");
    for (const narrative of input.verifiedNarratives) {
      expect(narrative.evidenceRefs.length).toBeGreaterThan(0);
      for (const ref of narrative.evidenceRefs) expect(input.allowedEvidenceRefs).toContain(ref);
    }
  });
});

/* ────────────────────────────────────────────────────────────────
 * P0-3 并发去重 / P1-1 失败缓存
 * ──────────────────────────────────────────────────────────────── */

describe("P0-3 并发去重（provider + 四元组 + 完整指纹）", () => {
  it("K1 相同输入并发 3 次，只执行 1 次 Provider", async () => {
    const cache = createReadinessCache();
    const provider = createOfflineAdviceProvider("ok");
    const input = buildJevReadinessInput(portA());
    const runs = await Promise.all([cache.run({ input, provider }), cache.run({ input, provider }), cache.run({ input, provider })]);
    expect(cache.providerCallCount()).toBe(1);
    expect(runs.filter((r) => r.deduped).length).toBe(2);
  });

  it("K2 不同输入但相同版本四元组 → 不能共享结果", async () => {
    const cache = createReadinessCache();
    const provider = createOfflineAdviceProvider("ok");
    const input = buildJevReadinessInput(portA());
    const changed = buildJevReadinessInput(portA({ fieldPresence: { ...portA().fieldPresence, cogs: "present" } }));
    expect(input.binding).toEqual(changed.binding);
    expect(inputFingerprint(input)).not.toBe(inputFingerprint(changed));

    const [a, b] = await Promise.all([cache.run({ input, provider }), cache.run({ input: changed, provider })]);
    expect(a.deduped || b.deduped).toBe(false);
    expect(cache.providerCallCount()).toBe(2);
    expect(a.result).not.toBe(b.result);
  });

  it("K3 不同 Provider → 不能共享结果", async () => {
    const cache = createReadinessCache();
    const input = buildJevReadinessInput(portA());
    const first = await cache.run({ input, provider: createOfflineAdviceProvider("ok") });
    const second = await cache.run({ input, provider: createOfflineAdviceProvider("unconfigured") });
    expect(cache.providerCallCount()).toBe(2);
    expect(first.result.status).toBe("available");
    expect(second.result.status).toBe("unavailable");
  });

  it("K4 同一输入改变 evidenceHash → 不复用旧结果", async () => {
    const cache = createReadinessCache();
    const provider = createOfflineAdviceProvider("ok");
    const input = buildJevReadinessInput(portA());
    await cache.run({ input, provider });
    const rebound = { ...input, binding: { ...input.binding, evidenceHash: "changed-evidence-hash" } };
    const rerun = await cache.run({ input: rebound, provider });
    expect(rerun.cached).toBe(false);
    expect(cache.providerCallCount()).toBe(2);
  });

  it("K5 Provider 失败后 in-flight 状态必须清理，后续可重新执行", async () => {
    const cache = createReadinessCache();
    const input = buildJevReadinessInput(portA());
    const failing = createOfflineAdviceProvider("http500");
    const failed = await cache.run({ input, provider: failing });
    expect(failed.result.status).toBe("failed");

    const retry = await cache.run({ input, provider: createOfflineAdviceProvider("ok") });
    expect(retry.cached).toBe(false);
    expect(retry.result.status).toBe("available");
    expect(cache.providerCallCount()).toBe(2);
  });

  it("K6 显式刷新不会错误返回先前的进行中结果", async () => {
    const cache = createReadinessCache();
    const provider = createOfflineAdviceProvider("ok");
    const input = buildJevReadinessInput(portA());
    const first = cache.run({ input, provider });
    const forced = cache.run({ input, provider, forceRefresh: true });
    const [a, b] = await Promise.all([first, forced]);
    expect(cache.providerCallCount()).toBe(2);
    expect(a.deduped).toBe(false);
    expect(b.cached).toBe(false);
  });
});

describe("P1-1 失败结果不进入成功缓存", () => {
  it("C1 failed 结果不被缓存，后续请求仍会真正执行", async () => {
    const cache = createReadinessCache();
    const input = buildJevReadinessInput(portA());
    await cache.run({ input, provider: createOfflineAdviceProvider("timeout") });
    expect(cache.cachedEntryCount()).toBe(0);
    expect(cache.peek(input, createOfflineAdviceProvider("ok").providerId)).toBeNull();
  });

  it("C2 unavailable 结果不被缓存，也不伪装成成功", async () => {
    const cache = createReadinessCache();
    const input = buildJevReadinessInput(portA());
    const result = await cache.run({ input, provider: createOfflineAdviceProvider("unconfigured") });
    expect(result.result.status).toBe("unavailable");
    expect(cache.cachedEntryCount()).toBe(0);
  });

  it("C3 只有 available 结果被缓存", async () => {
    const cache = createReadinessCache();
    const input = buildJevReadinessInput(portA());
    const provider = createOfflineAdviceProvider("ok");
    await cache.run({ input, provider });
    expect(cache.cachedEntryCount()).toBe(1);
    const again = await cache.run({ input, provider });
    expect(again.cached).toBe(true);
    expect(cache.providerCallCount()).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────
 * P0-2 forceRefresh 代次竞争（可控 Promise，无 sleep）
 * ──────────────────────────────────────────────────────────────── */

describe("P0-2 forceRefresh 代次竞争（可控 Promise，无 sleep）", () => {
  it("AR1 A 先开始、B 强制刷新；B 先结束、A 后结束 → 旧请求不覆盖新缓存", async () => {
    const cache = createReadinessCache();
    const { provider, calls } = createGatedProvider("gated:race-1");
    const input = buildJevReadinessInput(portA());

    const runA = cache.run({ input, provider });
    const runB = cache.run({ input, provider, forceRefresh: true });
    expect(calls).toHaveLength(2);
    expect(cache.providerCallCount()).toBe(2);

    calls[1].deferred.resolve(availableAdviceFor(calls[1].input, "forced"));
    const b = await runB;
    expect(b.result.status).toBe("available");
    expect(cache.inFlightCount()).toBe(0);
    expect(cache.cachedEntryCount()).toBe(1);
    expect(cache.peek(input, provider.providerId)?.advice?.limitations).toContain("forced");

    calls[0].deferred.resolve(availableAdviceFor(calls[0].input, "stale"));
    const a = await runA;
    expect(a.result.status).toBe("available");
    expect(a.result.advice?.limitations).toContain("stale");
    expect(cache.peek(input, provider.providerId)?.advice?.limitations).toContain("forced");
  });

  it("AR2 A 先结束、B 后结束 → A 的完成不删除 B 的 inFlight、也不写缓存", async () => {
    const cache = createReadinessCache();
    const { provider, calls } = createGatedProvider("gated:race-2");
    const input = buildJevReadinessInput(portA());

    const runA = cache.run({ input, provider });
    const runB = cache.run({ input, provider, forceRefresh: true });

    calls[0].deferred.resolve(availableAdviceFor(calls[0].input, "stale"));
    const a = await runA;
    expect(a.result.status).toBe("available");
    expect(cache.inFlightCount()).toBe(1);
    expect(cache.cachedEntryCount()).toBe(0);

    calls[1].deferred.resolve(availableAdviceFor(calls[1].input, "forced"));
    const b = await runB;
    expect(b.result.status).toBe("available");
    expect(cache.inFlightCount()).toBe(0);
    expect(cache.cachedEntryCount()).toBe(1);
    expect(cache.peek(input, provider.providerId)?.advice?.limitations).toContain("forced");
  });

  it("AR3 新请求（强制刷新）失败时不伪造成功结果", async () => {
    const cache = createReadinessCache();
    const { provider, calls } = createGatedProvider("gated:race-3");
    const input = buildJevReadinessInput(portA());

    const runA = cache.run({ input, provider });
    const runB = cache.run({ input, provider, forceRefresh: true });

    calls[1].deferred.reject(new Error("refresh transport failed"));
    const b = await runB;
    expect(b.result.status).toBe("failed");
    expect(b.result.advice).toBeNull();

    calls[0].deferred.resolve(availableAdviceFor(calls[0].input, "stale"));
    const a = await runA;
    expect(a.result.status).toBe("available");
    expect(cache.cachedEntryCount()).toBe(0);
    expect(cache.peek(input, provider.providerId)).toBeNull();
  });

  it("AR4 第三个普通请求加入当前有效代次的 in-flight，不触发新调用", async () => {
    const cache = createReadinessCache();
    const { provider, calls } = createGatedProvider("gated:race-4");
    const input = buildJevReadinessInput(portA());

    const runA = cache.run({ input, provider });
    const runB = cache.run({ input, provider, forceRefresh: true });
    const runC = cache.run({ input, provider });
    expect(calls).toHaveLength(2);
    expect(cache.providerCallCount()).toBe(2);

    calls[1].deferred.resolve(availableAdviceFor(calls[1].input, "forced"));
    const [b, c] = await Promise.all([runB, runC]);
    expect(c.deduped).toBe(true);
    expect(c.result).toBe(b.result);

    calls[0].deferred.resolve(availableAdviceFor(calls[0].input, "stale"));
    await runA;
    expect(cache.peek(input, provider.providerId)?.advice?.limitations).toContain("forced");
  });

  it("AR5 多次连续 forceRefresh 后结果一致，且最近结果可被普通请求命中", async () => {
    const cache = createReadinessCache();
    const provider = createOfflineAdviceProvider("ok");
    const input = buildJevReadinessInput(portA());

    const first = await cache.run({ input, provider, forceRefresh: true });
    const second = await cache.run({ input, provider, forceRefresh: true });
    const third = await cache.run({ input, provider, forceRefresh: true });
    expect(cache.providerCallCount()).toBe(3);

    const readies = [first, second, third].map((run) => run.result.advice?.readiness);
    expect(readies).toEqual(["NEED_MORE_EVIDENCE", "NEED_MORE_EVIDENCE", "NEED_MORE_EVIDENCE"]);

    const cached = await cache.run({ input, provider });
    expect(cached.cached).toBe(true);
    expect(cache.providerCallCount()).toBe(3);
  });
});

/* ────────────────────────────────────────────────────────────────
 * P1-3 副作用声明可验证化
 * ──────────────────────────────────────────────────────────────── */

describe("P0-1/P1-3 请求计数与副作用声明（运行时计量，未测量不得当作 0）", () => {
  it("S1 注入请求计数器 → runtime_measured，外部请求次数如实反映", async () => {
    const input = buildJevReadinessInput(portA());
    const result = await runReadinessAdvisory({ input, provider: createOfflineAdviceProvider("ok"), requestTracker: createScopedRequestTracker().tracker });
    expect(result.sideEffectsVerification).toBe("runtime_measured");
    expect(result.sideEffects.externalRequestAttempted).toBe(0);
    expect(result.provider).toBe(`${OFFLINE_PROVIDER_ID}:ok`);
    expect(result.sideEffects.stateWritten).toBe(false);
    expect(result.sideEffects.reportRegenerated).toBe(false);
  });

  it("S2 未注入计数器 → externalRequestAttempted 为 null（不是 0）+ unverified", async () => {
    const input = buildJevReadinessInput(portA());
    const result = await runReadinessAdvisory({ input, provider: createOfflineAdviceProvider("ok") });
    expect(result.sideEffectsVerification).toBe("unverified");
    expect(result.sideEffects.externalRequestAttempted).toBeNull();
    expect(result.requestTrackerKind).toBe("none");
    expect(result.notes.join(" ")).toContain("不得据此声称零外部请求");
  });

  it("S3 Provider 成功返回后读取计数：作用域内计量如实反映", async () => {
    const input = buildJevReadinessInput(portA());
    const tracker = createScopedRequestTracker();
    const provider: ReadinessAdviceProvider = {
      providerId: "counting:success",
      async advise(callInput) {
        tracker.record(3); // 模拟本次调用期间实际发出的外部请求（离线计量，不触网）
        return availableAdviceFor(callInput, "counted");
      },
    };
    const result = await runReadinessAdvisory({ input, provider, requestTracker: tracker.tracker });
    expect(result.status).toBe("available");
    expect(result.sideEffectsVerification).toBe("runtime_measured");
    expect(result.sideEffects.externalRequestAttempted).toBe(3);
    expect(tracker.activeScopeCount()).toBe(0);
  });

  it("S4 契约中禁止把 externalRequestAttempted 写成静态布尔 false", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/decision/readiness/types.ts"), "utf8");
    expect(source).toContain("externalRequestAttempted: number | null");
    expect(source).not.toContain("externalRequestAttempted: false");
  });

  it("S5 Provider 抛异常后仍正确读取计数（覆盖抛错退出路径）", async () => {
    const input = buildJevReadinessInput(portA());
    const tracker = createScopedRequestTracker();
    const provider: ReadinessAdviceProvider = {
      providerId: "counting:throw",
      async advise() {
        tracker.record(2);
        throw new Error("simulated transport explosion");
      },
    };
    const result = await runReadinessAdvisory({ input, provider, requestTracker: tracker.tracker });
    expect(result.status).toBe("failed");
    expect(result.sideEffects.externalRequestAttempted).toBe(2);
    expect(result.notes.join(" ")).toContain("2 次");
  });

  it("S6 Provider 返回失败结果（未抛错）后仍正确读取计数", async () => {
    const input = buildJevReadinessInput(portA());
    const tracker = createScopedRequestTracker();
    const provider: ReadinessAdviceProvider = {
      providerId: "counting:failed-payload",
      async advise(callInput) {
        tracker.record(1);
        return {
          status: "failed",
          readiness: null,
          reviewQuestions: [],
          contradictions: [],
          missingEvidence: [],
          limitations: [],
          inputBinding: { ...callInput.binding },
        };
      },
    };
    const result = await runReadinessAdvisory({ input, provider, requestTracker: tracker.tracker });
    expect(result.status).toBe("failed");
    expect(result.advice?.status).toBe("failed");
    expect(result.sideEffects.externalRequestAttempted).toBe(1);
  });

  it("S7 Scoped 计数可正确归属并发请求：两个重叠调用各拿到自己的计数", async () => {
    const input = buildJevReadinessInput(portA());
    const tracker = createScopedRequestTracker();
    const deferredOne = createDeferred();
    const deferredTwo = createDeferred();
    const providerOne: ReadinessAdviceProvider = {
      providerId: "scoped:one",
      advise: () => {
        tracker.record(2);
        return deferredOne.promise;
      },
    };
    const providerTwo: ReadinessAdviceProvider = {
      providerId: "scoped:two",
      advise: () => {
        tracker.record(5);
        return deferredTwo.promise;
      },
    };

    const runOne = runReadinessAdvisory({ input, provider: providerOne, requestTracker: tracker.tracker });
    const runTwo = runReadinessAdvisory({ input, provider: providerTwo, requestTracker: tracker.tracker });
    expect(tracker.activeScopeCount()).toBe(2); // 两个作用域真实重叠

    deferredTwo.resolve(availableAdviceFor(input, "two"));
    deferredOne.resolve(availableAdviceFor(input, "one"));
    const [resultOne, resultTwo] = await Promise.all([runOne, runTwo]);

    expect(resultOne.sideEffects.externalRequestAttempted).toBe(2);
    expect(resultTwo.sideEffects.externalRequestAttempted).toBe(5);
    expect(tracker.activeScopeCount()).toBe(0);
  });

  it("S8 Cumulative：并发重叠无法归属 → 先结算的作用域返回 null（不冒充 0）", async () => {
    const input = buildJevReadinessInput(portA());
    const externalCallCount = 0; // 离线场景不产生真实请求增量；仅验证归属规则
    const tracker = createCumulativeRequestTracker(() => externalCallCount);
    const gatedOne = createGatedProvider("cumulative:one");
    const gatedTwo = createGatedProvider("cumulative:two");

    const runOne = runReadinessAdvisory({ input, provider: gatedOne.provider, requestTracker: tracker });
    const runTwo = runReadinessAdvisory({ input, provider: gatedTwo.provider, requestTracker: tracker });

    gatedOne.calls[0].deferred.resolve(availableAdviceFor(input, "one"));
    const resultOne = await runOne; // 先结算：另一个作用域仍活跃 → 无法可靠归属
    expect(resultOne.sideEffects.externalRequestAttempted).toBeNull();
    expect(resultOne.sideEffectsVerification).toBe("unverified");

    gatedTwo.calls[0].deferred.resolve(availableAdviceFor(input, "two"));
    const resultTwo = await runTwo; // 无并发活跃作用域且计量窗口内无增量 → 按累计差值计量
    expect(resultTwo.sideEffects.externalRequestAttempted).toBe(0);
    expect(resultTwo.sideEffectsVerification).toBe("runtime_measured");
  });
});

/* ────────────────────────────────────────────────────────────────
 * 继承自上一轮的验收点（回归）
 * ──────────────────────────────────────────────────────────────── */

describe("继承验收（回归）", () => {
  it("A1 叙述分层：无引用者降级为未验证假设", () => {
    const input = buildJevReadinessInput(portA());
    expect(input.verifiedNarratives).toHaveLength(1);
    expect(input.unverifiedNarratives).toHaveLength(1);
  });

  it("A2 无研报样本：输入不可用显式呈现", () => {
    const input = buildJevReadinessInput(portB());
    expect(input.binding.reportHash).toBeNull();
    expect(input.decisionSummary).toBeNull();
    expect(input.verifiedNarratives).toEqual([]);
  });

  it("B1 import/fetch 静态安全", () => {
    const files = ["types.ts", "schema.ts", "inputAdapter.ts", "offlineProvider.ts", "runner.ts"];
    const forbidden = ["deepseek", "v5researchservice", "prisma", "api.typesafe.ai", "openai", "@anthropic", "sellersprite"];
    const stripComments = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "");
    for (const file of files) {
      const code = stripComments(readFileSync(path.join(process.cwd(), "lib/decision/readiness", file), "utf8"));
      const imports = (code.match(/from\s*["'][^"']+["']|require\s*\(\s*["'][^"']+["']\s*\)/g) ?? []).join(" ").toLowerCase();
      for (const token of forbidden) expect(imports.includes(token)).toBe(false);
      expect(code.includes("fetch(")).toBe(false);
    }
  });

  it("B2 网络守卫：零外部请求", async () => {
    const guard = createNetworkGuard();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = guard.fetchImpl as unknown as typeof globalThis.fetch;
    try {
      const cache = createReadinessCache();
      const provider = createOfflineAdviceProvider("ok");
      for (const port of [portA(), portB(), portC()]) {
        await cache.run({ input: buildJevReadinessInput(port), provider, requestTracker: createScopedRequestTracker().tracker });
      }
      expect(guard.attempted()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("C-4 四元组任一变化即 stale（不使用 TTL）", () => {
    const base = { reportHash: "a", factHash: "b", evidenceHash: "c", researchRevision: 1 };
    expect(isAdviceStale(base, { ...base })).toBe(false);
    expect(isAdviceStale(base, { ...base, reportHash: "a2" })).toBe(true);
    expect(isAdviceStale(base, { ...base, factHash: "b2" })).toBe(true);
    expect(isAdviceStale(base, { ...base, evidenceHash: "c2" })).toBe(true);
    expect(isAdviceStale(base, { ...base, researchRevision: 2 })).toBe(true);
    expect(bindingKey(base)).toBe("a|b|c|1");
  });

  it("D 故障矩阵：9 类异常全部明确 failed/unavailable，无降级为桩成功", async () => {
    const input = buildJevReadinessInput(portA());
    const expectations: Array<[OfflineScenario, "failed" | "unavailable"]> = [
      ["unconfigured", "unavailable"],
      ["timeout", "failed"],
      ["http429", "failed"],
      ["http500", "failed"],
      ["malformedJson", "failed"],
      ["unknownEnum", "failed"],
      ["invalidRefs", "failed"],
      ["forbiddenScoreField", "failed"],
      ["bindingMismatch", "failed"],
    ];
    for (const [scenario, expected] of expectations) {
      const result = await runReadinessAdvisory({ input, provider: createOfflineAdviceProvider(scenario) });
      expect(result.status, scenario).toBe(expected);
    }
  });

  it("S 三个真实样本端到端（离线桩，仅证明接线与安全规则）", async () => {
    const provider = createOfflineAdviceProvider("ok");
    const a = await runReadinessAdvisory({ input: buildJevReadinessInput(portA()), provider, requestTracker: createScopedRequestTracker().tracker });
    expect(a.status).toBe("available");
    expect(a.advice?.readiness).toBe("NEED_MORE_EVIDENCE");
    expect(a.advice?.missingEvidence).toContain("大类/细分 BSR 排名");

    const b = await runReadinessAdvisory({ input: buildJevReadinessInput(portB()), provider, requestTracker: createScopedRequestTracker().tracker });
    expect(b.advice?.readiness).toBe("NEED_MORE_EVIDENCE");

    const c = await runReadinessAdvisory({ input: buildJevReadinessInput(portC()), provider, requestTracker: createScopedRequestTracker().tracker });
    expect(c.advice?.readiness).toBe("NEED_MORE_EVIDENCE");
  });

  it("语义支撑始终 NOT_VERIFIED，矛盾检测在桩中显式留空", async () => {
    const input = buildJevReadinessInput(portA());
    const result = await runReadinessAdvisory({ input, provider: createOfflineAdviceProvider("ok"), requestTracker: createScopedRequestTracker().tracker });
    expect(result.semanticSupport).toBe("NOT_VERIFIED");
    expect(result.advice?.contradictions).toEqual([]);
    expect(result.advice?.limitations.join(" ")).toContain("NOT_VERIFIED");
  });
});
