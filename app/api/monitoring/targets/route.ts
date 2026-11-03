import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_MONITORING_POLICY, isMonitoringSchedule, isValidTimeZone, parseMonitoringPolicy, type MonitoringSchedule } from "@/lib/server/continuousMonitoringContract";
import { projectLatestCapture, type MonitoringLatestCapture } from "@/lib/server/continuousMonitoringCaptureProjection";
import {
  continuousMonitoringSchedulerConfigEnabled,
  readContinuousMonitoringSchedulerRuntimeState,
} from "@/lib/server/continuousMonitoringScheduler";
import {
  authorizeMonitoringRequest,
  monitoringError,
  onlyAllowedKeys,
  readMonitoringJsonBody,
} from "@/lib/server/continuousMonitoringHttp";
import { createMonitoringRepository } from "@/lib/server/continuousMonitoringRepository";
import {
  isContinuousMonitoringRetired,
  MONITORING_RETIRED_CODE,
  MONITORING_RETIRED_MESSAGE,
} from "@/lib/server/continuousMonitoringRetirement";
import { trustedAmazonImageUrl } from "@/lib/server/monitoringProductIdentity";
import { nextMonitoringRunAt } from "@/lib/server/continuousMonitoringContract";
import { prisma } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Evidence projection reads one subject directory per watch; keep the list response bounded. */
const MAX_CAPTURE_PROJECTION_WATCHES = 20;

export async function GET(request: NextRequest) {
  const denied = authorizeMonitoringRequest(request, false);
  if (denied) return denied;
  try {
    const repository = createMonitoringRepository();
    const rawWatches = await repository.listWatches();
    const schedulerRuntime = readContinuousMonitoringSchedulerRuntimeState();
    const schedulerConfigEnabled = continuousMonitoringSchedulerConfigEnabled();
    const scheduler = {
      // `in_process` means the probe read this Node process's own scheduler instance.
      probe: "in_process" as const,
      status: schedulerRuntime?.status ?? "not_started",
      configEnabled: schedulerConfigEnabled,
      started: schedulerRuntime?.started ?? false,
      // 「进程里有调度器」不等于「调度器真的在正常跑」：把最近一次 tick 的事实一并暴露。
      lastTickAt: schedulerRuntime?.lastTickAt ?? null,
      lastTickFinishedAt: schedulerRuntime?.lastTickFinishedAt ?? null,
      lastTickStatus: schedulerRuntime?.lastTickStatus ?? null,
      lastTickError: schedulerRuntime?.lastTickError ?? null,
      lastTickWatchCount: schedulerRuntime?.lastTickWatchCount ?? null,
      lastTickFailureCount: schedulerRuntime?.lastTickFailureCount ?? null,
      observedAt: new Date().toISOString(),
    };
    const watches = await Promise.all(
      rawWatches.map(async (watch, index) => {
        // P2-6：把最近一次运行的结果带到主列表，失败不再只藏在运行历史里。
        let lastRunOutcome: string | null = null;
        let lastRunErrorCode: string | null = null;
        let lastRunResultOutcome: string | null = null;
        let lastRunFinishedAt: string | null = null;
        let latestCapture: MonitoringLatestCapture | null = null;
        let hasCapturedEvidence = false;
        let captureProjection: "ok" | "unreadable" | "not_projected" | "none" = "none";
        try {
          const [latestRun] = await repository.listRuns(watch.id, 1);
          if (latestRun) {
            lastRunOutcome = latestRun.status;
            lastRunErrorCode = latestRun.errorCode;
            lastRunResultOutcome = latestRun.outcome;
            lastRunFinishedAt = latestRun.finishedAt;
            hasCapturedEvidence = Boolean(latestRun.currentEvidenceRef);
            if (latestRun.currentEvidenceRef) {
              if (index < MAX_CAPTURE_PROJECTION_WATCHES) {
                latestCapture = await projectLatestCapture(latestRun.currentEvidenceRef);
                captureProjection = latestCapture ? "ok" : "unreadable";
              } else {
                captureProjection = "not_projected";
              }
            }
          }
        } catch {}
        const asinMatch = /^[a-z]+:[A-Za-z0-9_-]+:([A-Za-z0-9]{10})$/i.exec(watch.subjectKey);
        const asin = asinMatch ? asinMatch[1] : null;
        // 证据优先：标题与图片都来自本次已校验的 EvidenceStore 附件，
        // 与价格/评分/评论数同一份附件，因此标题、图片与 ASIN 必然指向同一个商品。
        const product = latestCapture?.product ?? null;
        let title = product?.title ?? null;
        let image = product?.image ?? null;
        const titleSource = product?.titleSource ?? null;
        const titleNote = product?.titleNote ?? null;
        const chineseTitle = product?.chineseTitle ?? null;
        const chineseCategory = product?.chineseCategory ?? null;
        const chineseTitleStatus = product?.chineseTitleStatus ?? "UNAVAILABLE";
        const chineseTitleNote = product?.chineseTitleNote ?? null;
        let titleSourceResolved = titleSource;
        let titleNoteResolved = titleNote;
        if (asin && (!title || !image)) {
          // 兜底：既有数据库快照。只补英文标题与可信图片，不推断中文名、不重新采集。
          const cand = await prisma.opportunityCandidate.findFirst({
            where: {
              OR: [
                { name: { contains: asin } },
                { sourceMetaJson: { contains: asin } },
              ],
            },
            select: { name: true, sourceMetaJson: true },
          });
          if (cand) {
            if (!title && cand.name !== asin) {
              title = cand.name;
              titleSourceResolved = "database_snapshot";
              titleNoteResolved = "取自既有候选快照，非本次采集证据。";
            }
            try {
              const meta = cand.sourceMetaJson ? JSON.parse(cand.sourceMetaJson) : null;
              const candidateImage = trustedAmazonImageUrl(meta?.snapshot?.imageUrl || meta?.snapshot?.image || meta?.imageUrl || meta?.image);
              if (!image && candidateImage) image = candidateImage;
              if (!title && meta?.snapshot?.title) {
                title = meta.snapshot.title;
                titleSourceResolved = "database_snapshot";
                titleNoteResolved = "取自既有候选快照，非本次采集证据。";
              }
            } catch {}
          }
          if (!image) {
            const pbi = await prisma.productBatchItem.findFirst({
              where: { asin },
              // 显式排序：避免命中哪一行取决于 SQLite 行序，保证同一商品每次展示一致。
              orderBy: { updatedAt: "desc" },
              select: { normalizedProductJson: true, imageSnapshotJson: true },
            });
            if (pbi) {
              try {
                const norm = pbi.normalizedProductJson ? JSON.parse(pbi.normalizedProductJson) : null;
                if (!title && (norm?.title || norm?.name)) {
                  title = norm.title || norm.name;
                  titleSourceResolved = "database_snapshot";
                  titleNoteResolved = "取自既有批次快照，非本次采集证据。";
                }
                if (!image) {
                  const batchImage = trustedAmazonImageUrl(norm?.imageUrl || norm?.image);
                  if (batchImage) image = batchImage;
                }
                if (!image && pbi.imageSnapshotJson) {
                  const imgSnap = JSON.parse(pbi.imageSnapshotJson);
                  const snapshotImage = trustedAmazonImageUrl(imgSnap?.url || imgSnap?.imageUrl);
                  if (snapshotImage) image = snapshotImage;
                }
              } catch {}
            }
          }
        }
        return {
          ...watch,
          title,
          image,
          titleSource: titleSourceResolved,
          titleNote: titleNoteResolved,
          chineseTitle,
          chineseCategory,
          chineseTitleStatus,
          chineseTitleNote,
          lastRunOutcome,
          lastRunErrorCode,
          lastRunResultOutcome,
          lastRunFinishedAt,
          latestCapture,
          hasCapturedEvidence,
          captureProjection,
        };
      })
    );
    return NextResponse.json({ ok: true, data: { watches, scheduler } });
  } catch {
    return monitoringError(500, "monitoring_storage_unavailable", "监控数据暂时不可读；未修改任何监控或证据数据。");
  }
}
export async function POST(request: NextRequest) {
  // V6 退役门禁：创建监控属于永久停止的写入入口，必须先于鉴权/解析/数据库访问返回稳定 410。
  if (isContinuousMonitoringRetired()) {
    return monitoringError(410, MONITORING_RETIRED_CODE, MONITORING_RETIRED_MESSAGE);
  }
  const denied = authorizeMonitoringRequest(request, true);
  if (denied) return denied;
  const body = await readMonitoringJsonBody(request);
  if (!body) return monitoringError(400, "invalid_request_body", "请求体不是合法 JSON 或超过大小限制。");
  if (!onlyAllowedKeys(body, ["asin", "captureModule", "schedule", "timezone", "policy"])) {
    return monitoringError(422, "monitoring_fields_unsupported", "请求包含 V1 不支持的字段。");
  }

  const asin = typeof body.asin === "string" ? body.asin.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{10}$/u.test(asin)) return monitoringError(422, "asin_invalid", "ASIN 必须是 10 位字母数字。");
  if (body.captureModule !== undefined && body.captureModule !== "amazon_detail") {
    return monitoringError(422, "capture_module_unsupported", "V1 当前仅支持 Amazon Detail 受控采集路径。");
  }
  const schedule: MonitoringSchedule = body.schedule === undefined ? "daily@09:00" : body.schedule as MonitoringSchedule;
  if (!isMonitoringSchedule(schedule)) return monitoringError(422, "schedule_invalid", "V1 计划仅支持每天本地时间 09:00 或 21:00。");
  const timezone = body.timezone === undefined ? "Asia/Shanghai" : body.timezone;
  if (!isValidTimeZone(timezone)) return monitoringError(422, "timezone_invalid", "请提供有效的 IANA 时区。");
  const policy = body.policy === undefined ? DEFAULT_MONITORING_POLICY : parseMonitoringPolicy(body.policy);
  if (!policy) return monitoringError(422, "policy_invalid", "变化规则超出 V1 允许字段或阈值范围。");

  const repository = createMonitoringRepository();
  const subjectKey = `amazon:US:${asin}`;
  try {
    const existing = await repository.listWatches();
    if (existing.length >= 200) return monitoringError(409, "watch_limit_reached", "V1 最多保存 200 个监控目标。");
    const now = new Date();
    const watch = await repository.createWatch({
      id: randomUUID(),
      subjectKey,
      captureModule: "amazon_detail",
      enabled: true,
      schedule,
      timezone,
      policy,
      lastRunAt: null,
      lastMeaningfulChangeAt: null,
      nextRunAt: nextMonitoringRunAt(schedule, timezone, now).toISOString(),
      activeRunId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    return NextResponse.json({ ok: true, data: { watch } }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error && error.message === "TARGET_ALREADY_EXISTS" ? "watch_already_exists" : "monitoring_storage_unavailable";
    const status = code === "watch_already_exists" ? 409 : 500;
    const message = code === "watch_already_exists" ? "该 Amazon 商品已经在监控列表中。" : "监控配置未能保存。";
    return monitoringError(status, code, message);
  }
}
