import { describe, expect, it } from "vitest";
import {
  SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";
import { buildV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import { projectVariationEvidence } from "@/lib/server/research/variationEvidenceProjection";

const SUBJECT_ASIN = "B0CHILD001";
const PARENT_ASIN = "B0PARENT01";
const PEER_ASIN = "B0PEER0001";
const CHILD_TWO_ASIN = "B0CHILD002";
const subjectKey = (asin: string) => `amazon:US:${asin}`;

function variationAttachment(input: {
  asin?: string;
  parentAsin?: string | null;
  memberAsins?: string[];
  outcome?: string;
  capturedAt?: string;
  identityBound?: boolean;
  currentAsin?: string;
  pageAsin?: string;
} = {}): SourceEvidenceAttachment {
  const asin = input.asin ?? SUBJECT_ASIN;
  const outcome = input.outcome ?? "COMPLETE";
  const capturedAt = input.capturedAt ?? "2026-10-07T07:00:00.000Z";
  const parentAsin = input.parentAsin === undefined ? PARENT_ASIN : input.parentAsin;
  const memberAsins = input.memberAsins ?? [asin, PEER_ASIN];
  const isComplete = outcome === "COMPLETE";
  const isPartial = outcome === "CAPTURED_PARTIAL";
  const isNoVariation = outcome === "NO_DATA_WITH_EVIDENCE";
  const isHuman = outcome === "FAILED_HUMAN";
  const isRetryable = outcome === "FAILED_RETRYABLE";
  const limitations = isComplete ? [] : [
    isPartial ? "variation_mapping_incomplete"
      : isNoVariation ? "no_variation_with_evidence"
        : isHuman ? "variation_requires_human"
          : "variation_page_identity_not_bound",
  ];
  const payload = buildV3ModuleEvidence({
    module: "variation",
    subjectKey: subjectKey(asin),
    marketplace: "US",
    capturedAt,
    provider: "Amazon",
    sourceSurface: "Amazon product detail variation JSON and DOM",
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    acquisitionMode: "DOM_DIRECT",
    metricNature: "source_observed",
    status: isComplete ? "VALIDATED_AVAILABLE"
      : isPartial || isNoVariation ? "AVAILABLE_WITH_LIMITATION"
        : isHuman ? "HUMAN_ACTION_REQUIRED" : "BLOCKED_WITH_EVIDENCE",
    limitations,
    identity: { asin, ...(parentAsin ? { parentAsin } : {}) },
    data: {
      outcome,
      variationStatus: isComplete ? "COMPLETE"
        : isPartial ? "CAPTURED_PARTIAL"
          : isNoVariation ? "NO_VARIATION_WITH_EVIDENCE"
            : isHuman ? "HUMAN_REQUIRED" : "PAGE_CHANGED",
      currentAsin: input.currentAsin ?? asin,
      parentAsin,
      variantAsins: memberAsins,
      variants: memberAsins.map((memberAsin, index) => ({
        asin: memberAsin,
        options: isNoVariation || isHuman || isRetryable ? [] : [{
          dimensionKey: "size",
          label: "Size",
          value: index === 0 ? "Small" : "Large",
        }],
      })),
      identityProof: {
        urlAsin: asin,
        pageAsin: input.pageAsin ?? asin,
        productContainerFound: true,
        bound: input.identityBound ?? (isComplete || isPartial || isNoVariation),
      },
      error: isHuman
        ? { code: "HUMAN_ACTION_REQUIRED", retryable: false }
        : isRetryable ? { code: "VARIATION_PAGE_CHANGED", retryable: true } : null,
    },
    evidenceOnly: true,
  });
  return {
    schemaVersion: SOURCE_EVIDENCE_ATTACHMENT_SCHEMA,
    attachmentId: `variation-${asin}-${outcome}-${capturedAt}`,
    subjectKey: subjectKey(asin),
    kind: "v3_variation_v1",
    sourceType: "amazon_dom",
    capturedAt,
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    sourceFingerprint: `variation:${asin}:${capturedAt}`,
    contentHash: "a".repeat(64),
    payload: payload as unknown as Record<string, unknown>,
  };
}

function withData(
  attachment: SourceEvidenceAttachment,
  dataChanges: Record<string, unknown>,
): SourceEvidenceAttachment {
  const payload = attachment.payload;
  const data = payload.data as Record<string, unknown>;
  return {
    ...attachment,
    payload: { ...payload, data: { ...data, ...dataChanges } },
  };
}

describe("Variation evidence research projection", () => {
  it("projects a child ASIN parent edge and peer edges with per-edge evidence refs", () => {
    const attachment = variationAttachment({ asin: SUBJECT_ASIN, parentAsin: PARENT_ASIN, memberAsins: [SUBJECT_ASIN, PEER_ASIN] });

    const result = projectVariationEvidence([attachment], subjectKey(SUBJECT_ASIN));

    expect(result).toMatchObject({
      outcome: "complete",
      completeness: "complete",
      subjectAsin: SUBJECT_ASIN,
      parentAsin: PARENT_ASIN,
      memberAsins: [SUBJECT_ASIN, PEER_ASIN],
    });
    expect(result.relations.map(({ fromAsin, toAsin, relation }) => ({ fromAsin, toAsin, relation }))).toEqual([
      { fromAsin: SUBJECT_ASIN, toAsin: PARENT_ASIN, relation: "parent" },
      { fromAsin: SUBJECT_ASIN, toAsin: PEER_ASIN, relation: "peer" },
    ]);
    expect(result.relations.every((relation) => relation.evidenceRefs[0]?.refId === `attachment:${attachment.attachmentId}`)).toBe(true);
    expect(result.members.every((member) => member.evidenceRefs[0]?.contentHash === attachment.contentHash)).toBe(true);
  });

  it("projects children when the current ASIN is the family parent", () => {
    const attachment = variationAttachment({
      asin: PARENT_ASIN,
      parentAsin: PARENT_ASIN,
      memberAsins: [PARENT_ASIN, SUBJECT_ASIN, CHILD_TWO_ASIN],
    });

    const result = projectVariationEvidence([attachment], subjectKey(PARENT_ASIN));

    expect(result.outcome).toBe("complete");
    expect(result.relations.map(({ toAsin, relation }) => ({ toAsin, relation }))).toEqual([
      { toAsin: SUBJECT_ASIN, relation: "child" },
      { toAsin: CHILD_TWO_ASIN, relation: "child" },
    ]);
  });

  it("preserves partial completeness and only uses identity-bound observed relations", () => {
    const attachment = variationAttachment({ outcome: "CAPTURED_PARTIAL" });

    const result = projectVariationEvidence([attachment], subjectKey(SUBJECT_ASIN));

    expect(result.outcome).toBe("partial");
    expect(result.completeness).toBe("partial");
    expect(result.limitation).toBe("variation_mapping_incomplete");
    expect(result.relations).toHaveLength(2);
  });

  it("returns evidence-backed no-variation without creating family relationships", () => {
    const attachment = variationAttachment({ outcome: "NO_DATA_WITH_EVIDENCE", parentAsin: null, memberAsins: [SUBJECT_ASIN] });

    const result = projectVariationEvidence([attachment], subjectKey(SUBJECT_ASIN));

    expect(result).toMatchObject({ outcome: "no_variation_with_evidence", completeness: "none", memberAsins: [SUBJECT_ASIN] });
    expect(result.relations).toEqual([]);
    expect(result.evidenceRefs).toHaveLength(1);
  });

  it("fails closed for missing, unknown, and identity-conflicting evidence", () => {
    const complete = variationAttachment();
    const missingOutcome = withData(complete, { outcome: undefined });
    const wrongCurrent = withData(complete, { currentAsin: PEER_ASIN });
    const wrongPage = variationAttachment({ pageAsin: PEER_ASIN });

    expect(projectVariationEvidence([], subjectKey(SUBJECT_ASIN)).outcome).toBe("missing");
    expect(projectVariationEvidence([missingOutcome], subjectKey(SUBJECT_ASIN)).outcome).toBe("unknown");
    expect(projectVariationEvidence([withData(complete, { outcome: "UNRECOGNIZED" })], subjectKey(SUBJECT_ASIN)).outcome).toBe("unknown");
    expect(projectVariationEvidence([wrongCurrent], subjectKey(SUBJECT_ASIN))).toMatchObject({ outcome: "identity_conflict", relations: [] });
    expect(projectVariationEvidence([wrongPage], subjectKey(SUBJECT_ASIN))).toMatchObject({ outcome: "identity_conflict", relations: [] });
  });

  it("does not mask a newer retryable failure with an older successful capture", () => {
    const older = variationAttachment({ capturedAt: "2026-10-06T07:00:00.000Z" });
    const latest = variationAttachment({ outcome: "FAILED_RETRYABLE", capturedAt: "2026-10-07T07:00:00.000Z" });

    const result = projectVariationEvidence([older, latest], subjectKey(SUBJECT_ASIN));

    expect(result).toMatchObject({ outcome: "retryable_failure", completeness: "unavailable", relations: [] });
    expect(result.evidenceRefs[0]?.captureId).toBe(latest.attachmentId);
  });

  it("rejects inconsistent capture status and outcome instead of projecting edges", () => {
    const complete = variationAttachment();
    const mismatched = withData(complete, { variationStatus: "CAPTURED_PARTIAL" });

    expect(projectVariationEvidence([mismatched], subjectKey(SUBJECT_ASIN))).toMatchObject({
      outcome: "status_conflict",
      completeness: "unavailable",
      relations: [],
    });
  });
});
