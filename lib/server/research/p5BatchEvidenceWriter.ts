import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { P5BatchRunResult } from "./realModelBatchRunner";
import { P5_BATCH_CASES } from "./realModelBatchRunner";
import type { P5RuntimeIsolationEvidence } from "./p5BatchIsolation";

/**
 * 批次证据落盘：每例一行 JSONL + 一份汇总 JSON。
 *
 * 硬约束：**不记录 API Key，也不记录 Authorization 请求头**。
 * 写盘前再做一次字符串扫描（`sk-` / `Bearer`），命中即拒绝写出。
 */

export const P5_EVIDENCE_DIR = "docs/reports/assets/p5-real-batch-20261029";

export type P5EvidenceCase = {
  readonly caseId: number;
  readonly taskId: string;
  readonly asin: string;
  readonly chain: string;
  readonly purpose: string;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly detail: string | null;
  readonly ticket: string | null;
  readonly fingerprint: string | null;
  readonly messagesDigest: string | null;
  readonly requestedModel: string | null;
  readonly actualModel: string | null;
  readonly modelMismatch: boolean | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly inputUpperBound: number | null;
  readonly outputCapTokens: number | null;
  readonly costUsd: number | null;
  readonly costCny: number | null;
  readonly costUnknown: boolean | null;
  readonly settled: boolean | null;
  readonly httpStatusClass: string | null;
  readonly httpStatus: number | null;
  readonly elapsedMs: number | null;
  readonly stopCode: string | null;
  readonly stopDetail: string | null;
  readonly outputSummary: string | null;
  readonly at: string | null;
};

export function buildP5EvidenceCases(result: P5BatchRunResult): P5EvidenceCase[] {
  const purposeOf = new Map(P5_BATCH_CASES.map((item) => [item.id, item.purpose]));
  return result.results.map((item) => ({
    caseId: item.id,
    taskId: item.taskId,
    asin: item.asin,
    chain: item.chain,
    purpose: purposeOf.get(item.id) ?? "",
    outcome: item.outcome,
    errorCode: item.errorCode,
    detail: item.detail,
    ticket: item.record?.ticket ?? null,
    fingerprint: item.record?.fingerprint ?? null,
    messagesDigest: item.record?.messagesDigest ?? null,
    requestedModel: item.record?.requestedModel ?? null,
    actualModel: item.record?.actualModel ?? null,
    modelMismatch: item.record?.modelMismatch ?? null,
    promptTokens: item.record?.promptTokens ?? null,
    completionTokens: item.record?.completionTokens ?? null,
    totalTokens: item.record?.totalTokens ?? null,
    inputUpperBound: item.record?.inputUpperBound ?? null,
    outputCapTokens: item.record?.outputCapTokens ?? null,
    costUsd: item.record?.costUsd ?? null,
    costCny: item.record?.costCny ?? null,
    costUnknown: item.record?.costUnknown ?? null,
    settled: item.record?.settled ?? null,
    httpStatusClass: item.record?.httpStatusClass ?? null,
    httpStatus: item.record?.httpStatus ?? null,
    elapsedMs: item.record?.elapsedMs ?? null,
    stopCode: item.record?.stopCode ?? null,
    stopDetail: item.record?.stopDetail ?? null,
    outputSummary: item.outputSummary,
    at: item.record?.at ?? null,
  }));
}

function assertNoSecrets(serialized: string, label: string): void {
  if (/\bsk-[A-Za-z0-9]{8,}/u.test(serialized) || /Bearer\s+[A-Za-z0-9._-]{8,}/iu.test(serialized)) {
    throw new Error(`${label} 含疑似密钥或 Authorization 内容，拒绝落盘。`);
  }
}

export type P5EvidenceRun = {
  readonly runId: string;
  readonly mode: string;
  readonly model: string;
  readonly budgetCny: number;
  readonly result: P5BatchRunResult;
  readonly isolation: P5RuntimeIsolationEvidence | null;
  /** 替身实际收到的请求数（用于与记录数交叉核对）。 */
  readonly stubRequests: number;
  readonly note?: string;
};

export function writeP5BatchEvidence(input: {
  readonly dir?: string;
  readonly run: P5EvidenceRun;
}): { readonly files: readonly string[]; readonly cases: number } {
  const dir = input.dir ?? P5_EVIDENCE_DIR;
  mkdirSync(dir, { recursive: true });

  const cases = buildP5EvidenceCases(input.run.result);
  const jsonl = cases.map((item) => JSON.stringify(item)).join("\n") + "\n";
  assertNoSecrets(jsonl, "cases.jsonl");

  const summary = {
    runId: input.run.runId,
    mode: input.run.mode,
    model: input.run.model,
    budgetCny: input.run.budgetCny,
    stubRequests: input.run.stubRequests,
    isolation: input.run.isolation,
    stopped: input.run.result.stopped,
    reconciliation: input.run.result.reconciliation,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      taskId: item.taskId,
      chain: item.chain,
      outcome: item.outcome,
      errorCode: item.errorCode,
      promptTokens: item.promptTokens,
      completionTokens: item.completionTokens,
      costCny: item.costCny,
      costUnknown: item.costUnknown,
      settled: item.settled,
    })),
    note: input.run.note ?? null,
    writtenAt: new Date().toISOString(),
  };
  const summaryJson = JSON.stringify(summary, null, 2) + "\n";
  assertNoSecrets(summaryJson, "run-summary.json");

  const casesPath = join(dir, `cases-${input.run.runId}.jsonl`);
  const summaryPath = join(dir, `run-summary-${input.run.runId}.json`);
  writeFileSync(casesPath, jsonl, "utf8");
  writeFileSync(summaryPath, summaryJson, "utf8");
  return { files: [casesPath, summaryPath], cases: cases.length };
}
