/**
 * Product Source Layer V1.2 — Source Adapter 契约（Phase 1 / 三、1）
 *
 * 扩展点：以后新增 Excel / API / Browser Agent / Crawlee / Playwright 来源，
 * 只能新增一个 Adapter 实现并注册，不得修改 Evidence / Research 核心架构。
 *
 * 统一接口：capture() / normalize() / validate() / createEvidence()
 *
 * 纯模块：无 IO / 无随机。时间与 id 由调用方（服务层）注入，
 * 使同一输入在任何时刻都能得到可复现的采集包。
 */
import { createHash } from "node:crypto";

import {
  buildCapturePackage,
  deriveRiskFlags,
  parseCapturePackage,
  type CapturePackage,
  type CapturePackageDraft,
  type CaptureSourceType,
} from "@/lib/sourceLayer/capturePackage";
import {
  validateCaptureReport,
  type CaptureValidationContext,
  type CaptureValidationOutcome,
  type CaptureValidationReport,
} from "@/lib/sourceLayer/validator";
import {
  isSourceLayerErrorCode,
  type SourceLayerErrorCode,
} from "@/lib/sourceLayer/errorCodes";
import type { CaptureEntityBindingProof } from "@/lib/sourceLayer/capturePackage";
import { CAPTURE_LIFECYCLE_STATES, type CaptureLifecycleState } from "@/lib/sourceLayer/stateMachine";

/** capture() 的原始输入：由各来源自行定义载荷结构，但必须是可序列化数据。 */
export type SourceAdapterInput = {
  /** 原始载荷（XLSX 字节 / JSON 文本 / 人工表单值） */
  payload: unknown;
  /** 采集时刻（ISO）；由服务层注入，保证可复现 */
  capturedAt: string;
  /** 操作者标识（owner:v1 / visitor:sandbox / system） */
  operator: string;
  /** 可选：来源文件/批次指纹 */
  sourceFingerprint?: string | null;
  /** 可选：来源 URL */
  sourceUrl?: string | null;
  /** 页面诊断在进入 Capture Package 前的 fail-closed 结论。 */
  pageContext?: {
    pageClass: string;
    allowFields: boolean;
    errorCode?: SourceLayerErrorCode | null;
    reason?: string | null;
    entityBinding?: CaptureEntityBindingProof | null;
  };
};

export type SourceAdapterCaptureResult = {
  drafts: CapturePackageDraft[];
  /** 采集阶段就产生的错误码（如 SELECTOR_FAILED / CAPTCHA_DETECTED），进入审计。 */
  errorCodes: SourceLayerErrorCode[];
  /** 被隔离的记录数（解析失败/不合规行），必须显式上报，不允许静默丢弃。 */
  quarantinedCount: number;
  /** 页面/文件摘要，进 Capture Replay。 */
  pageDigest: string;
};

export type SourceAdapter = {
  readonly sourceType: CaptureSourceType;
  /** 展示名（中文），用于 UI。 */
  readonly label: string;
  /** 该 Adapter 的版本，写入采集包来源证明便于复盘。 */
  readonly adapterVersion: string;
  capture(input: SourceAdapterInput): SourceAdapterCaptureResult;
  normalize(input: {
    draft: CapturePackageDraft;
    captureId: string;
    version: number;
    errorCodes?: readonly SourceLayerErrorCode[];
  }): CapturePackage;
  /**
   * 校验并返回「可落地的采集包 + 校验报告」。
   * 返回的 pkg 已包含冲突标记与确定性派生的 riskFlags，
   * createEvidence 必须使用它（而不是校验前的包）。
   */
  validate(input: {
    pkg: CapturePackage;
    context: CaptureValidationContext;
  }): CaptureValidationOutcome;
  createEvidence(input: {
    pkg: CapturePackage;
    report: CaptureValidationReport;
  }): CaptureEvidenceRecord;
};

/**
 * Evidence：外部数据进入系统的唯一法定形态。
 * 禁止采集结果直接进入 AI 结论——必须先成为 Evidence，再经 Validator 与人工确认。
 */
export type CaptureEvidenceRecord = {
  schemaVersion: "source-evidence-record.v1";
  evidenceId: string;
  captureId: string;
  subjectKey: string;
  version: number;
  sourceType: CaptureSourceType;
  sourceUrl: string | null;
  capturedAt: string;
  /** 采集包内容指纹（版本不可覆盖的依据）。 */
  contentHash: string;
  /** 采集包原文（证据本体，只读）。 */
  pkg: CapturePackage;
  validation: {
    verdict: CaptureValidationReport["verdict"];
    readyForResearch: boolean;
    issueCodes: string[];
    checkedAt: string;
    /** 持久化的状态机快照；旧 Evidence 没有时由读取层按旧字段兼容。 */
    captureState?: CaptureLifecycleState;
    stateEnteredAt?: string;
    captureErrorCodes?: SourceLayerErrorCode[];
  };
  /** Evidence 只能作为证据被引用，永远不能直接被当成事实。 */
  factAuthority: "evidence_only";
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * 内容指纹：SHA-256（跨进程稳定，与既有 SellerSprite 契约的 64 位十六进制约定一致）。
 *
 * 指纹只覆盖「采集内容」，显式排除 captureId 与 version 这两个每次采集都会变化的
 * 存储元数据；否则同一份数据重复提交会被误判为新版本，Evidence 版本号就失去意义。
 */
export function captureContentHashOf(pkg: CapturePackage): string {
  const { captureId: _captureId, version: _version, ...content } = pkg;
  void _captureId;
  void _version;
  // 采集时间属于事件元数据，不属于内容版本。否则同一份内容在第二次
  // 采集时只因 capturedAt 不同就会生成新的语义版本，挤掉真实历史。
  const versionContent = {
    ...content,
    sourceProof: { ...content.sourceProof, capturedAt: undefined },
    replay: { ...content.replay, capturedAt: undefined },
  };
  return createHash("sha256").update(stableStringify(versionContent), "utf8").digest("hex");
}

export function contentHashOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function evidenceIdOf(captureId: string, contentHash: string): string {
  return `ev-${captureId}-${contentHash.slice(0, 16)}`.slice(0, 160);
}

/**
 * 默认（共享）Adapter 行为：normalize / validate / createEvidence 三层对所有来源一致，
 * 具体来源只需要实现 capture()。这样新增来源永远不会碰到 Evidence 契约。
 */
export function createSourceAdapter(config: {
  sourceType: CaptureSourceType;
  label: string;
  adapterVersion: string;
  capture(input: SourceAdapterInput): SourceAdapterCaptureResult;
}): SourceAdapter {
  const adapter: SourceAdapter = {
    sourceType: config.sourceType,
    label: config.label,
    adapterVersion: config.adapterVersion,
    capture: config.capture,

    normalize({ draft, captureId, version }) {
      // normalize 不做业务判断：只做结构归一与状态标注（在 capturePackage 内完成）。
      return buildCapturePackage({ captureId, version, draft });
    },

    validate({ pkg, context }) {
      // 唯一校验入口：同时完成冲突落地与风险标记派生，避免调用方漏掉收尾步骤。
      return validateCaptureReport(pkg, context);
    },

    createEvidence({ pkg, report }) {
      // 指纹只覆盖采集内容（不含 captureId / version），使同一份数据重复提交被识别为重复而非新版本。
      const contentHash = captureContentHashOf(pkg);
      return {
        schemaVersion: "source-evidence-record.v1",
        evidenceId: evidenceIdOf(pkg.captureId, contentHash),
        captureId: pkg.captureId,
        subjectKey: pkg.subjectKey,
        version: pkg.version,
        sourceType: pkg.sourceProof.sourceType,
        sourceUrl: pkg.sourceProof.sourceUrl,
        capturedAt: pkg.sourceProof.capturedAt,
        contentHash,
        pkg,
        validation: {
          verdict: report.verdict,
          readyForResearch: report.readyForResearch,
          issueCodes: [...new Set(report.issues.map((item) => item.error.code))].sort(),
          checkedAt: report.checkedAt,
        },
        factAuthority: "evidence_only",
      };
    },
  };
  return adapter;
}

/** 采集包 → 风险标记收口（携带校验错误，使风险标记与校验结论一致）。 */
export function finalizePackageRiskFlags(
  pkg: CapturePackage,
  errorCodes: readonly SourceLayerErrorCode[],
): CapturePackage {
  const errors = errorCodes.map((code) => ({ code })) as never[];
  return {
    ...pkg,
    riskFlags: deriveRiskFlags({
      fields: pkg.fields,
      fieldStates: pkg.fieldStates,
      sourceType: pkg.sourceProof.sourceType,
      errors,
    }),
  };
}

const ADAPTER_REGISTRY = new Map<CaptureSourceType, SourceAdapter>();

export function registerSourceAdapter(adapter: SourceAdapter): void {
  ADAPTER_REGISTRY.set(adapter.sourceType, adapter);
}

export function getSourceAdapter(sourceType: CaptureSourceType): SourceAdapter | null {
  return ADAPTER_REGISTRY.get(sourceType) ?? null;
}

export function listSourceAdapters(): SourceAdapter[] {
  return [...ADAPTER_REGISTRY.values()].sort((left, right) =>
    left.sourceType.localeCompare(right.sourceType));
}

/** 运行时再校验：跨进程/持久化边界不得直接信任反序列化结果。 */
export function parseEvidenceRecord(value: unknown): CaptureEvidenceRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "source-evidence-record.v1") return null;
  if (record.factAuthority !== "evidence_only") return null;
  if (typeof record.evidenceId !== "string" || !record.evidenceId.trim()) return null;
  if (typeof record.captureId !== "string" || !record.captureId.trim()) return null;
  if (typeof record.subjectKey !== "string" || !record.subjectKey.trim()) return null;
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) return null;
  if (typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.contentHash)) {
    return null;
  }
  const pkg = parseCapturePackage(record.pkg);
  if (!pkg) return null;
  if (!record.validation || typeof record.validation !== "object") return null;
  const validation = record.validation as Record<string, unknown>;
  if (validation.verdict !== "passed"
    && validation.verdict !== "needs_review"
    && validation.verdict !== "blocked") return null;
  if (typeof validation.readyForResearch !== "boolean") return null;
  if (validation.readyForResearch && validation.verdict !== "passed") return null;
  if (!Array.isArray(validation.issueCodes)) return null;
  if (validation.captureState !== undefined
    && !CAPTURE_LIFECYCLE_STATES.includes(validation.captureState as CaptureLifecycleState)) {
    return null;
  }
  if (validation.stateEnteredAt !== undefined
    && (typeof validation.stateEnteredAt !== "string"
      || !Number.isFinite(Date.parse(validation.stateEnteredAt)))) {
    return null;
  }
  if (validation.captureErrorCodes !== undefined
    && (!Array.isArray(validation.captureErrorCodes)
      || !validation.captureErrorCodes.every(isSourceLayerErrorCode))) {
    return null;
  }
  return record as unknown as CaptureEvidenceRecord;
}
