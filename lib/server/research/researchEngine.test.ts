import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ProductFact, ProductFactKeyword } from "@/lib/sourceLayer/fact/types";
import type { ResearchEngineInput, ResearchEvidenceRef } from "@/lib/research/researchContracts";
import { runResearchEngine } from "./researchEngine";

const capturedAt = "2026-09-19T00:00:00.000Z";
const proofHash = "a".repeat(64);

function factField<T>(value: T | null) {
  return {
    value,
    status: value === null ? "missing" as const : "present" as const,
    source: "sellersprite_plugin" as const,
    confidence: value === null ? 0 : 1,
    capturedAt,
    rawProofHash: proofHash,
  };
}

function fixtureFact(): ProductFact {
  return {
    schema: "product-fact.v3",
    subjectKey: "amazon:US:B0TEST0001",
    sourceProof: {
      source: "sellersprite_plugin",
      captureId: "cap-1",
      evidenceId: "ev-cap-1-abcdef1234567890",
      subjectKey: "amazon:US:B0TEST0001",
      capturedAt,
      contentHash: proofHash,
      sourceUrl: "https://www.amazon.com/dp/B0TEST0001",
      operator: "owner:v1",
    },
    basic: {
      asin: factField("B0TEST0001"),
      title: factField("事实商品标题"),
      image: factField("https://images.example.test/product.jpg"),
      brand: factField("事实品牌"),
      category: factField("Kitchen"),
      price: factField({ amount: 19.99, currency: "USD" }),
      rating: factField(4.4),
      reviewCount: factField(1200),
      bulletPoints: factField(null),
    },
    market: {
      bsr: factField(1234),
      monthlySalesEstimate: factField(100),
      monthlyRevenueEstimate: factField({ amount: 1999, currency: "USD" }),
      launchedDate: factField(null),
    },
    profit: {
      packageWeight: factField(null),
      packageDimensions: factField(null),
      fbaFee: factField({ amount: 5, currency: "USD" }),
    },
  };
}

function fixtureInput(): ResearchEngineInput {
  const productFact = fixtureFact();
  return {
    schema: "research-engine-input.v1",
    taskId: "task-1",
    candidateId: "candidate-1",
    runId: "research-v1-run-1",
    productFact,
    sourceEvidenceRefs: [{
      refId: "evidence:ev-cap-1-abcdef1234567890",
      source: "sellersprite_plugin",
      captureId: "cap-1",
      evidenceId: productFact.sourceProof.evidenceId,
      subjectKey: productFact.subjectKey,
      capturedAt,
      contentHash: proofHash,
      sourceUrl: productFact.sourceProof.sourceUrl,
    }],
    researchConfig: {
      locale: "zh-CN",
      focus: ["market", "competition", "voc", "differentiation"],
      maxTokens: 1200,
      timeoutMs: 10000,
    },
  };
}

describe("P5 canonical voice citation bridge", () => {
  it("retains provider JSON, input and exact citation decisions in the normal engine audit boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "p5-audit-"));
    const input = voiceInput();
    const bundle = JSON.parse(JSON.stringify(input.researchInputBundle));
    bundle.sourceEvidenceRefs.push({ ...bundle.sourceEvidenceRefs[1], refId: "attachment:foreign", attachmentId: "foreign", subjectKey: "other-product" });
    bundle.sourceEvidenceRefs.push({ ...bundle.sourceEvidenceRefs[1], refId: "attachment:old", attachmentId: "old", version: 0 });
    const raw = { competitionInsight: { causalInvestigations: [{ hypothesis: "可能是材料原因", rationale: "现象不能证明材料",
      supportingEvidence: [{ text: "现象", evidenceRefs: ["attachment:voice", "attachment:missing", "attachment:foreign", "attachment:old"] }],
      counterevidence: [{ text: "替代解释", evidenceRefs: ["attachment:review"] }], unknowns: "缺少材料测量", verification: "拆解测量", confidence: "high",
    }, { hypothesis: "另一个待验证原因", supportingEvidence: [], counterevidence: [{ text: "反证", evidenceRefs: ["attachment:review"] }], unknowns: ["无支持"], verification: ["补证"] }] } };
    const generation = await runResearchEngine({ ...input, researchInputBundle: bundle }, { auditDirectory: root,
      synthesisInvoker: async ({ onProviderResponse }) => {
        onProviderResponse?.({ id: "offline-response-1", model: "deepseek-flash", api_key: "synthetic-test-key",
          choices: [{ message: { content: JSON.stringify(raw) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        return { ok: true, data: raw, errorCode: null, providerCallStarted: true,
          diagnostics: { model: "deepseek-flash", requestedModel: "deepseek-flash", promptTokens: 100, completionTokens: 20, totalTokens: 120,
            thinkingMode: "disabled", maxTokens: 4000, providerHttpStatusClass: "success", finishReason: "stop", reasoningTokens: 0,
            responseCharLength: JSON.stringify(raw).length, jsonParseStage: "passed", elapsedMs: 1 } };
      } });
    expect(generation.report.audit?.status).toBe("complete");
    expect(generation.report.audit?.redacted).toBe(true);
    const directory = join(root, generation.report.audit!.artifactId);
    const read = (file: string) => JSON.parse(readFileSync(join(directory, `${file}.json`), "utf8"));
    expect(read("provider").rawDraft).toEqual(raw);
    expect(readFileSync(join(directory, "provider.json"), "utf8")).not.toContain("sk-synthetic");
    expect(read("input").snapshot.allowedEvidenceRefs).toContain("attachment:voice");
    expect(read("manifest").reportHash).toBe(generation.reportHash);
    expect(read("parsing").citations.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining([
      "REF_ACCEPTED", "REF_UNKNOWN", "REF_SUBJECT_MISMATCH", "REF_VERSION_MISMATCH",
    ]));
    expect(read("parsing").causes[1].codes).toContain("NO_LEGAL_SUPPORT");
    expect(read("parsing").causes[0].codes).toContain("STRING_NORMALIZED_TO_LIST");
    expect(generation.report.competitionInsight.causalInvestigations).toHaveLength(2);
    expect(read("outcome").cost.actualBilledCny).toBeNull();
  });
  // 2026-10-29：模型确实给了内容、但形状不在已支持范围内时，解析器会丢弃它。
  // 丢弃可以接受，静默丢弃不行——必须在解析审计里留下可追踪的异常码。
  it("非空但形状不认识的字段必须留下 UNRECOGNIZED_SHAPE_DROPPED，而不是静默丢弃", async () => {
    const root = mkdtempSync(join(tmpdir(), "p5-audit-shape-"));
    const raw = { competitionInsight: { causalInvestigations: [{
      hypothesis: "可能是材料原因",
      rationale: "现象不能证明材料",
      supportingEvidence: [{ text: "现象", evidenceRefs: ["attachment:voice"] }],
      counterevidence: [],
      unknowns: { notes: ["缺少材料测量"] },
      verification: { steps: ["拆解测量", "对照试验"] },
      confidence: "low",
    }] } };
    const generation = await runResearchEngine(voiceInput(), { auditDirectory: root,
      synthesisInvoker: async () => ({ ok: true, data: raw, errorCode: null, providerCallStarted: false }) });
    const directory = join(root, generation.report.audit!.artifactId);
    const parsing = JSON.parse(readFileSync(join(directory, "parsing.json"), "utf8"));
    const cause = parsing.causes[0];
    expect(cause.codes).toContain("UNRECOGNIZED_SHAPE_DROPPED");
    // 原始值必须留在审计里，便于人工判断模型到底给了什么。
    expect(cause.fields.find((field: { field: string }) => field.field === "verification").original)
      .toEqual({ steps: ["拆解测量", "对照试验"] });
    // 丢弃不等于把内容当结论：无法解析的验证动作不会变成已核实结论。
    expect(generation.report.competitionInsight.causalInvestigations![0].verification).toEqual([]);
  });

  // 数组非空 ≠ 没丢东西：["A", {text:"B"}, {steps:["C"]}] 会保留 A、B 并丢掉 C，
  // 只看「最终数组是否为空」是发现不了的。这里锁死元素级诊断。
  it("数组里个别元素形状不支持时，必须记录 PARTIAL_ELEMENTS_DROPPED 并保留原文", async () => {
    const root = mkdtempSync(join(tmpdir(), "p5-audit-partial-"));
    const raw = { competitionInsight: { causalInvestigations: [{
      hypothesis: "可能是材料原因",
      supportingEvidence: [{ text: "现象", evidenceRefs: ["attachment:voice"] }],
      counterevidence: [],
      unknowns: ["缺少材料测量"],
      verification: ["验证动作 A", { text: "验证动作 B" }, { steps: ["验证动作 C"] }],
      confidence: "low",
    }] } };
    const generation = await runResearchEngine(voiceInput(), { auditDirectory: root,
      synthesisInvoker: async () => ({ ok: true, data: raw, errorCode: null, providerCallStarted: false }) });
    const directory = join(root, generation.report.audit!.artifactId);
    const parsing = JSON.parse(readFileSync(join(directory, "parsing.json"), "utf8"));
    const cause = parsing.causes[0];
    expect(cause.codes).toContain("PARTIAL_ELEMENTS_DROPPED");
    const field = cause.fields.find((item: { field: string }) => item.field === "verification");
    expect(field.code).toBe("PARTIAL_ELEMENTS_DROPPED");
    // 不凭空补造 C，但必须把丢掉的那一项原样留在审计里。
    expect(field.droppedElements).toEqual([{ index: 2, value: { steps: ["验证动作 C"] } }]);
    // 支持的两项照常保留，顺序不变。
    expect(generation.report.competitionInsight.causalInvestigations![0].verification)
      .toEqual(["验证动作 A", "验证动作 B"]);
  });

  // 2026-10-29 #5：bundle.sourceEvidenceRefs 里有同商品同版本、但正文未进输入、
  // 也不在白名单的附件。模型看到 refId 就照着引，产生 2 处 REF_NOT_ALLOWED。
  // 「能读取 ≠ 有权引用」：模型可见投影只保留可引用 refs，并显式告知省略了几条。
  it("模型可见投影不得暴露不可引用的 refs（含显式省略计数）", async () => {
    const input = voiceInput();
    const bundle = JSON.parse(JSON.stringify(input.researchInputBundle));
    // 取一条 attachment 形状的 ref 复制一份，改成不在 input.sourceEvidenceRefs 里的身份，
    // 模拟 #5 的 att-ba4ed1eb：同商品同版本、在 bundle 版本清单里，但不在可引用白名单。
    const template = bundle.sourceEvidenceRefs.find((ref: { kind: string }) => ref.kind === "attachment");
    const notCitable = { ...template, refId: "attachment:not-citable", attachmentId: "not-citable" };
    bundle.sourceEvidenceRefs.push(notCitable);
    expect(input.sourceEvidenceRefs.some((ref) => ref.refId === "attachment:not-citable")).toBe(false);

    let user = "";
    await runResearchEngine({ ...input, researchInputBundle: bundle }, {
      synthesisInvoker: async (request) => { user = request.user; throw new Error("CAPTURE_ONLY"); },
    }).catch(() => null);

    const sent = JSON.parse(user) as {
      allowedEvidenceRefs?: string[]; nonCitableEvidenceRefs?: string[];
      researchInputBundle?: { sourceEvidenceRefs?: { refId: string }[]; nonCitableSourceRefsOmitted?: number };
    };
    // 不可引用：既不在可引用清单，也不在 bundle 版本清单（不再邀请模型去引）。
    expect(sent.allowedEvidenceRefs ?? []).not.toContain("attachment:not-citable");
    expect((sent.researchInputBundle?.sourceEvidenceRefs ?? []).map((ref) => ref.refId))
      .not.toContain("attachment:not-citable");
    // 但必须**显式**告知它不可引用，并给出省略数量，而不是静默消失。
    expect(sent.nonCitableEvidenceRefs ?? []).toContain("attachment:not-citable");
    expect(sent.researchInputBundle?.nonCitableSourceRefsOmitted).toBe(1);
    // 可引用 refs 必须原样保留，不能连带删掉。
    expect(sent.allowedEvidenceRefs ?? []).toContain("attachment:voice");
  });

  it("reports failed audit storage explicitly without discarding the report", async () => {
    const root = mkdtempSync(join(tmpdir(), "p5-audit-fail-"));
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "blocked");
    const result = await runResearchEngine(fixtureInput(), { auditDirectory: blocked,
      synthesisInvoker: async () => ({ ok: true, data: {}, errorCode: null, providerCallStarted: false }) });
    expect(result.report.generationStatus).toBe("degraded");
    expect(result.aiProviderCallStarted).toBe(false);
    expect(result.report.audit).toMatchObject({ status: "incomplete", errorCode: "AUDIT_STORAGE_UNAVAILABLE" });
  });
  it("keeps analysis but marks a post-response audit write failure incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "p5-audit-after-response-"));
    const input = fixtureInput();
    const artifactId = createHash("sha256").update(`${input.taskId}\n${input.runId}`).digest("hex");
    const result = await runResearchEngine(input, { auditDirectory: root, synthesisInvoker: async ({ onProviderResponse }) => {
      const data = { executiveSummary: { analysis: { text: "离线有来源分析", evidenceRefs: [input.sourceEvidenceRefs[0]!.refId] } } };
      onProviderResponse?.({ id: "offline-late-failure", choices: [{ message: { content: JSON.stringify(data) } }] });
      writeFileSync(join(root, artifactId, "parsing.json"), "existing file must not be overwritten");
      return { ok: true, data, errorCode: null, providerCallStarted: true };
    } });
    expect(result.report.executiveSummary.analysis.text).toBe("离线有来源分析");
    expect(result.report.audit).toMatchObject({ status: "incomplete", errorCode: "AUDIT_WRITE_FAILED" });
  });
  it("keeps support and counter refs scoped to each causal row", async () => {
    const base = fixtureInput();
    const first = base.sourceEvidenceRefs[0]!;
    const second = { ...first, refId: "attachment:second-support", contentHash: "d".repeat(64) };
    const result = await runResearchEngine({ ...base, sourceEvidenceRefs: [first, second] }, {
      synthesisInvoker: async () => ({ ok: true, errorCode: null, providerCallStarted: false,
        data: { competitionInsight: { causalInvestigations: [first, second].map((support, index) => ({
          hypothesis: `待验证原因${index}`, supportingEvidence: [{ text: "触发现象", evidenceRefs: [support.refId] }],
          counterevidence: [{ text: "不同解释", evidenceRefs: [index ? first.refId : second.refId] }],
          unknowns: ["原因未知"], verification: ["对照测量"], confidence: "high",
        })) } } }),
    });
    const causes = result.report.competitionInsight.causalInvestigations!;
    expect(causes[0]!.hypothesis.evidenceRefs.map((r) => r.refId)).toEqual([first.refId]);
    expect(causes[1]!.hypothesis.evidenceRefs.map((r) => r.refId)).toEqual([second.refId]);
    expect(causes.every((c) => c.hypothesis.semanticReview?.status === "hypothesis" && c.confidence === "low")).toBe(true);
  });
  it("never turns counterevidence into support or a verified engineering cause", async () => {
    const input = fixtureInput();
    const ref = input.sourceEvidenceRefs[0]!.refId;
    const result = await runResearchEngine(input, { synthesisInvoker: async () => ({ ok: true, providerCallStarted: false,
      errorCode: null, data: { competitionInsight: { causalInvestigations: [{
        hypothesis: "制造商使用低质量塑料造成松动", rationale: "评论反馈松动，材料原因尚未证明",
        supportingEvidence: [], counterevidence: [{ text: "其他买家没有遇到松动", evidenceRefs: [ref] }],
        unknowns: ["材料配方未知"], verification: "拆解并测量连接公差", confidence: "high",
      }] } } }) });
    const cause = result.report.competitionInsight.causalInvestigations![0]!;
    expect(cause.hypothesis.text).toContain("低质量塑料");
    expect(cause.hypothesis.evidenceRefs).toEqual([]);
    expect(cause.hypothesis.semanticReview?.status).toBe("hypothesis");
    expect(cause.supportingEvidence).toEqual([]);
    expect(cause.counterevidence).toHaveLength(1);
    expect(cause.confidence).toBe("unknown");
  });
  function voiceInput(): ResearchEngineInput {
    const input = fixtureInput();
    const proof = input.sourceEvidenceRefs[0]!;
    const voice = { ...proof, refId: "attachment:voice", contentHash: "b".repeat(64) };
    const source = { ...proof, refId: "attachment:review", contentHash: "c".repeat(64) };
    return {
      ...input,
      sourceEvidenceRefs: [proof, voice, source],
      researchInputBundle: {
        schemaVersion: "research-input-bundle.v1", taskId: input.taskId, candidateId: input.candidateId,
        subjectKey: proof.subjectKey, productFact: input.productFact,
        sourceEvidenceRefs: [proof, voice, source].map((ref, index) => ({
          ...ref, version: 1, kind: index === 0 ? "product_evidence" : "attachment",
          ...(index ? { attachmentId: ref.refId.slice(11) } : {}),
        })),
        reviewEvidence: [], keywordEvidence: [], trendObservations: [],
        customerVoiceEvidence: [{ attachmentId: "voice", contentHash: voice.contentHash,
          observations: [{ refId: voice.refId, evidenceRefs: [source.refId],
            provenance: { sourceAttachmentId: "review" } }] }],
      } as never,
    };
  }
  const invoke = (input: ResearchEngineInput, supporting: string[], counter: string[]) => runResearchEngine(input, {
    synthesisInvoker: async ({ user }) => {
      const payload = JSON.parse(user);
      expect(payload.allowedEvidenceRefs).toContain("attachment:voice");
      return { ok: true, errorCode: null, providerCallStarted: false, data: { competitionInsight: { causalInvestigations: [{
        hypothesis: "待验证的原因", rationale: "观察与假设有关，但尚未证明因果",
        supportingEvidence: [{ text: "支持观察", evidenceRefs: supporting }],
        counterevidence: [{ text: "替代解释", evidenceRefs: counter }],
        unknowns: "缺少对照样品", verification: "同条件测试两个样品", confidence: "low",
      }] } } };
    },
  });
  it("retains canonical support and bound source counterevidence without duplicating samples", async () => {
    const result = await invoke(voiceInput(), ["attachment:voice"], ["attachment:review"]);
    const item = result.report.competitionInsight.causalInvestigations![0]!;
    expect(item.hypothesis.text).toBe("待验证的原因");
    expect(item.supportingEvidence).toHaveLength(1);
    expect(item.counterevidence).toHaveLength(1);
    expect(item.unknowns).toEqual(["缺少对照样品"]);
    expect(item.verification).toEqual(["同条件测试两个样品"]);
    expect(item.confidence).toBe("low");
  });
  it("rejects a hash alias absent from the exact whitelist sent to the model", async () => {
    const input = voiceInput();
    const undeclaredAlias = `attachment:${input.sourceEvidenceRefs[1]!.contentHash}`;
    const result = await invoke(input, ["attachment:voice"], [undeclaredAlias]);
    expect(result.report.competitionInsight.causalInvestigations![0]!.counterevidence).toEqual([]);
  });
  it.each(["attachment:nonexistent", "attachment:foreign-task", "attachment:old-version", "attachment:forged"])(
    "rejects unbound counterevidence %s and never manufactures replacement evidence", async (invalid) => {
      const result = await invoke(voiceInput(), ["attachment:voice"], [invalid]);
      expect(result.report.competitionInsight.causalInvestigations![0]!.counterevidence).toEqual([]);
    });
  it("downgrades an entirely unbound hypothesis", async () => {
    const result = await invoke(voiceInput(), ["attachment:missing"], ["attachment:foreign"]);
    const item = result.report.competitionInsight.causalInvestigations![0]!;
    expect(item.hypothesis.text).toBeNull();
    expect(item.confidence).toBe("unknown");
  });
  it.each(["subjectKey", "contentHash", "capturedAt", "captureId", "evidenceId", "version"])(
    "fails closed when the Bundle attachment %s does not bind to the trusted input", async (field) => {
      const input = voiceInput();
      const bundle = JSON.parse(JSON.stringify(input.researchInputBundle));
      bundle.sourceEvidenceRefs[1][field] = field === "version" ? 2 : "foreign-or-stale";
      await expect(invoke({ ...input, researchInputBundle: bundle }, [], [])).rejects.toThrow("RESEARCH_EVIDENCE_REF_INVALID");
    });
  it("rejects a Bundle for another task", async () => {
    const input = voiceInput();
    await expect(invoke({ ...input, researchInputBundle: { ...input.researchInputBundle!, taskId: "other-task" } }, [], []))
      .rejects.toThrow("RESEARCH_EVIDENCE_REF_INVALID");
  });
});

describe("Active Research Layer V1 engine", () => {
  it("保留逐原因的支持与反证，越界引用不会进入正式证据", async () => {
    const ref = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), { synthesisInvoker: vi.fn().mockResolvedValue({ ok: true, providerCallStarted: false, errorCode: null, data: { competitionInsight: { causalInvestigations: [
      { hypothesis: { text: "结构可能造成难清洗", evidenceRefs: [] }, supportingEvidence: [{ text: "已有线索", evidenceRefs: [ref] }], counterevidence: [{ text: "反例", evidenceRefs: [ref] }], unknowns: ["未知清洁方式"], confidence: "low", verification: ["对照不同清洗方法"] },
      { hypothesis: { text: "使用方式可能造成难清洗", evidenceRefs: [] }, supportingEvidence: [{ text: "越界线索", evidenceRefs: ["evidence:wrong"] }], counterevidence: [], unknowns: ["缺少证据"], confidence: "invalid", verification: [] },
    ] } } }) });
    const items = result.report.competitionInsight.causalInvestigations!;
    expect(items).toHaveLength(2);
    expect(items[0].supportingEvidence[0].evidenceRefs[0].refId).toBe(ref);
    expect(items[0].counterevidence[0].text).toBe("反例");
    expect(items[1].supportingEvidence).toEqual([]);
    expect(items[1].confidence).toBe("unknown");
    expect(result.report.unverifiedAssumptions?.some((item) => item.text === "越界线索")).toBe(true);
    expect(result.report.citationIndex.some((item) => item.fieldPath === "analysis.competitionInsight.causalInvestigations[0].counterevidence[0]")).toBe(true);
  });
  it("P2-02：无证据的原因假设不得作为研究结论，保留未知并压低可信度", async () => {
    const ref = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), { synthesisInvoker: vi.fn().mockResolvedValue({ ok: true, providerCallStarted: false, errorCode: null, data: { competitionInsight: { causalInvestigations: [
      { hypothesis: { text: "结构可能造成难清洗", evidenceRefs: [] }, rationale: { text: "观察到边角残留", evidenceRefs: [ref] }, supportingEvidence: [{ text: "已有线索", evidenceRefs: [ref] }], counterevidence: [], unknowns: [], confidence: "high", verification: ["对照不同清洗方法"] },
      { hypothesis: { text: "使用方式可能造成难清洗", evidenceRefs: [] }, supportingEvidence: [], counterevidence: [], unknowns: [], confidence: "high", verification: [] },
    ] } } }) });
    const items = result.report.competitionInsight.causalInvestigations!;
    // 2026-10-29 契约修正（真实调用驱动）：模型把 hypothesis/rationale 写成纯文本、
    // 把合法引用挂在同一条原因的 supportingEvidence/counterevidence 上。旧契约要求
    // 假设字段自己重复挂引用，结果是真实报告里每条因果假设都被清空。
    // 现在按**条目级证据**绑定：只要该原因本身带可追溯引用，假设就成立；
    // 整条原因没有任何引用时仍然整条丢弃（下面第 2 条）。
    expect(items).toHaveLength(1);
    expect(items[0].hypothesis.text).toBe("结构可能造成难清洗");
    expect(items[0].hypothesis.evidenceRefs[0].refId).toBe(ref);
    expect(items[0].rationale?.evidenceRefs[0].refId).toBe(ref);
    expect(items[0].supportingEvidence[0].evidenceRefs[0].refId).toBe(ref);
    expect(result.report.unverifiedAssumptions?.some((item) => item.text === "结构可能造成难清洗")).toBe(false);
    expect(result.report.citationIndex.some((item) => item.fieldPath === "analysis.competitionInsight.causalInvestigations[0].rationale")).toBe(true);
  });

  // 2026-10-29 真实调用驱动的两条回归（真实 DeepSeek 输出里暴露）：
  //  ① 模型把 hypothesis 写成纯文本、把合法引用挂在同一条原因的 supportingEvidence 上；
  //  ② 模型把 verification 写成单个字符串而不是数组。
  // 旧实现分别把它们降级成 null / 丢弃，导致真实报告「有原因没验证、有原因没依据」。
  it("P2-02：条目级证据可以绑定纯文本假设，但整条无引用时仍降级", async () => {
    const ref = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true, providerCallStarted: false, errorCode: null,
        data: {
          competitionInsight: {
            causalInvestigations: [
              { hypothesis: "薄规格是价格竞争力的代价", rationale: "评论提到 very thin", supportingEvidence: [{ text: "评论原文", evidenceRefs: [ref] }], counterevidence: [], unknowns: ["占比未知"], confidence: "low", verification: "抽 50 条评论统计" },
              { hypothesis: "凭空猜测的原因", supportingEvidence: [{ text: "编造的观察", evidenceRefs: [] }], counterevidence: [], unknowns: [], confidence: "high", verification: [] },
            ],
          },
        },
      }),
    });
    const items = result.report.competitionInsight.causalInvestigations!;
    expect(items).toHaveLength(1);
    expect(items[0].hypothesis.text).toBe("薄规格是价格竞争力的代价");
    expect(items[0].hypothesis.evidenceRefs[0].refId).toBe(ref);
    expect(items[0].confidence).toBe("low");
    // 无依据的那条整条不进正式结论，但原文保留在未验证区以便审计。
    expect(result.report.unverifiedAssumptions?.some((item) => item.text === "凭空猜测的原因")).toBe(true);
  });

  it("P2-02：verification 写成字符串时必须保留为一条验证动作", async () => {
    const ref = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true, providerCallStarted: false, errorCode: null,
        data: {
          competitionInsight: {
            causalInvestigations: [
              { hypothesis: { text: "假设", evidenceRefs: [ref] }, supportingEvidence: [], counterevidence: [], unknowns: "样本有限", confidence: "low", verification: "抽 100 条评论统计抱怨率；若低于 5% 则不成立" },
            ],
          },
        },
      }),
    });
    const item = result.report.competitionInsight.causalInvestigations![0];
    expect(item.verification).toHaveLength(1);
    expect(item.verification[0]).toContain("低于 5%");
    expect(item.unknowns).toContain("样本有限");
  });

  // 2026-10-29 真实调用（12,000 输出预算）暴露：同一字段在不同采样下会以
  // string / string[] / {text} / {text}[] 出现。旧实现只认前两种，导致模型明明写了
  // 验证动作，报告里却 verification=0（付费拿到了内容又被解析丢掉）。
  it("P2-02：verification / unknowns 写成 {text} 对象或对象数组时也必须保留", async () => {
    const ref = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true, providerCallStarted: false, errorCode: null,
        data: {
          competitionInsight: {
            causalInvestigations: [
              {
                hypothesis: { text: "厚度披露不足", evidenceRefs: [ref] },
                supportingEvidence: [], counterevidence: [],
                unknowns: { text: "缺少批次质检数据" },
                confidence: "low",
                verification: { text: "同批次抽测 30 片，若超差率低于阈值则关闭该假设" },
              },
              {
                hypothesis: { text: "裁切公差", evidenceRefs: [ref] },
                supportingEvidence: [], counterevidence: [],
                unknowns: [{ text: "缺供应商公差说明" }, "缺少退货原因"],
                confidence: "unknown",
                verification: [{ text: "对比开箱即测与静置后测" }, "记录超差率"],
              },
            ],
          },
        },
      }),
    });
    const [first, second] = result.report.competitionInsight.causalInvestigations!;
    expect(first.verification).toHaveLength(1);
    expect(first.verification[0]).toContain("超差率");
    expect(first.unknowns).toContain("缺少批次质检数据");
    expect(second.verification).toHaveLength(2);
    expect(second.verification[0]).toContain("静置后测");
    expect(second.unknowns).toContain("缺供应商公差说明");
    expect(second.unknowns).toContain("缺少退货原因");
  });

  it("P5-04：报告 ai 字段落盘 usage 与模型，缺失时保持 null 不填 0", async () => {
    const withUsage = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true, data: {}, errorCode: null, providerCallStarted: true,
        diagnostics: { model: "deepseek-flash", requestedModel: "deepseek-flash", modelMismatch: false, promptTokens: 12345, completionTokens: 678, totalTokens: 13023, elapsedMs: 4321 },
      }),
    });
    expect(withUsage.report.ai).toMatchObject({
      provider: "deepseek",
      status: "completed",
      model: "deepseek-flash",
      requestedModel: "deepseek-flash",
      modelMismatch: false,
      usage: { promptTokens: 12345, completionTokens: 678, totalTokens: 13023, elapsedMs: 4321 },
    });

    const noUsage = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({ ok: true, data: {}, errorCode: null, providerCallStarted: true }),
    });
    expect(noUsage.report.ai.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null, elapsedMs: null });
    expect(noUsage.report.ai.model).toBeNull();
  });

  it("P5-04：模型名不符时报告保留 provider 实际模型并标记不一致", async () => {
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true, data: {}, errorCode: null, providerCallStarted: true,
        diagnostics: { model: "deepseek-chat", requestedModel: "deepseek-flash", modelMismatch: true, promptTokens: 10, completionTokens: 2, totalTokens: 12, elapsedMs: 100 },
      }),
    });
    expect(result.report.ai).toMatchObject({ model: "deepseek-chat", requestedModel: "deepseek-flash", modelMismatch: true });
  });

  it("keeps ProductFact detail and variation citations scoped to their bound attachment", async () => {
    const base = fixtureInput();
    const detailRef: ResearchEvidenceRef = {
      refId: "attachment:detail-1",
      source: "amazon_dom",
      captureId: "detail-1",
      evidenceId: "detail-1",
      subjectKey: base.productFact.subjectKey,
      capturedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "d".repeat(64),
      sourceUrl: "https://www.amazon.com/dp/B0TEST0001",
    };
    const variationRef: ResearchEvidenceRef = {
      ...detailRef,
      refId: "attachment:variation-1",
      captureId: "variation-1",
      evidenceId: "variation-1",
      capturedAt: "2026-10-03T00:00:00.000Z",
      contentHash: "e".repeat(64),
    };
    const productFact = {
      ...base.productFact,
      basic: {
        ...base.productFact.basic,
        brand: {
          ...base.productFact.basic.brand,
          source: "amazon_dom" as const,
          evidenceRefs: [detailRef],
        },
      },
      extended: {
        variationStructure: {
          schemaVersion: "product-fact-variation-structure.v1",
          subjectKey: base.productFact.subjectKey,
          subjectAsin: "B0TEST0001",
          outcome: "complete",
          completeness: "complete",
          parentAsin: "B0PARENT01",
          memberAsins: ["B0TEST0001", "B0CHILD002"],
          members: [],
          relations: [],
          evidenceRefs: [variationRef],
          limitation: null,
        },
      },
    } as unknown as ProductFact;
    const input: ResearchEngineInput = {
      ...base,
      productFact,
      sourceEvidenceRefs: [...base.sourceEvidenceRefs, detailRef, variationRef],
    };

    const result = await runResearchEngine(input, {
      synthesisInvoker: vi.fn().mockResolvedValue({ ok: false, data: null, errorCode: "offline", providerCallStarted: false }),
    });

    expect(result.report.facts.basic.brand.evidenceRefs.map((ref) => ref.refId)).toEqual([detailRef.refId]);
    expect(result.report.facts.extended?.variationStructure).toMatchObject({
      status: "present",
      value: expect.objectContaining({ parentAsin: "B0PARENT01" }),
      evidenceRefs: [expect.objectContaining({ refId: variationRef.refId })],
    });
  });

  it("does not authorize a ProductFact attachment whose subject differs from the fact", async () => {
    const base = fixtureInput();
    const foreignSubjectKey = "amazon:US:B0OTHER0001";
    const foreignRef: ResearchEvidenceRef = {
      refId: "attachment:foreign-subject-detail",
      source: "amazon_dom",
      captureId: "foreign-detail-1",
      evidenceId: "foreign-detail-1",
      subjectKey: foreignSubjectKey,
      capturedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "f".repeat(64),
      sourceUrl: "https://www.amazon.com/dp/B0OTHER0001",
    };
    const productFact = {
      ...base.productFact,
      basic: {
        ...base.productFact.basic,
        brand: {
          ...base.productFact.basic.brand,
          source: "amazon_dom" as const,
          evidenceRefs: [foreignRef],
        },
      },
    } as unknown as ProductFact;
    const input: ResearchEngineInput = {
      ...base,
      productFact,
      researchInputBundle: {
        schemaVersion: "research-input-bundle.v1",
        taskId: base.taskId,
        candidateId: base.candidateId,
        subjectKey: base.productFact.subjectKey,
        productFact,
        sourceEvidenceRefs: [
          {
            refId: base.sourceEvidenceRefs[0]!.refId,
            kind: "product_evidence",
            subjectKey: base.productFact.subjectKey,
            evidenceId: base.productFact.sourceProof.evidenceId,
            captureId: base.productFact.sourceProof.captureId,
            version: 1,
            contentHash: base.productFact.sourceProof.contentHash,
            capturedAt: base.productFact.sourceProof.capturedAt,
          },
          {
            refId: foreignRef.refId,
            kind: "attachment",
            subjectKey: foreignSubjectKey,
            evidenceId: foreignRef.evidenceId,
            captureId: foreignRef.captureId,
            version: 1,
            contentHash: foreignRef.contentHash,
            capturedAt: foreignRef.capturedAt,
            attachmentId: "foreign-subject-detail",
          },
        ],
        keywordEvidence: [],
        reviewEvidence: [],
        trendObservations: [],
        missingFields: [],
        conflicts: [],
        freshness: { latestCapturedAt: capturedAt, ageDays: 0 },
        traceId: null,
      },
    };
    const invoker = vi.fn().mockResolvedValue({
      ok: false,
      data: null,
      errorCode: "offline",
      providerCallStarted: false,
    });

    await runResearchEngine(input, { synthesisInvoker: invoker });

    expect(invoker).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(invoker.mock.calls[0]?.[0]?.user ?? "{}") as {
      allowedEvidenceRefs?: string[];
      researchInputBundle?: { productFact?: unknown };
    };
    expect(payload.allowedEvidenceRefs).toBeDefined();
    expect(payload.allowedEvidenceRefs).not.toContain(foreignRef.refId);
    expect(payload.allowedEvidenceRefs).not.toContain(`attachment:${foreignRef.contentHash}`);
    expect(payload.researchInputBundle?.productFact).toBeUndefined();
  });

  it("只使用 ProductFact，单次调用 synthesize_research，且不猜利润", async () => {
    const invoker = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        executiveSummary: {
          analysis: { text: "基于已有事实的市场摘要。", evidenceRefs: ["evidence:ev-cap-1-abcdef1234567890"] },
          keyPoints: [{ text: "已引用商品事实。", evidenceRefs: ["evidence:ev-cap-1-abcdef1234567890"] }],
        },
        competitionInsight: {
          analysis: { text: "竞争分析。", evidenceRefs: ["evidence:ev-cap-1-abcdef1234567890"] },
          differentiationSuggestions: [{ text: "建议人工验证差异化。", evidenceRefs: [] }],
        },
        facts: {
          basic: { price: { value: { amount: 9999, currency: "USD" }, evidenceRefs: [] } },
          market: { monthlySalesEstimate: { value: 999999, evidenceRefs: [] } },
        },
      },
      errorCode: null,
      providerCallStarted: true,
    });

    const result = await runResearchEngine(fixtureInput(), { synthesisInvoker: invoker });

    expect(invoker).toHaveBeenCalledTimes(1);
    const invocation = invoker.mock.calls[0]?.[0] as { system: string; user: string };
    expect(invocation.system).toContain("synthesize_research");
    expect(invocation.system).toContain("禁止猜销量、价格、成本、利润");
    expect(invocation.user).not.toContain("analysisJson");
    expect(result.report.schema).toBe("research-report.v1");
    expect(result.report.node).toBe("synthesize_research");
    expect(result.report.facts.basic.price.evidenceRefs[0]?.evidenceId).toBe("ev-cap-1-abcdef1234567890");
    expect(result.report.unitEconomics.deterministic.knownRevenueAfterFbaFee.value).toEqual({ amount: 14.99, currency: "USD" });
    expect(result.report.unitEconomics.deterministic.grossProfit.value).toBeNull();
    expect(result.report.unitEconomics.deterministic.grossProfit.reason).toContain("缺少成本数据");
    expect(result.report.competitionInsight.analysis.text).toBe("竞争分析。");
    expect(result.report.facts.basic.price.value).toEqual({ amount: 19.99, currency: "USD" });
    expect(result.report.facts.market.monthlySalesEstimate.value).toBe(100);
    expect(result.report.decisionSummary.researchPriority).toBe("P1");
    expect(result.report.decisionSummary.recommendedNextAction).toBe("补充数据");
    expect(result.report.decisionSummary.missingInformation).toContain("采购成本、头程物流与其他经营成本");
  });

  it("DeepSeek 不可用时保存降级报告，不创建 AI 事实", async () => {
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: false,
        data: null,
        errorCode: "missing_api_key",
        providerCallStarted: false,
      }),
    });

    expect(result.report.generationStatus).toBe("degraded");
    expect(result.report.ai.errorCode).toBe("missing_api_key");
    expect(result.report.marketOpportunity.analysis.text).toBeNull();
    expect(result.report.facts.market.monthlySalesEstimate.value).toBe(100);
  });

  it("JEV-002：无证据引用的 AI 文本被移出分析字段，只进入未验证假设区", async () => {
    const refId = "evidence:ev-cap-1-abcdef1234567890";
    const invoker = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        executiveSummary: {
          analysis: { text: "没有引用的销量结论：月销上万。", evidenceRefs: [] },
        },
        marketOpportunity: { analysis: "没有引用的字符串叙述，声称利润很高。" },
        competitionInsight: {
          analysis: { text: "有引用的竞争分析。", evidenceRefs: [refId] },
          differentiationSuggestions: [{ text: "无引用建议。", evidenceRefs: ["evidence:不存在"] }],
        },
      },
      errorCode: null,
      providerCallStarted: true,
    });

    const result = await runResearchEngine(fixtureInput(), { synthesisInvoker: invoker });

    // 无引用 → 分析字段被清空，不再作为结论
    expect(result.report.executiveSummary.analysis.text).toBeNull();
    expect(result.report.marketOpportunity.analysis.text).toBeNull();
    // 有引用 → 原样保留
    expect(result.report.competitionInsight.analysis.text).toBe("有引用的竞争分析。");
    expect(result.report.competitionInsight.analysis.evidenceRefs).toHaveLength(1);
    // 引用 ID 无法解析的列表项同样按未验证处理
    expect(result.report.competitionInsight.differentiationSuggestions).toEqual([]);

    const assumptions = result.report.unverifiedAssumptions ?? [];
    expect(assumptions.map((item) => item.text)).toEqual([
      "没有引用的销量结论：月销上万。",
      "没有引用的字符串叙述，声称利润很高。",
      "无引用建议。",
    ]);
    expect(assumptions.every((item) => item.evidenceRefs.length === 0)).toBe(true);

    // 未验证文本不得进入决策摘要（人工安排研究动作的依据）
    expect(result.report.decisionSummary.keyReasons).not.toContain("没有引用的销量结论：月销上万。");
    expect(result.report.decisionSummary.keyReasons).toContain("有引用的竞争分析。");
  });

  it("RESEARCH-002：citationIndex 同时覆盖事实字段与 AI 分析引用", async () => {
    const refId = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          executiveSummary: { analysis: { text: "有引用的摘要。", evidenceRefs: [refId] } },
          riskAssessment: { analysis: { text: "有引用的风险。", evidenceRefs: [refId] } },
        },
        errorCode: null,
        providerCallStarted: true,
      }),
    });

    const factEntries = result.report.citationIndex.filter((entry) => (entry.source ?? "fact") === "fact");
    const narrativeEntries = result.report.citationIndex.filter((entry) => entry.source === "narrative");

    expect(factEntries.length).toBeGreaterThan(0);
    expect(factEntries.every((entry) => entry.fieldPath.startsWith("facts."))).toBe(true);
    expect(narrativeEntries.map((entry) => entry.fieldPath)).toEqual([
      "analysis.executiveSummary",
      "analysis.riskAssessment",
    ]);
  });

  it("P2-04/P3-01-B：新版竞争性解释、备选、支持反证与验证事项保留证据绑定", async () => {
    const refId = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          competitionInsight: {
            analysis: { text: "竞争原因分析。", evidenceRefs: [refId] },
            causalHypotheses: [{ text: "竞品因包装限制而没有解决边缘防滑。", evidenceRefs: [refId] }],
            alternatives: [
              { text: "保留现状作为对照组。", evidenceRefs: [refId] },
              { text: "没有引用的备选，不得进入研究结论。", evidenceRefs: [] },
            ],
            supportingEvidence: [{ text: "评论反复提到边缘滑脱。", evidenceRefs: [refId] }],
            counterevidence: [{ text: "高温环境下防滑改良可能失效。", evidenceRefs: [refId] }],
            verificationItems: [{ text: "做两周对照测试，若滑脱率无改善则停止。", evidenceRefs: [refId] }],
            differentiationSuggestions: [],
          },
          riskAssessment: {
            analysis: { text: "风险分析。", evidenceRefs: [refId] },
            risks: [{ text: "改良结构可能增加包装体积。", evidenceRefs: [refId] }],
            verificationItems: [{ text: "核对包装体积与物流费，超过上限则暂停。", evidenceRefs: [refId] }],
          },
        },
        errorCode: null,
        providerCallStarted: true,
      }),
    });

    expect(result.report.competitionInsight.causalHypotheses?.map((item) => item.text)).toEqual(["竞品因包装限制而没有解决边缘防滑。"]);
    expect(result.report.competitionInsight.alternatives?.map((item) => item.text)).toEqual(["保留现状作为对照组。"]);
    expect(result.report.competitionInsight.supportingEvidence?.[0]?.evidenceRefs[0]?.refId).toBe(refId);
    expect(result.report.competitionInsight.counterevidence?.[0]?.text).toContain("高温环境");
    expect(result.report.competitionInsight.verificationItems?.[0]?.text).toContain("两周对照测试");
    expect(result.report.riskAssessment.verificationItems?.[0]?.text).toContain("包装体积");
    expect(result.report.unverifiedAssumptions?.some((item) => item.text?.includes("没有引用的备选"))).toBe(true);
    expect(result.report.citationIndex.map((entry) => entry.fieldPath)).toEqual(expect.arrayContaining([
      "analysis.competitionInsight.causalHypotheses[0]",
      "analysis.competitionInsight.alternatives[0]",
      "analysis.competitionInsight.supportingEvidence[0]",
      "analysis.competitionInsight.counterevidence[0]",
      "analysis.competitionInsight.verificationItems[0]",
      "analysis.riskAssessment.verificationItems[0]",
    ]));
  });

  it("bridges persisted Amazon detail extensions into Research facts and citationIndex", async () => {
    const refId = "evidence:ev-cap-1-abcdef1234567890";
    const estimate = {
      rawText: "1K+ bought in past month",
      lowerBound: 1000,
      upperBound: null,
      qualifier: "at_least",
      metricNature: "estimate",
    } as const;
    const detailField = <T,>(value: T, metricNature: "snapshot" | "estimate" | "derived" = "snapshot") => ({
      value,
      status: "present" as const,
      metricNature,
      source: "amazon_dom" as const,
      confidence: 1,
      capturedAt,
      rawProofHash: proofHash,
    });
    const productFact: ProductFact = {
      ...fixtureFact(),
      extended: {
        categoryPath: detailField(["Home", "Kitchen"]),
        parentAsin: detailField(null),
        material: detailField("Stainless Steel"),
        includedComponents: detailField(null),
        galleryImageUrls: detailField(["https://images.example.test/gallery.jpg"]),
        listPrice: detailField(null),
        coupon: detailField(null),
        seller: detailField("Amazon.com"),
        shipsFrom: detailField("Amazon.com"),
        fulfillment: detailField("amazon_fulfilled", "derived"),
        buyBox: detailField(null),
        ratingDistribution: detailField(null),
        boughtPastMonth: detailField(estimate, "estimate"),
        variations: detailField(null),
        bsrRanks: detailField([{ rank: 1234, category: "Kitchen" }, { rank: 7, category: "Cutting Boards" }]),
        itemDimensions: detailField({ length: 9, width: 4, height: 1, unit: "in" }),
        itemWeight: detailField({ value: 12, unit: "oz" }),
        amazonDetail: detailField({
          schemaVersion: "amazon-detail-registered-fields.v1",
          extractorVersion: "amazon-detail-extractor.v2",
          fieldRegistryVersion: "amazon-detail-field-registry.v1",
          primaryBsrProjectionVersion: "primary-bsr.v1",
          registeredFields: {
            boughtPastMonth: {
              canonicalField: "boughtPastMonth",
              priority: "P2",
              fieldNature: "ESTIMATED_METRIC",
              status: "observed",
              value: estimate,
              reason: null,
              sourceTrace: {
                ruleId: "boughtPastMonth",
                registryVersion: "amazon-detail-field-registry.v1",
                region: "primary_product_social_proof",
                selector: "#social-proofing-faceout",
                label: null,
                ruleVersion: null,
              },
            },
            fbaFee: {
              canonicalField: "fbaFee",
              priority: "BLOCKED",
              fieldNature: "BLOCKED",
              status: "blocked",
              value: null,
              reason: "field_contract_blocked",
              sourceTrace: {
                ruleId: "fbaFee",
                registryVersion: "amazon-detail-field-registry.v1",
                region: "blocked_no_source_contract",
                selector: null,
                label: null,
                ruleVersion: null,
              },
            },
          },
        }),
      },
    };
    const result = await runResearchEngine({ ...fixtureInput(), productFact }, {
      synthesisInvoker: vi.fn().mockResolvedValue({ ok: false, data: null, errorCode: "fixture", providerCallStarted: false }),
    });

    expect(result.report.facts.extended?.bsrRanks).toMatchObject({
      value: [{ rank: 1234, category: "Kitchen" }, { rank: 7, category: "Cutting Boards" }],
      evidenceRefs: [{ refId }],
    });
    expect(result.report.facts.extended?.boughtPastMonth).toMatchObject({
      value: estimate,
      status: "present",
      source: "amazon_dom",
      evidenceRefs: [{ refId }],
    });
    expect(result.report.facts.extended?.itemDimensions?.value).toEqual({ length: 9, width: 4, height: 1, unit: "in" });
    expect(result.report.facts.extended?.itemWeight?.value).toEqual({ value: 12, unit: "oz" });
    expect(result.report.facts.extended?.amazonDetail?.value).toMatchObject({ extractorVersion: "amazon-detail-extractor.v2" });
    for (const fieldPath of [
      "facts.extended.bsrRanks",
      "facts.extended.boughtPastMonth",
      "facts.extended.itemDimensions",
      "facts.extended.itemWeight",
      "facts.extended.amazonDetail",
    ]) {
      expect(result.report.citationIndex).toContainEqual({ fieldPath, source: "fact", evidenceRefs: [expect.objectContaining({ refId })] });
    }
  });

  it("G2-A：补齐 SellerSprite 事实投影（market 6 + profit 2）并进入 citationIndex", async () => {
    const refId = "evidence:ev-cap-1-abcdef1234567890";
    const base = fixtureFact();
    const g2aFact: ProductFact = {
      ...base,
      market: {
        ...base.market,
        subCategoryBsr: factField(753),
        dateFirstAvailable: factField("2024-03-01"),
        buyboxSeller: factField("Amazon.com"),
        fulfillmentType: factField("amazon_fulfilled"),
        // 第三方估算：性质必须是 estimate，绝不得升格为 confirmed。
        estimatedGrossMargin: { ...factField(35.5), metricNature: "estimate" as const },
        listingQualityScore: factField(88),
      },
      profit: {
        ...base.profit,
        itemWeight: factField({ value: 12, unit: "oz" as const }),
        itemDimensions: factField({ length: 9, width: 4, height: 1, unit: "in" as const }),
      },
    };
    const result = await runResearchEngine({ ...fixtureInput(), productFact: g2aFact }, {
      synthesisInvoker: vi.fn().mockResolvedValue({ ok: false, data: null, errorCode: "fixture", providerCallStarted: false }),
    });

    // 1) 8 个新增字段全部落进报告快照
    expect(result.report.facts.market.subCategoryBsr.value).toBe(753);
    expect(result.report.facts.market.dateFirstAvailable.value).toBe("2024-03-01");
    expect(result.report.facts.market.buyboxSeller.value).toBe("Amazon.com");
    expect(result.report.facts.market.fulfillmentType.value).toBe("amazon_fulfilled");
    expect(result.report.facts.market.estimatedGrossMargin.value).toBe(35.5);
    expect(result.report.facts.market.listingQualityScore.value).toBe(88);
    expect(result.report.facts.profit.itemWeight.value).toEqual({ value: 12, unit: "oz" });
    expect(result.report.facts.profit.itemDimensions.value).toEqual({ length: 9, width: 4, height: 1, unit: "in" });

    // 2) 8 个新增字段全部进入 citationIndex（source=fact，带同一 Evidence 引用）
    for (const fieldPath of [
      "facts.market.subCategoryBsr",
      "facts.market.dateFirstAvailable",
      "facts.market.buyboxSeller",
      "facts.market.fulfillmentType",
      "facts.market.estimatedGrossMargin",
      "facts.market.listingQualityScore",
      "facts.profit.itemWeight",
      "facts.profit.itemDimensions",
    ]) {
      expect(result.report.citationIndex).toContainEqual({
        fieldPath,
        source: "fact",
        evidenceRefs: [expect.objectContaining({ refId })],
      });
    }

    // 3) 报告段可达
    expect(result.report.marketOpportunity.facts.subCategoryBsr.value).toBe(753);
    expect(result.report.unitEconomics.facts.estimatedGrossMargin.value).toBe(35.5);
    expect(result.report.supplyChain.facts.itemWeight.value).toEqual({ value: 12, unit: "oz" });
    expect(result.report.supplyChain.facts.itemDimensions.value).toEqual({ length: 9, width: 4, height: 1, unit: "in" });

    // 4) 性质与状态：estimate / present；ProductFact 状态枚举里不存在 confirmed
    expect(g2aFact.market.estimatedGrossMargin?.metricNature).toBe("estimate");
    expect(result.report.facts.market.estimatedGrossMargin.status).toBe("present");
    expect(result.report.facts.market.estimatedGrossMargin.status).not.toBe("confirmed");

    // 5) 回归防线：grossProfit 仍不可计算，且 reason 原样（绝不被"修好"）
    expect(result.report.unitEconomics.deterministic.grossProfit.value).toBeNull();
    expect(result.report.unitEconomics.deterministic.grossProfit.status).toBe("not_computable");
    expect(result.report.unitEconomics.deterministic.grossProfit.reason)
      .toBe("缺少成本数据，暂无法估算利润");

    // 6) 事实引用条数 = basic 9 + market 10 + profit 5 + keywordEvidence 1 = 25（本夹具无 extended）
    const factCitations = result.report.citationIndex.filter((entry) => (entry.source ?? "fact") === "fact");
    expect(factCitations.length).toBe(25);
  });

  it("G2-A：ProductFact 缺省这些槽位时，快照形状与 citation 条数保持稳定", async () => {
    // fixtureFact() 不含 G2-A 的 8 个可选槽位（模拟旧 ProductFact / 非 SellerSprite 来源）
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({ ok: false, data: null, errorCode: "fixture", providerCallStarted: false }),
    });

    expect(Object.keys(result.report.facts.market).sort()).toEqual([
      "bsr", "buyboxSeller", "dateFirstAvailable", "estimatedGrossMargin",
      "fulfillmentType", "launchedDate", "listingQualityScore", "monthlyRevenueEstimate",
      "monthlySalesEstimate", "subCategoryBsr",
    ]);
    expect(Object.keys(result.report.facts.profit).sort()).toEqual([
      "fbaFee", "itemDimensions", "itemWeight", "packageDimensions", "packageWeight",
    ]);
    // 缺省以显式 missing 表达，绝不补值
    expect(result.report.facts.market.subCategoryBsr).toMatchObject({ value: null, status: "missing" });
    expect(result.report.facts.market.estimatedGrossMargin).toMatchObject({ value: null, status: "missing" });
    expect(result.report.facts.profit.itemWeight).toMatchObject({ value: null, status: "missing" });
    expect(result.report.facts.profit.itemDimensions).toMatchObject({ value: null, status: "missing" });

    // 条数与"字段齐备"时一致（25）→ 报告形状与 citation 条数不随输入漂移
    const factCitations = result.report.citationIndex.filter((entry) => (entry.source ?? "fact") === "fact");
    expect(factCitations.length).toBe(25);
  });

  it("G2-B：关键词 top3 进入 Research 快照与 citationIndex，性质保持 estimate", async () => {
    const refId = "evidence:ev-cap-1-abcdef1234567890";
    const attachmentRef = "attachment:att-keyword-1";
    const keywords: readonly ProductFactKeyword[] = [
      { keyword: "kitchen utensils set", monthlySearches: 246_000, metricNature: "estimate", confidence: 0.9, sourceRef: "sellersprite.keyword.monthlySearches", evidenceRef: attachmentRef },
      { keyword: "cooking utensil set", monthlySearches: 74_000, metricNature: "estimate", confidence: 0.9, sourceRef: "sellersprite.keyword.monthlySearches", evidenceRef: attachmentRef },
      { keyword: "stainless steel utensil", monthlySearches: 12_000, metricNature: "estimate", confidence: 0.9, sourceRef: "sellersprite.keyword.monthlySearches", evidenceRef: attachmentRef },
    ];
    const base = fixtureFact();
    const fact: ProductFact = {
      ...base,
      keywordEvidence: {
        topKeywords: {
          value: keywords,
          status: "present",
          metricNature: "estimate",
          source: base.sourceProof.source,
          confidence: 0.9,
          capturedAt,
          rawProofHash: proofHash,
        },
      },
    };
    const result = await runResearchEngine({ ...fixtureInput(), productFact: fact }, {
      synthesisInvoker: vi.fn().mockResolvedValue({ ok: false, data: null, errorCode: "fixture", providerCallStarted: false }),
    });

    // 1) 快照可见 top3
    expect(result.report.facts.keywordEvidence.topKeywords.status).toBe("present");
    expect(result.report.facts.keywordEvidence.topKeywords.value?.map((item) => item.keyword)).toEqual([
      "kitchen utensils set",
      "cooking utensil set",
      "stainless steel utensil",
    ]);
    // 2) 每条都带 estimate / source / evidenceRef，且绝不升格
    for (const item of result.report.facts.keywordEvidence.topKeywords.value ?? []) {
      expect(item.metricNature).toBe("estimate");
      expect(item.metricNature).not.toBe("confirmed");
      expect(item.monthlySearches).toBeGreaterThan(0);
      expect(item.evidenceRef).toBe(attachmentRef);
      expect(item.sourceRef).toBe("sellersprite.keyword.monthlySearches");
    }
    // 3) citationIndex 自动纳入（facts.* 逐字段产出）
    expect(result.report.citationIndex).toContainEqual({
      fieldPath: "facts.keywordEvidence.topKeywords",
      source: "fact",
      evidenceRefs: [expect.objectContaining({ refId })],
    });
    // 4) 条数 = 24（其他事实）+ 1（关键词）= 25
    const factCitations = result.report.citationIndex.filter((entry) => (entry.source ?? "fact") === "fact");
    expect(factCitations.length).toBe(25);
  });

  it("G2-B：无关键词证据时 keywordEvidence.topKeywords 为 missing，绝不造词", async () => {
    const refId = "evidence:ev-cap-1-abcdef1234567890";
    const result = await runResearchEngine(fixtureInput(), {
      synthesisInvoker: vi.fn().mockResolvedValue({ ok: false, data: null, errorCode: "fixture", providerCallStarted: false }),
    });
    expect(result.report.facts.keywordEvidence.topKeywords).toMatchObject({ value: null, status: "missing" });
    // 形状稳定：citation 仍然存在（与有值时同一条数）
    expect(result.report.citationIndex).toContainEqual({
      fieldPath: "facts.keywordEvidence.topKeywords",
      source: "fact",
      evidenceRefs: [expect.objectContaining({ refId })],
    });
    const factCitations = result.report.citationIndex.filter((entry) => (entry.source ?? "fact") === "fact");
    expect(factCitations.length).toBe(25);
  });

  it("fails closed before synthesis when the ProductFact evidence reference is missing, cross-subject, or the wrong target type", async () => {
    const input = fixtureInput();
    const invoker = vi.fn();
    await expect(runResearchEngine({ ...input, sourceEvidenceRefs: [] }, { synthesisInvoker: invoker })).rejects.toThrow("RESEARCH_EVIDENCE_REF_INVALID");
    const crossSubject = {
      ...input.sourceEvidenceRefs[0]!,
      refId: "evidence:ev-other-1234567890abcdef",
      evidenceId: "ev-other-1234567890abcdef",
      captureId: "cap-other",
      subjectKey: "amazon:US:B0OTHER0001",
    };
    await expect(runResearchEngine({ ...input, sourceEvidenceRefs: [crossSubject] }, { synthesisInvoker: invoker })).rejects.toThrow("RESEARCH_EVIDENCE_REF_INVALID");
    const wrongTargetType = { ...input.sourceEvidenceRefs[0]!, refId: "attachment:attachment-123" };
    await expect(runResearchEngine({ ...input, sourceEvidenceRefs: [wrongTargetType] }, { synthesisInvoker: invoker })).rejects.toThrow("RESEARCH_EVIDENCE_REF_INVALID");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("accepts immutable historical product-evidence refs when the bundle binds them exactly", async () => {
    const base = fixtureInput();
    const sourceProof = {
      ...base.productFact.sourceProof,
      source: "amazon_dom" as const,
      sourceUrl: "https://www.amazon.com/dp/B0TEST0001",
    };
    const productFact = { ...base.productFact, sourceProof };
    const currentRef: ResearchEvidenceRef = {
      refId: `evidence:${sourceProof.evidenceId}`,
      source: sourceProof.source,
      captureId: sourceProof.captureId,
      evidenceId: sourceProof.evidenceId,
      subjectKey: sourceProof.subjectKey,
      capturedAt: sourceProof.capturedAt,
      contentHash: sourceProof.contentHash,
      sourceUrl: sourceProof.sourceUrl,
    };
    const historyRef: ResearchEvidenceRef = {
      refId: "evidence:ev-history-abcdef1234567890",
      source: "amazon_dom",
      captureId: "cap-history",
      evidenceId: "ev-history-abcdef1234567890",
      subjectKey: sourceProof.subjectKey,
      capturedAt: "2026-09-18T00:00:00.000Z",
      contentHash: "b".repeat(64),
      sourceUrl: sourceProof.sourceUrl,
    };
    const invoker = vi.fn().mockResolvedValue({ ok: true, data: {}, errorCode: null, providerCallStarted: false });
    const result = await runResearchEngine({
      ...base,
      productFact,
      sourceEvidenceRefs: [currentRef, historyRef],
      researchInputBundle: {
        schemaVersion: "research-input-bundle.v1",
        taskId: base.taskId,
        candidateId: base.candidateId,
        subjectKey: sourceProof.subjectKey,
        productFact,
        sourceEvidenceRefs: [
          {
            refId: currentRef.refId,
            kind: "product_evidence",
            subjectKey: currentRef.subjectKey,
            evidenceId: currentRef.evidenceId,
            captureId: currentRef.captureId,
            version: 2,
            contentHash: currentRef.contentHash,
            capturedAt: currentRef.capturedAt,
          },
          {
            refId: historyRef.refId,
            kind: "product_evidence",
            subjectKey: historyRef.subjectKey,
            evidenceId: historyRef.evidenceId,
            captureId: historyRef.captureId,
            version: 1,
            contentHash: historyRef.contentHash,
            capturedAt: historyRef.capturedAt,
          },
        ],
      } as never,
    }, { synthesisInvoker: invoker });

    expect(result.report.generationStatus).toBe("completed");
    expect(invoker.mock.calls[0]?.[0]?.user).toContain(historyRef.refId);
  });

  it("keeps ReviewEvidence attachment references outside ProductFact Research citations until a dedicated bridge exists", async () => {
    const input = fixtureInput();
    const productRef = input.sourceEvidenceRefs[0]!;
    const reviewAttachmentRef = "attachment:review-attachment-1";
    const result = await runResearchEngine({
      ...input,
      researchInputBundle: {
        schemaVersion: "research-input-bundle.v1",
        taskId: input.taskId,
        candidateId: input.candidateId,
        subjectKey: input.productFact.subjectKey,
        productFact: input.productFact,
        sourceEvidenceRefs: [
          {
            refId: productRef.refId,
            kind: "product_evidence",
            subjectKey: productRef.subjectKey,
            evidenceId: productRef.evidenceId,
            captureId: productRef.captureId,
            version: 1,
            contentHash: productRef.contentHash,
            capturedAt: productRef.capturedAt,
          },
          {
            refId: reviewAttachmentRef,
            kind: "attachment",
            subjectKey: productRef.subjectKey,
            evidenceId: productRef.evidenceId,
            captureId: productRef.captureId,
            version: 1,
            contentHash: "b".repeat(64),
            capturedAt: productRef.capturedAt,
            attachmentId: "review-attachment-1",
          },
        ],
        keywordEvidence: [],
        reviewEvidence: [{}],
        trendObservations: [],
        missingFields: [],
        conflicts: [],
        freshness: { latestCapturedAt: productRef.capturedAt, ageDays: 0 },
        traceId: "trace-review-boundary",
      } as never,
    }, {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          vocAnalysis: { analysis: { text: "评论中出现该痛点。", evidenceRefs: [reviewAttachmentRef] } },
        },
        errorCode: null,
        providerCallStarted: false,
      }),
    });

    expect(result.report.vocAnalysis.analysis.text).toBeNull();
    expect(result.report.unverifiedAssumptions?.some((item) => item.text?.includes("评论中出现该痛点"))).toBe(true);
    expect(result.report.citationIndex.some((entry) => entry.evidenceRefs.some((ref) => ref.refId === reviewAttachmentRef))).toBe(false);
  });

  it("G3-B：当 sourceEvidenceRefs 包含同主体的 review_evidence 附件时，VOC 分析保留文本并进入 citationIndex", async () => {
    const input = fixtureInput();
    const productRef = input.sourceEvidenceRefs[0]!;
    const reviewAttachmentRef = "attachment:review-attachment-1";
    const reviewRef: ResearchEvidenceRef = {
      refId: reviewAttachmentRef,
      source: productRef.source,
      captureId: productRef.captureId,
      evidenceId: productRef.evidenceId,
      subjectKey: productRef.subjectKey,
      capturedAt: productRef.capturedAt,
      contentHash: "b".repeat(64),
      sourceUrl: null,
    };

    const result = await runResearchEngine({
      ...input,
      sourceEvidenceRefs: [productRef, reviewRef],
      reviewEvidenceSummary: [
        {
          refId: reviewAttachmentRef,
          asin: "B0GFCZTRKL",
          sampleReviews: [
            {
              rating: 5,
              title: "Very solid",
              text: "Great cutting board! Very solid.",
              verifiedPurchase: true,
            },
          ],
        },
      ],
    }, {
      synthesisInvoker: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          vocAnalysis: {
            analysis: {
              text: "买家普遍认为本款砧板坚固耐用。",
              evidenceRefs: [reviewAttachmentRef],
            },
            painPoints: [
              {
                text: "木质受潮可能开裂。",
                evidenceRefs: [reviewAttachmentRef],
              },
            ],
          },
        },
        errorCode: null,
        providerCallStarted: false,
      }),
    });

    // 1. vocAnalysis.analysis.text 成功保留（未被 JEV-002 清空）
    expect(result.report.vocAnalysis.analysis.text).toBe("买家普遍认为本款砧板坚固耐用。");
    expect(result.report.vocAnalysis.analysis.evidenceRefs[0].refId).toBe(reviewAttachmentRef);
    expect(result.report.vocAnalysis.painPoints).toHaveLength(1);
    expect(result.report.vocAnalysis.painPoints[0].text).toBe("木质受潮可能开裂。");
    expect(result.report.vocAnalysis.painPoints[0].evidenceRefs[0].refId).toBe(reviewAttachmentRef);

    // 2. citationIndex 中包含 VOC 分析的引用
    const vocCitation = result.report.citationIndex.find((entry) => entry.fieldPath === "analysis.vocAnalysis");
    expect(vocCitation).toBeDefined();
    expect(vocCitation?.source).toBe("narrative");
    expect(vocCitation?.evidenceRefs.some((r) => r.refId === reviewAttachmentRef)).toBe(true);

    const painPointCitation = result.report.citationIndex.find((entry) => entry.fieldPath === "analysis.vocAnalysis.painPoints[0]");
    expect(painPointCitation).toBeDefined();
    expect(painPointCitation?.evidenceRefs.some((r) => r.refId === reviewAttachmentRef)).toBe(true);

    // 3. 铁律核查：ProductFact 事实部分绝对不引用评论附件
    const factCitations = result.report.citationIndex.filter((entry) => (entry.source ?? "fact") === "fact");
    expect(factCitations.every((entry) => entry.evidenceRefs.every((r) => r.refId !== reviewAttachmentRef))).toBe(true);
  });

  it("Phase 2: 方案 C (PROMPT_FROM_BUNDLE) 趋势摘要成功注入 Prompt Payload 并支持研报引用", async () => {
    const input = fixtureInput();
    const productRef = input.sourceEvidenceRefs[0]!;
    const trendAttachmentRef = "attachment:trend-att-1";
    const trendRef: ResearchEvidenceRef = {
      refId: trendAttachmentRef,
      source: productRef.source,
      captureId: productRef.captureId,
      evidenceId: productRef.evidenceId,
      subjectKey: productRef.subjectKey,
      capturedAt: productRef.capturedAt,
      contentHash: "c".repeat(64),
      sourceUrl: null,
    };

    let capturedUserPayload: any = null;
    let capturedSystemPrompt: string = "";

    const invoker = vi.fn().mockImplementation(async (callInput: { system: string; user: string }) => {
      capturedSystemPrompt = callInput.system;
      capturedUserPayload = JSON.parse(callInput.user);
      return {
        ok: true,
        data: {
          marketOpportunity: {
            analysis: {
              text: "历史走势显示自然搜索流量在近期出现波动回升。",
              evidenceRefs: [trendAttachmentRef],
            },
          },
        },
        errorCode: null,
        providerCallStarted: false,
      };
    });

    const result = await runResearchEngine({
      ...input,
      sourceEvidenceRefs: [productRef, trendRef],
      researchInputBundle: {
        schemaVersion: "research-input-bundle.v1",
        taskId: input.taskId,
        candidateId: input.candidateId,
        subjectKey: input.productFact.subjectKey,
        productFact: input.productFact,
        sourceEvidenceRefs: [
          {
            refId: productRef.refId,
            kind: "product_evidence",
            subjectKey: productRef.subjectKey,
            evidenceId: productRef.evidenceId,
            captureId: productRef.captureId,
            version: 1,
            contentHash: productRef.contentHash,
            capturedAt: productRef.capturedAt,
          },
          {
            refId: trendAttachmentRef,
            kind: "attachment",
            subjectKey: productRef.subjectKey,
            evidenceId: productRef.evidenceId,
            captureId: productRef.captureId,
            version: 1,
            contentHash: "c".repeat(64),
            capturedAt: productRef.capturedAt,
            attachmentId: "trend-att-1",
          },
        ],
        keywordEvidence: [],
        reviewEvidence: [],
        trendObservations: [
          {
            observationId: "obs-1",
            subjectKey: input.productFact.subjectKey,
            field: "sellersprite.traffic.organicTraffic",
            capturedAt: "2025-05-01T00:00:00.000Z",
            value: 0,
            metricNature: "estimate",
            contentHash: "h1",
            dedupeKey: "k1",
            evidenceRefs: [trendAttachmentRef],
          },
          {
            observationId: "obs-2",
            subjectKey: input.productFact.subjectKey,
            field: "sellersprite.traffic.organicTraffic",
            capturedAt: "2025-10-01T00:00:00.000Z",
            value: 1,
            metricNature: "estimate",
            contentHash: "h2",
            dedupeKey: "k2",
            evidenceRefs: [trendAttachmentRef],
          },
        ],
        missingFields: [],
        conflicts: [],
        freshness: { latestCapturedAt: productRef.capturedAt, ageDays: 0 },
        traceId: "trace-trend-test",
      } as any,
    }, {
      synthesisInvoker: invoker,
    });

    // 1. 验证 System Prompt 包含 trendSummary 与 allowedEvidenceRefs 指令
    expect(capturedSystemPrompt).toContain("trendSummary");
    expect(capturedSystemPrompt).toContain("allowedEvidenceRefs");

    // 2. 验证 User Payload 包含结构化 trendSummary 且字段精确
    expect(capturedUserPayload.trendSummary).toBeDefined();
    expect(capturedUserPayload.trendSummary.timeWindow).toBe("2025-05-01 ~ 2025-10-01");
    expect(capturedUserPayload.trendSummary.pointsCount).toBe(2);
    expect(capturedUserPayload.trendSummary.metrics.organicTraffic.direction).toBe("rising");
    expect(capturedUserPayload.trendSummary.evidenceRefs).toEqual([trendAttachmentRef]);

    // 3. 验证 allowedEvidenceRefs 包含商品主凭证与趋势凭证
    expect(capturedUserPayload.allowedEvidenceRefs).toContain(productRef.refId);
    expect(capturedUserPayload.allowedEvidenceRefs).toContain(trendAttachmentRef);

    // 4. 验证研报成功保留趋势分析结论并建立 citationIndex 索引
    expect(result.report.marketOpportunity.analysis.text).toBe("历史走势显示自然搜索流量在近期出现波动回升。");
    expect(result.report.marketOpportunity.analysis.evidenceRefs[0].refId).toBe(trendAttachmentRef);

    const trendCitation = result.report.citationIndex.find(
      (entry) => entry.fieldPath === "analysis.marketOpportunity"
    );
    expect(trendCitation).toBeDefined();
    expect(trendCitation?.source).toBe("narrative");
    expect(trendCitation?.evidenceRefs.some((r) => r.refId === trendAttachmentRef)).toBe(true);
  });

  it("Phase 2: BLOCKED / UNVERIFIED 附件严禁进入 allowedEvidenceRefs 并在模型引用时 fail-closed 拦截", async () => {
    const input = fixtureInput();
    const productRef = input.sourceEvidenceRefs[0]!;
    const blockedAttRef = "attachment:blocked-att-999";
    const blockedRef: ResearchEvidenceRef = {
      refId: blockedAttRef,
      source: productRef.source,
      captureId: productRef.captureId,
      evidenceId: productRef.evidenceId,
      subjectKey: productRef.subjectKey,
      capturedAt: productRef.capturedAt,
      contentHash: "d".repeat(64),
      sourceUrl: null,
    };

    let capturedUserPayload: any = null;

    const invoker = vi.fn().mockImplementation(async (callInput: { system: string; user: string }) => {
      capturedUserPayload = JSON.parse(callInput.user);
      return {
        ok: true,
        data: {
          marketOpportunity: {
            analysis: {
              text: "该结论试图引用被风控拦截的证据。",
              evidenceRefs: [blockedAttRef],
            },
          },
        },
        errorCode: null,
        providerCallStarted: false,
      };
    });

    const result = await runResearchEngine({
      ...input,
      sourceEvidenceRefs: [productRef, blockedRef],
      researchInputBundle: {
        schemaVersion: "research-input-bundle.v1",
        taskId: input.taskId,
        candidateId: input.candidateId,
        subjectKey: input.productFact.subjectKey,
        productFact: input.productFact,
        sourceEvidenceRefs: [
          {
            refId: productRef.refId,
            kind: "product_evidence",
            subjectKey: productRef.subjectKey,
            evidenceId: productRef.evidenceId,
            captureId: productRef.captureId,
            version: 1,
            contentHash: productRef.contentHash,
            capturedAt: productRef.capturedAt,
          },
          {
            refId: blockedAttRef,
            kind: "attachment",
            subjectKey: productRef.subjectKey,
            evidenceId: productRef.evidenceId,
            captureId: productRef.captureId,
            version: 1,
            contentHash: "d".repeat(64),
            capturedAt: productRef.capturedAt,
            attachmentId: "blocked-att-999",
          },
        ],
        keywordEvidence: [],
        reviewEvidence: [],
        trendObservations: [],
        missingFields: [],
        conflicts: [],
        freshness: { latestCapturedAt: productRef.capturedAt, ageDays: 0 },
        traceId: "trace-blocked-test",
      } as any,
    }, {
      synthesisInvoker: invoker,
    });

    // 1. sourceEvidenceRefs 保留作为审计底账，但 allowedEvidenceRefs 绝不包含 blocked 凭证
    expect(capturedUserPayload.sourceEvidenceRefs.some((r: any) => r.refId === blockedAttRef)).toBe(true);
    expect(capturedUserPayload.allowedEvidenceRefs).not.toContain(blockedAttRef);
    expect(capturedUserPayload.allowedEvidenceRefs).toContain(productRef.refId);

    // 2. 研报中该分析因引用非法被 fail-closed 清空，移入 unverifiedAssumptions
    expect(result.report.marketOpportunity.analysis.text).toBeNull();
    expect(result.report.unverifiedAssumptions?.some((item) => item.text?.includes("该结论试图引用被风控拦截的证据"))).toBe(true);

    // 3. citationIndex 绝对不收录 blockedAttRef
    expect(result.report.citationIndex.some((entry) => entry.evidenceRefs.some((r) => r.refId === blockedAttRef))).toBe(false);
  });
});
