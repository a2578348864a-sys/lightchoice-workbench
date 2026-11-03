import { NextRequest, NextResponse } from "next/server";
import {getMarketIntelligence} from "@/lib/server/marketIntelligenceService";

import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { requireAuthenticated } from "@/lib/server/demoGuard";
import { collectSellerSpriteVisibleModuleWithPlaywright } from "@/lib/server/sellerSpriteVisibleBrowser";
import {
  captureSellerSpriteVisibleQuery,
  sellerSpriteProductMarketQuerySubjectKey,
  sellerSpriteKeywordMiningQuerySubjectKey,
  validateSellerSpriteQueryInput,
  type SellerSpriteVisibleCaptureJobBinding,
  type SellerSpriteVisibleQueryResult,
  type SellerSpriteQueryInput,
} from "@/lib/server/sellerSpriteVisibleQuery";
import { createSellerSpriteCaptureJobRepository } from "@/lib/server/sellerSpriteCaptureJobRepository";
import {
  sellerSpriteCaptureAccessScopeHash,
  sellerSpriteCaptureJobFingerprint,
  type SellerSpriteCaptureJob,
} from "@/lib/server/sellerSpriteCaptureJob";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { identifySellerSpriteVisibleRows } from "@/lib/sourceLayer/sellerSpriteVisibleRowIdentity";
import { V3_MODULE_IDS, type V3ModuleId } from "@/lib/sourceLayer/v3ModuleEvidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isSameOriginRequest(origin, request);
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && isSameOriginRequest(new URL(referer).origin, request)
      && (fetchSite === null || fetchSite === "same-origin");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 技术失败码：即使出现在重新核验（recheck）里，也必须标 technical_error，
 * 不得冒充 source_limit_declared（那会挡住普通重试并误报来源结论）。 */
const SELLERSPRITE_QUERY_TECHNICAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "SELLERSPRITE_QUERY_IDENTITY_UNCONFIRMED_AT_SOURCE_LIMIT",
  "SELLERSPRITE_QUERY_IDENTITY_LOST_DURING_TRAVERSAL",
  "SELLERSPRITE_QUERY_COMPLETION_UNCONFIRMED",
  "SELLERSPRITE_QUERY_ERROR_VISIBLE",
  "SELLERSPRITE_VISIBLE_SNAPSHOT_TOO_LARGE",
  "SELLERSPRITE_PAGE_TYPE_MISMATCH",
  "SELLERSPRITE_QUERY_INPUT_MISSING",
  "SELLERSPRITE_QUERY_INPUT_NOT_UNIQUE",
  "SELLERSPRITE_VISIBLE_QUERY_FAILED",
  "PLAYWRIGHT_RUNTIME_MISSING",
]);

type SellerSpriteCaptureProvenanceLabel =
  | "NEW_JOB"
  | "REUSED_JOB"
  | "HISTORICAL_EVIDENCE"
  | "NEW_EVIDENCE"
  | "SOURCE_LIMITED"
  | "NOT_EXECUTED"
  | "QUERY_EXECUTED";

function sellerSpriteCaptureProvenance(input: {
  job: Pick<SellerSpriteCaptureJob, "evidenceRefs" | "persistedRowKeys" | "limitationReason"> | null;
  created: boolean | null;
  executed: boolean;
  sourceLimited?: boolean;
  result?: SellerSpriteVisibleQueryResult;
}): SellerSpriteCaptureProvenanceLabel[] {
  const labels: SellerSpriteCaptureProvenanceLabel[] = [];
  if (input.created !== null) labels.push(input.created ? "NEW_JOB" : "REUSED_JOB");
  if ((input.job?.evidenceRefs?.length ?? 0) > 0 || (input.job?.persistedRowKeys?.length ?? 0) > 0) {
    labels.push("HISTORICAL_EVIDENCE");
  }
  if (input.job?.limitationReason === "source_limit_declared") labels.push("SOURCE_LIMITED");
  if (input.result) {
    const captures = [input.result.capture, ...(input.result.windows ?? []).map((window) => window.capture)];
    for (const capture of captures) {
      if (capture?.gateway?.created) labels.push("NEW_EVIDENCE");
      if (capture?.gateway?.duplicate) labels.push("HISTORICAL_EVIDENCE");
      if (capture?.rawArtifact?.created) labels.push("NEW_EVIDENCE");
      if (capture?.rawArtifact?.duplicate) labels.push("HISTORICAL_EVIDENCE");
    }
    if (input.result.traversal?.limitationReason === "source_limit_declared") labels.push("SOURCE_LIMITED");
  }
  if (input.sourceLimited) labels.push("SOURCE_LIMITED");
  labels.push(input.executed ? "QUERY_EXECUTED" : "NOT_EXECUTED");
  return [...new Set(labels)];
}

export async function POST(request: NextRequest) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
  if (!sameOrigin(request)) return errorResponse(403, "origin_not_allowed", "请求来源不受信任。");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (!isRecord(body)) return errorResponse(400, "invalid_body", "请求体必须是 JSON object。");
  if (["status", "pause", "resume", "cancel"].includes(String(body.action))) {
    if (typeof body.jobId !== "string" || !body.jobId.trim()) return errorResponse(400, "capture_job_id_required", "持久任务操作必须提供 jobId。");
    try {
      const repository = createSellerSpriteCaptureJobRepository();
      const jobId = body.jobId.trim();
      const actorScope = auth.context.mode === "demo" ? `demo:${auth.context.demoAccessId}` : "owner";
      const existing = await repository.getById(jobId);
      if (!existing || existing.accessScopeHash !== sellerSpriteCaptureAccessScopeHash(actorScope) || (typeof body.researchScanId === "string" && existing.query.researchScanId !== body.researchScanId)) {
        return errorResponse(404, "capture_job_not_found_or_transition_rejected", "任务不存在或当前状态不允许此操作。");
      }
      const actor = actorScope;
      const job = body.action === "status" ? await repository.getById(jobId)
        : body.action === "pause" ? await repository.pause(jobId, actor)
          : body.action === "resume" ? await repository.resume(jobId, actor)
            : await repository.cancel(jobId, actor);
      if (!job) return errorResponse(404, "capture_job_not_found_or_transition_rejected", "任务不存在或当前状态不允许此操作。");
      return NextResponse.json({
        ok: true,
        data: {
          captureJob: job,
          provenance: sellerSpriteCaptureProvenance({ job, created: false, executed: false }),
        },
      }, { status: 200 });
    } catch {
      return errorResponse(503, "capture_job_persistence_unavailable", "持久采集任务暂不可用。");
    }
  }
  const moduleId = body.module;
  const sourceUrl = body.sourceUrl;
  let subjectKey = typeof body.subjectKey === "string" ? body.subjectKey : "";
  if (!V3_MODULE_IDS.includes(moduleId as V3ModuleId)) return errorResponse(400, "module_invalid", "V3 模块标识无效。");
  if (typeof sourceUrl !== "string" || !sourceUrl.trim()) return errorResponse(400, "source_url_required", "SellerSprite 页面 URL 必填。");
  if (typeof subjectKey !== "string" || !subjectKey.trim()) return errorResponse(400, "subject_key_required", "subjectKey 必填。");
  if (!isRecord(body.identity)) return errorResponse(400, "identity_required", "identity 必须是 JSON object。");
  const sellerSpriteQueryModules: readonly V3ModuleId[] = ["sellersprite_product_market", "reverse_asin", "keyword_mining_trend"];
  if (body.action === "recheck" && !sellerSpriteQueryModules.includes(moduleId as V3ModuleId)) {
    return errorResponse(422, "source_recheck_module_invalid", "请通过对应模块的持久任务核验来源，不支持通用重试。");
  }
  if (sellerSpriteQueryModules.includes(moduleId as V3ModuleId)) {
    let queryInput: SellerSpriteQueryInput;
    try {
      queryInput = validateSellerSpriteQueryInput(body.queryInput, moduleId);
    } catch (error) {
      const code = error instanceof Error ? error.message : "SELLERSPRITE_QUERY_INPUT_INVALID";
      return errorResponse(400, code.toLowerCase(), "SellerSprite 查询输入不符合该页面的查询合同。");
    }
    if (queryInput.module === "keyword_mining_trend" && subjectKey === "sellersprite-query:auto") subjectKey = sellerSpriteKeywordMiningQuerySubjectKey(queryInput);
    if (queryInput.module === "sellersprite_product_market"
      && subjectKey !== sellerSpriteProductMarketQuerySubjectKey(queryInput)) {
      return errorResponse(400, "sellersprite_product_market_query_subject_invalid", "Product Market 必须使用独立的类目查询主体，不能写入任一商品 ASIN 主体。");
    }
    const identityMatchesQuery = queryInput.module === "reverse_asin"
      ? body.identity.asin === queryInput.targetAsin.toUpperCase()
        && subjectKey === `amazon:US:${queryInput.targetAsin.toUpperCase()}`
      : queryInput.module === "sellersprite_product_market"
        ? typeof body.identity.category === "string"
          && body.identity.category.normalize("NFC").trim().toLocaleLowerCase() === queryInput.category.normalize("NFC").trim().toLocaleLowerCase()
        : typeof body.identity.keyword === "string"
          && body.identity.keyword.normalize("NFC").trim().toLocaleLowerCase() === queryInput.seedKeyword.normalize("NFC").trim().toLocaleLowerCase();
    if (!identityMatchesQuery) return errorResponse(400, "sellersprite_query_identity_mismatch", "SellerSprite 页面身份必须与当前查询对象一致。");
    if (queryInput.module === "keyword_mining_trend" && !/^amazon:US:[A-Z0-9]{10}$/u.test(subjectKey) && subjectKey !== sellerSpriteKeywordMiningQuerySubjectKey(queryInput)) {
      return errorResponse(400, "sellersprite_keyword_subject_invalid", "关键词证据必须绑定准确的种子查询；兼容的商品主体必须是明确US ASIN。");
    }
    const accessScope = auth.context.mode === "demo" ? `demo:${auth.context.demoAccessId}` : "owner";
    const windowBudget = body.windowBudget;
    if (windowBudget !== undefined && (!Number.isSafeInteger(windowBudget) || (windowBudget as number) < 1 || (windowBudget as number) > 20)) {
      return errorResponse(400, "capture_window_budget_invalid", "单次执行窗口预算必须是 1 到 20 之间的整数。");
    }
    let query: Readonly<Record<string, string>>;
    if (queryInput.module === "sellersprite_product_market") {
      query = { subjectKey, category: queryInput.category, filters: JSON.stringify(Object.fromEntries(Object.entries(queryInput.filters ?? {}).sort(([a], [b]) => a.localeCompare(b)))) };
    } else if (queryInput.module === "reverse_asin") {
      query = { subjectKey, targetAsin: queryInput.targetAsin.toUpperCase() };
    } else {
      query = { subjectKey, seedKeyword: queryInput.seedKeyword.normalize("NFC").trim(), conditions: JSON.stringify(Object.fromEntries(Object.entries(queryInput.conditions ?? {}).sort(([a], [b]) => a.localeCompare(b)))) };
    }
    if (body.researchScanId !== undefined) {
      if(typeof body.researchScanId!=="string")return errorResponse(422,"research_scope_invalid","研究ID无效。");
      try {
        const research=await getMarketIntelligence({context:auth.context,scanId:body.researchScanId});
        if(research.marketplace!=="US"||(queryInput.module==="reverse_asin"&&!research.statistics?.subjects.includes(subjectKey))||(queryInput.module==="keyword_mining_trend"&&research.research?.keyword?.normalize("NFC").trim().toLocaleLowerCase()!==queryInput.seedKeyword.normalize("NFC").trim().toLocaleLowerCase()))return errorResponse(422,"research_scope_invalid","查询必须属于当前美国站研究的种子词或正式ASIN。");
        query={...query,researchScanId:body.researchScanId};
      }catch{return errorResponse(404,"research_not_found","当前访问范围内没有这项研究。");}
    }
    const queryFingerprint = sellerSpriteCaptureJobFingerprint({
      module: queryInput.module,
      marketplace: "US",
      query,
      accessScopeHash: sellerSpriteCaptureAccessScopeHash(accessScope),
    });
    let jobClaim: { job: import("@/lib/server/sellerSpriteCaptureJob").SellerSpriteCaptureJob; fence: number } | null = null;
    let jobRepository: ReturnType<typeof createSellerSpriteCaptureJobRepository>;
    let ensuredJob: SellerSpriteCaptureJob | null = null;
    let ensuredJobWasCreated = false;
    try {
      jobRepository = createSellerSpriteCaptureJobRepository();
      const existingJob = await jobRepository.getByFingerprint(queryFingerprint);
      if (body.action === "recheck" && (!existingJob || existingJob.limitationReason !== "source_limit_declared" || body.jobId !== existingJob.jobId)) {
        return errorResponse(409, "source_recheck_not_required", "仅可重新核验当前已记录来源限制的任务；请先读取任务状态。");
      }
      if (existingJob?.limitationReason === "source_limit_declared" && body.action !== "recheck") {
        return NextResponse.json({
          ok: false,
          error: { code: "capture_job_source_limited", message: "历史 SellerSprite Job 已记录套餐访问限制；本次没有重试或打开页面，已有证据与断点保持不变。" },
          data: {
            captureJob: existingJob,
            provenance: sellerSpriteCaptureProvenance({ job: existingJob, created: false, executed: false, sourceLimited: true }),
          },
        }, { status: 409 });
      }
      if (queryInput.module === "reverse_asin" || (queryInput.module === "keyword_mining_trend" && subjectKey.startsWith("amazon:"))) {
        let subjectEvidence: Awaited<ReturnType<ReturnType<typeof createEvidenceStore>["getSubject"]>>;
        try {
          subjectEvidence = await createEvidenceStore(sourceLayerOperator(auth.context)).getSubject(subjectKey);
        } catch {
          return NextResponse.json({
            ok: false,
            error: { code: "subject_evidence_preflight_unavailable", message: "无法确认当前访问主体的商品基础 Evidence；为安全起见未启动采集任务。请稍后重试或检查 EvidenceStore 可用性。" },
            data: {
              ...(existingJob ? { captureJob: existingJob } : {}),
              provenance: sellerSpriteCaptureProvenance({ job: existingJob, created: existingJob ? false : null, executed: false }),
            },
          }, { status: 503 });
        }
        if (!subjectEvidence?.versions.at(-1)) {
          return NextResponse.json({
            ok: false,
            error: {
              code: "evidence_missing",
              status: "human_required",
              message: "当前访问主体下没有该商品可复用的基础 Evidence。请先通过已授权的合法来源导入或采集商品基础证据，再重试；本次没有启动 SellerSprite 查询或写入 Evidence。",
            },
            data: {
              ...(existingJob ? { captureJob: existingJob } : {}),
              provenance: sellerSpriteCaptureProvenance({ job: existingJob, created: existingJob ? false : null, executed: false }),
            },
          }, { status: 409 });
        }
      }
      const ensured = await jobRepository.ensure({
        module: queryInput.module,
        marketplace: "US",
        query,
        accessScope,
        ...(typeof windowBudget === "number" ? { windowBudget } : {}),
      });
      ensuredJob = ensured.job;
      ensuredJobWasCreated = ensured.created;
      if (ensured.job.limitationReason === "source_limit_declared" && body.action !== "recheck") {
        return NextResponse.json({
          ok: false,
          error: { code: "capture_job_source_limited", message: "SellerSprite Job 已记录套餐访问限制；本次没有重试或打开页面，已有证据与断点保持不变。" },
          data: {
            captureJob: ensured.job,
            provenance: sellerSpriteCaptureProvenance({ job: ensured.job, created: ensured.created, executed: false, sourceLimited: true }),
          },
        }, { status: 409 });
      }
      if (body.action === "prepare") {
        return NextResponse.json({
          ok: true,
          data: {
            captureJob: ensured.job,
            provenance: sellerSpriteCaptureProvenance({ job: ensured.job, created: ensured.created, executed: false }),
          },
        }, { status: 201 });
      }
      const retryable = body.action === "recheck" ? ensured.job : ensured.job.status === "PARTIAL" || ensured.job.status === "FAILED"
        ? await jobRepository.retry(ensured.job.jobId) : ensured.job;
      if (!retryable) return NextResponse.json({
        ok: false,
        error: { code: "capture_job_not_retryable", message: "该采集任务当前状态不允许重试。" },
        data: {
          captureJob: ensured.job,
          provenance: sellerSpriteCaptureProvenance({ job: ensured.job, created: ensured.created, executed: false }),
        },
      }, { status: 409 });
      jobClaim = body.action === "recheck"
        ? await jobRepository.claimSourceRecheck(retryable.jobId, `seller-sprite-route-${process.pid}`)
        : await jobRepository.claim(retryable.jobId, `seller-sprite-route-${process.pid}`);
      if (!jobClaim) return NextResponse.json({
        ok: false,
        error: { code: "capture_job_not_claimable", status: retryable.status },
        data: {
          captureJob: retryable,
          provenance: sellerSpriteCaptureProvenance({ job: retryable, created: ensured.created, executed: false }),
        },
      }, { status: 409 });
    } catch {
      return errorResponse(503, "capture_job_persistence_unavailable", "SellerSprite 持久采集任务暂不可用；未发起页面查询。");
    }
    let activeJob = jobClaim.job;
    const worker = jobClaim.job.leaseOwner ?? "";
    const onSnapshot = async (input: {
      snapshotFingerprint: string;
      reportedTotalRows: number | null;
      accessibleRows: number | null;
      unavailableRows: number | null;
      forceNewGeneration?: boolean;
    }): Promise<SellerSpriteVisibleCaptureJobBinding | null> => {
      const bound = await jobRepository.bindSnapshot(jobClaim!.job.jobId, worker, jobClaim!.fence, input, new Date());
      if (!bound) return null;
      activeJob = bound;
      return {
        captureGeneration: bound.captureGeneration ?? 0,
        snapshotFingerprint: bound.snapshotFingerprint ?? "",
        cursorWindowFingerprint: bound.cursorWindowFingerprint ?? null,
        cursor: bound.cursor,
        rowKeys: bound.rowKeys,
        structuredValidRowKeys: bound.structuredValidRowKeys,
        persistedRowKeys: bound.persistedRowKeys ?? [],
        counters: bound.counters,
        diagnostics: bound.diagnostics ?? { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
      };
    };
    const onWindowCheckpoint = async (checkpoint: Parameters<NonNullable<Parameters<typeof captureSellerSpriteVisibleQuery>[0]["onWindowCheckpoint"]>>[0]): Promise<boolean> => {
      const saved = await jobRepository.saveProgress(jobClaim!.job.jobId, worker, jobClaim!.fence, {
        now: new Date(),
        rowKeys: checkpoint.rowKeys,
        structuredValidRowKeys: checkpoint.structuredValidRowKeys,
        persistedRowKeys: checkpoint.persistedRowKeys,
        evidenceRefs: checkpoint.evidenceRefs,
        cursor: checkpoint.cursor,
        cursorWindowFingerprint: checkpoint.cursorWindowFingerprint,
        counters: checkpoint.counters,
        diagnostics: checkpoint.diagnostics,
        limitationReason: "unknown",
        lastErrorCode: checkpoint.lastErrorCode ?? null,
        status: "RUNNING",
      });
      if (!saved) return false;
      activeJob = saved;
      return saved.status === "RUNNING" && saved.fence === jobClaim!.fence;
    };
    const result = await captureSellerSpriteVisibleQuery({
      context: auth.context,
      module: moduleId as typeof queryInput.module,
      sourceUrl,
      subjectKey,
      identity: body.identity,
      queryInput,
      attemptGeneration: jobClaim.job.attemptGeneration,
      maxWindows: jobClaim.job.windowBudget,
      accountAccessFingerprint: jobClaim.job.accessScopeHash,
      captureJobFingerprint: jobClaim.job.queryFingerprint,
      resumeCursor: jobClaim.job.cursor,
      onSnapshot,
      onWindowCheckpoint,
    });
    const queryProvenance = sellerSpriteCaptureProvenance({
      job: ensuredJob,
      created: ensuredJobWasCreated,
      executed: true,
      result,
    });
    if (result.errorCode === "SELLERSPRITE_CAPTURE_JOB_STOPPED") {
      const latest = await jobRepository.getById(jobClaim.job.jobId);
      return NextResponse.json({
        ok: false,
        error: { code: result.errorCode, message: "任务已暂停、取消或失去租约；已完成的 Evidence 与检查点均保留。" },
        data: { captureJob: latest, provenance: queryProvenance },
      }, { status: 409 });
    }
    if (result.status !== "captured" && !result.traversal) {
      const human = result.status === "human_required";
      const failedJob = await jobRepository.saveProgress(jobClaim.job.jobId, worker, jobClaim.fence, {
        now: new Date(), rowKeys: [], evidenceRefs: [], cursor: activeJob.cursor, counters: {},
        status: result.status === "failed" ? "FAILED" : "PARTIAL",
        limitationReason: human ? (/CAPTCHA|STOP/u.test(result.errorCode ?? "") ? "captcha_or_stop_page" : "human_login_required")
          : result.status === "unavailable" || SELLERSPRITE_QUERY_TECHNICAL_ERROR_CODES.has(result.errorCode ?? "") ? "technical_error"
            : result.status === "limited" || body.action === "recheck" ? "source_limit_declared" : "unknown",
        lastErrorCode: result.errorCode,
      });
      if (!failedJob) return NextResponse.json({
        ok: false,
        error: { code: "capture_job_failure_checkpoint_lost", message: "页面查询失败状态未能持久化；请先查看任务状态再重试。" },
        data: { provenance: queryProvenance },
      }, { status: 503 });
      const status = result.status === "unavailable" ? 503 : result.status === "failed" ? 409 : 200;
      const limitedMessage = "来源已声明套餐访问限制，本次查询身份确认但当前可见范围为空；未写入行证据，任务与已有断点保持不变。";
      return NextResponse.json({
        ok: false,
        error: { code: result.errorCode ?? "sellersprite_visible_query_failed", message: result.inputDiagnostics ? `来源表单未通过识别：可见输入匹配${result.inputDiagnostics.visibleMatches}个，页面「${result.inputDiagnostics.pageTitle}」。请在专用浏览器核对登录和页面加载状态；未提交查询或保存指标。` : result.status === "limited" ? limitedMessage : "SellerSprite 页面查询未形成身份确认的可见结果；请在专用浏览器核对登录、站点及套餐后读取任务状态。", status: result.status },
        data: { captureJob: failedJob, provenance: queryProvenance, inputDiagnostics:result.inputDiagnostics??null },
      }, { status });
    }
    if (result.traversal) {
      const traversal = result.traversal;
      const finalStatus = traversal.finalStatus ?? "PARTIAL";
      const finalJob = await jobRepository.saveProgress(jobClaim.job.jobId, worker, jobClaim.fence, {
        now: new Date(), rowKeys: [], structuredValidRowKeys: [], persistedRowKeys: [], evidenceRefs: [],
        cursor: traversal.cursor ?? activeJob.cursor,
        counters: traversal.counters,
        diagnostics: traversal.diagnostics,
        status: finalStatus,
        // 采集器已区分真实来源限制与技术失败；这里如实透传，
        // 不得因 recheck 动作把技术失败改标为套餐限制。
        limitationReason: traversal.limitationReason,
        lastErrorCode: traversal.errorCode,
      });
      if (!finalJob) return NextResponse.json({
        ok: false,
        error: { code: "capture_job_final_checkpoint_lost", message: "窗口证据已逐步写入，但最终状态 CAS 未成功；请读取任务状态后再恢复。" },
        data: { captureJob: await jobRepository.getById(jobClaim.job.jobId), provenance: queryProvenance },
      }, { status: 503 });
      return NextResponse.json({
        ok: finalStatus !== "PARTIAL" || traversal.errorCode === null,
        data: {
          status: finalJob.status,
          module: result.module,
          sourceUrl: result.sourceUrl,
          snapshot: result.snapshot,
          windows: (result.windows ?? []).map((window) => ({
            cursor: window.cursor,
            rowKeys: window.rowKeys,
            structuredValidRowKeys: window.structuredValidRowKeys,
            persistedRowKeys: window.persistedRowKeys,
            evidenceRefs: window.evidenceRefs,
            actualVisibleRows: window.actualVisibleRows,
            duplicatesRejected: window.duplicatesRejected,
          })),
          attachment: result.capture?.attachment ?? null,
          rawArtifact: result.capture?.rawArtifact.artifact ?? null,
          downstream: result.capture?.downstream ?? null,
          coverage: finalJob.counters,
          diagnostics: finalJob.diagnostics,
          captureJob: finalJob,
          errorCode: traversal.errorCode,
          provenance: queryProvenance,
        },
      }, { status: finalStatus === "COMPLETE" ? 201 : traversal.errorCode ? 409 : 200 });
    }
    if (!result.capture) return NextResponse.json({
      ok: false,
      error: { code: "capture_result_missing", message: "SellerSprite Evidence 已存在或本轮未产生新行，请读取任务状态核对。" },
      data: { captureJob: activeJob, provenance: queryProvenance },
    }, { status: 503 });
    const rowIdentity = identifySellerSpriteVisibleRows(queryInput.module, result.snapshot?.tables ?? []);
    const attachmentId = result.capture.attachment.attachmentId;
    const generationRowKeys = rowIdentity.rowKeys.map((key) => `attempt:${jobClaim!.job.attemptGeneration}:${key}`);
    const generationStructuredValidRowKeys = rowIdentity.structuredValidRowKeys
      .map((key) => `attempt:${jobClaim!.job.attemptGeneration}:${key}`);
    const partialJob = await jobRepository.saveProgress(jobClaim.job.jobId, jobClaim.job.leaseOwner ?? "", jobClaim.fence, {
      now: new Date(),
      rowKeys: generationRowKeys,
      structuredValidRowKeys: generationStructuredValidRowKeys,
      evidenceRefs: [`attachment:${attachmentId}`, `raw-artifact:${result.capture.rawArtifact.artifact.artifactId}`],
      cursor: jobClaim.job.cursor,
      counters: {
        capturedUniqueRows: new Set([...jobClaim.job.rowKeys, ...generationRowKeys]).size,
        structuredValidRows: new Set([...jobClaim.job.structuredValidRowKeys, ...generationStructuredValidRowKeys]).size,
      },
      status: "PARTIAL",
      limitationReason: "unknown",
      lastErrorCode: "SINGLE_VISIBLE_SNAPSHOT_ONLY_ROW_EVIDENCE_BINDING_PENDING",
    });
    if (!partialJob) return NextResponse.json({
      ok: false,
      error: { code: "capture_job_success_checkpoint_lost", message: "可见页面证据已采集，但任务检查点未能持久化。请先核对已有 Evidence 后再重试。" },
      data: { attachmentId, rawArtifactId: result.capture.rawArtifact.artifact.artifactId, provenance: queryProvenance },
    }, { status: 503 });
    return NextResponse.json({
      ok: true,
      data: {
        status: result.status,
        module: result.module,
        sourceUrl: result.sourceUrl,
        snapshot: result.snapshot,
        attachment: result.capture.attachment,
        rawArtifact: result.capture.rawArtifact.artifact,
        downstream: result.capture.downstream,
        captureJob: partialJob,
        provenance: queryProvenance,
      },
    }, { status: 201 });
  }
  const result = await collectSellerSpriteVisibleModuleWithPlaywright({
    context: auth.context,
    module: moduleId as V3ModuleId,
    sourceUrl,
    subjectKey,
    identity: body.identity,
    sourceSurface: typeof body.sourceSurface === "string" ? body.sourceSurface : undefined,
  });
  if (result.status !== "captured" || !result.capture) {
    return NextResponse.json({ ok: false, error: { code: result.errorCode ?? "sellersprite_visible_capture_failed", message: result.errorMessage ?? "SellerSprite Browser Visible Capture 未完成。", status: result.status, browser: result.browser } }, { status: result.status === "failed" ? 409 : 200 });
  }
  return NextResponse.json({
    ok: true,
    data: {
      status: result.status,
      module: result.module,
      sourceUrl: result.sourceUrl,
      envelope: result.envelope,
      attachment: result.capture.attachment,
      rawArtifact: result.capture.rawArtifact.artifact,
      screenshotArtifact: result.screenshotArtifact?.artifact ?? null,
      downstream: result.capture.downstream,
    },
  }, { status: 201 });
}
