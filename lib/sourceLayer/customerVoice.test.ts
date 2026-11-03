import { describe, expect, it } from "vitest";

import {
  buildCustomerVoiceAttachmentPayload,
  buildCustomerVoiceObservation,
  parseCustomerVoiceAttachmentPayload,
  parseCustomerVoiceObservation,
} from "@/lib/sourceLayer/customerVoice";
import {
  buildSourceEvidenceAttachment,
  parseSourceEvidenceAttachment,
  sourceEvidenceAttachmentIdFor,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";

const SUBJECT_KEY = "amazon:US:B07G4VTV2F";
const RAW_ID = `raw-${"a".repeat(24)}`;

function amazonReview() {
  return buildCustomerVoiceObservation({
    source: "amazon_review",
    subjectKey: SUBJECT_KEY,
    externalContentId: "amazon-review-opaque-id",
    parentContentId: null,
    threadId: null,
    contentType: "review",
    authorRef: null,
    capturedAt: "2026-09-27T00:00:00.000Z",
    publishedAt: "2026-09-20T00:00:00.000Z",
    title: "Still useful after daily use",
    text: "The bottle keeps water cold through my commute.",
    rating: 5,
    verifiedPurchase: true,
    engagement: null,
    sourceUrl: "https://www.amazon.com/dp/B07G4VTV2F",
    evidenceRefs: ["attachment:att-source-review"],
    provenance: {
      provider: "amazon_dom",
      method: "capture_v3_amazon_review",
      accessBasis: "first_party_visible_page",
      sourceAttachmentId: "att-source-review",
      rawArtifactId: null,
      providerTermsVersion: null,
    },
    retentionPolicy: "source_evidence_default",
    deletionRequired: false,
    externalDeletedAt: null,
    identityMatch: "EXACT",
    ownerExperience: null,
  });
}

function redditComment() {
  return buildCustomerVoiceObservation({
    source: "reddit_comment",
    subjectKey: SUBJECT_KEY,
    externalContentId: "t1_comment123",
    parentContentId: "t1_parent456",
    threadId: "t3_post789",
    contentType: "comment",
    authorRef: "anon:0123456789abcdef01234567",
    capturedAt: "2026-09-27T00:00:00.000Z",
    publishedAt: null,
    title: null,
    text: "I have owned this for six months and use it on hikes.",
    rating: null,
    verifiedPurchase: null,
    engagement: { score: 3, commentCount: null },
    sourceUrl: "https://www.reddit.com/r/example/comments/post789/thread/comment123/",
    evidenceRefs: [`rawArtifact:${RAW_ID}`],
    provenance: {
      provider: "reddit_browser",
      method: "public_reddit_browser",
      accessBasis: "public_visible_page",
      sourceAttachmentId: null,
      rawArtifactId: RAW_ID,
      providerTermsVersion: null,
    },
    retentionPolicy: "source_evidence_default",
    deletionRequired: false,
    externalDeletedAt: null,
    identityMatch: "FAMILY",
    ownerExperience: {
      claimedOwnership: true,
      ownershipDuration: "six months",
      useCase: "use it on hikes",
      failureMode: null,
      timeToFailure: null,
      replacementProduct: null,
      switchReason: null,
    },
  });
}

describe("CustomerVoiceObservation and EvidenceStore attachment contract", () => {
  it("normalizes Amazon review fields without losing source attachment provenance", () => {
    const observation = amazonReview();
    expect(observation).toMatchObject({
      source: "amazon_review",
      rating: 5,
      verifiedPurchase: true,
      evidenceRefs: ["attachment:att-source-review"],
      provenance: { sourceAttachmentId: "att-source-review", method: "capture_v3_amazon_review" },
    });
    expect(parseCustomerVoiceObservation(observation)).toEqual(observation);
  });

  it("retains ratings and verified-purchase claims from a user-supplied review file with manual provenance", () => {
    const observation = buildCustomerVoiceObservation({
      source: "manual_voc",
      subjectKey: SUBJECT_KEY,
      externalContentId: "manual-import-row-1",
      parentContentId: null,
      threadId: null,
      contentType: "review",
      authorRef: null,
      capturedAt: "2026-09-27T00:00:00.000Z",
      publishedAt: null,
      title: "CSV review",
      text: "The lid cracked after a few weeks.",
      rating: 2,
      verifiedPurchase: true,
      engagement: null,
      sourceUrl: null,
      evidenceRefs: [`rawArtifact:${RAW_ID}`],
      provenance: {
        provider: "manual_import",
        method: "manual_import",
        accessBasis: "user_supplied_file",
        sourceAttachmentId: null,
        rawArtifactId: RAW_ID,
        providerTermsVersion: null,
      },
      retentionPolicy: null,
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: "UNRESOLVED",
      ownerExperience: null,
    });
    expect(observation).toMatchObject({ source: "manual_voc", rating: 2, verifiedPurchase: true, identityMatch: "UNRESOLVED" });
  });

  it("keeps direct manual notes distinct from first-party or imported-file observations", () => {
    const observation = buildCustomerVoiceObservation({
      source: "manual_voc",
      subjectKey: SUBJECT_KEY,
      externalContentId: "manual-note-1",
      parentContentId: null,
      threadId: null,
      contentType: "review",
      authorRef: null,
      capturedAt: "2026-09-27T00:00:00.000Z",
      publishedAt: null,
      title: null,
      text: "Owner note from a customer interview.",
      rating: null,
      verifiedPurchase: null,
      engagement: null,
      sourceUrl: null,
      evidenceRefs: [`rawArtifact:${RAW_ID}`],
      provenance: {
        provider: "manual_import",
        method: "manual_import",
        accessBasis: "user_supplied_text",
        sourceAttachmentId: null,
        rawArtifactId: RAW_ID,
        providerTermsVersion: null,
      },
      retentionPolicy: null,
      deletionRequired: false,
      externalDeletedAt: null,
      identityMatch: "UNRESOLVED",
      ownerExperience: null,
    });
    expect(parseCustomerVoiceObservation(observation)?.provenance.accessBasis).toBe("user_supplied_text");
  });

  it("persists a Reddit comment in the formal attachment kind and preserves its reply tree", () => {
    const observation = redditComment();
    const payload = buildCustomerVoiceAttachmentPayload({ subjectKey: SUBJECT_KEY, observations: [observation] });
    const draft = buildSourceEvidenceAttachment({
      attachmentId: "pending",
      subjectKey: SUBJECT_KEY,
      kind: "customer_voice_observation_v1",
      sourceType: "browser_agent",
      capturedAt: observation.capturedAt,
      sourceUrl: observation.sourceUrl,
      payload: payload as unknown as Record<string, unknown>,
    });
    const attachment: SourceEvidenceAttachment = buildSourceEvidenceAttachment({
      ...draft,
      attachmentId: sourceEvidenceAttachmentIdFor(draft.contentHash),
    });
    expect(parseSourceEvidenceAttachment(attachment)).toEqual(attachment);
    expect(parseCustomerVoiceAttachmentPayload(attachment.payload, SUBJECT_KEY)?.observations[0]).toMatchObject({
      externalContentId: "t1_comment123",
      parentContentId: "t1_parent456",
      threadId: "t3_post789",
      rating: null,
      verifiedPurchase: null,
      ownerExperience: { claimedOwnership: true, ownershipDuration: "six months" },
    });
  });

  it("rejects mismatched provenance, Reddit ratings, and duplicate content identities", () => {
    const observation = redditComment();
    expect(parseCustomerVoiceObservation({ ...observation, rating: 5 })).toBeNull();
    expect(parseCustomerVoiceObservation({
      ...observation,
      provenance: { ...observation.provenance, provider: "amazon_dom" },
    })).toBeNull();
    expect(parseCustomerVoiceAttachmentPayload({
      schemaVersion: "customer-voice-observation-attachment.v1",
      subjectKey: SUBJECT_KEY,
      observations: [observation, observation],
    }, SUBJECT_KEY)).toBeNull();
    expect(parseCustomerVoiceAttachmentPayload({
      schemaVersion: "customer-voice-observation-attachment.v1",
      subjectKey: SUBJECT_KEY,
      observations: [observation, amazonReview()],
    }, SUBJECT_KEY)).toBeNull();
  });
});
