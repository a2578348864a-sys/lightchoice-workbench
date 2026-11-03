import "server-only";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  buildSourceRawArtifact,
  inspectRawArtifact,
  type RawArtifactKind,
  type RawArtifactProvenance,
  type SourceRawArtifact,
} from "@/lib/sourceLayer/rawArtifact";
import type { CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import {
  createEvidenceStore,
  type EvidenceStore,
} from "@/lib/sourceLayer/server/evidenceStore";
import { sourceLayerOperator } from "@/lib/sourceLayer/server/sourceLayerService";

export type RawArtifactIntakeInput = {
  context: AccessContext;
  subjectKey: string;
  sourceType: CaptureSourceType;
  kind: RawArtifactKind;
  fileName: string;
  contentType?: string | null;
  bytes: Uint8Array;
  capturedAt?: string;
  provenance: RawArtifactProvenance;
  store?: EvidenceStore;
};

/**
 * 所有下载/上传/人工导出的原文件统一从这里进入 EvidenceStore。
 * 该入口不解析也不生成 ProductFact；调用方必须先完成对应 provider parser，
 * 再以同一个 subjectKey 保存 raw artifact，保证原文件与结构化 Evidence 可回放。
 */
export async function persistRawArtifact(input: RawArtifactIntakeInput): Promise<{
  artifact: SourceRawArtifact;
  created: boolean;
  duplicate: boolean;
  inspection: ReturnType<typeof inspectRawArtifact>;
}> {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const inspection = inspectRawArtifact({
    fileName: input.fileName,
    bytes: input.bytes,
    contentType: input.contentType,
  });
  const artifact = buildSourceRawArtifact({
    subjectKey: input.subjectKey,
    sourceType: input.sourceType,
    kind: input.kind,
    capturedAt,
    fileName: input.fileName,
    contentType: input.contentType,
    bytes: input.bytes,
    provenance: input.provenance,
  });
  const operator = sourceLayerOperator(input.context);
  const store = input.store ?? createEvidenceStore(operator);
  if (!store.appendRawArtifact) throw new Error("RAW_ARTIFACT_STORE_UNSUPPORTED");
  const result = await store.appendRawArtifact({
    artifact,
    bytes: input.bytes,
    operator,
    now: new Date(capturedAt),
  });
  return { artifact: result.artifact, created: result.created, duplicate: result.duplicate, inspection };
}
