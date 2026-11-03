import { describe, expect, it } from "vitest";
import {
  classifyRedditIdentity,
  extractOwnerExperience,
  opaqueRedditAuthorRef,
  parseVisibleRedditCommentTree,
  parseVisibleRedditCount,
  parseVisibleRedditPostCard,
  safeRedditSearchNextHref,
  shouldExpandRedditComments,
} from "@/lib/server/redditVisibleParser";

describe("Reddit visible DOM parser fixtures", () => {
  it("preserves post metadata and nested comment identity, parent, thread, and bounded depth", () => {
    const post = parseVisibleRedditPostCard({
      title: "Insulated Trail Bottle review",
      body: "The cap leaked during a hike.",
      permalink: "/r/outdoors/comments/abc123/insulated_trail_bottle_review/",
      publishedAt: "2026-09-20T10:30:00Z",
      authorRef: opaqueRedditAuthorRef("visible-user", "capture-1"),
      score: 14,
      commentCount: 3,
    });
    expect(post).toMatchObject({
      externalContentId: "abc123",
      sourceUrl: "https://www.reddit.com/r/outdoors/comments/abc123/insulated_trail_bottle_review/",
      subreddit: "outdoors",
      publishedAt: "2026-09-20T10:30:00.000Z",
      authorRef: expect.stringMatching(/^anon:[a-f0-9]{24}$/u),
      score: 14,
      commentCount: 3,
    });
    const comments = parseVisibleRedditCommentTree({
      threadId: post!.externalContentId,
      subreddit: post!.subreddit,
      comments: [
        { externalContentId: "t1_root", parentId: "t3_abc123", text: "I bought one and used it for 4 months.", permalink: "/r/outdoors/comments/abc123/title/root/", score: 2 },
        { externalContentId: "t1_reply", parentId: "t1_root", text: "Mine cracked after 2 weeks.", permalink: "/r/outdoors/comments/abc123/title/reply/", score: 1 },
        { externalContentId: "t1_deep", parentId: "t1_reply", text: "A nested response.", permalink: null },
        { externalContentId: "t1_duplicate", parentId: "t1_root", text: "duplicate DOM node", permalink: null },
        { externalContentId: "t1_too_deep", parentId: "t1_deep", depth: 7, text: "outside bound", permalink: null },
        { externalContentId: "t1_duplicate", parentId: "t1_root", text: "second duplicate node", permalink: null },
      ],
      maxDepth: 2,
    });
    expect(comments).toEqual([
      expect.objectContaining({ externalContentId: "root", parentContentId: "abc123", threadId: "abc123", subreddit: "outdoors", depth: 0, score: 2 }),
      expect.objectContaining({ externalContentId: "reply", parentContentId: "root", threadId: "abc123", subreddit: "outdoors", depth: 1, score: 1 }),
      expect.objectContaining({ externalContentId: "deep", parentContentId: "reply", depth: 2 }),
      expect.objectContaining({ externalContentId: "duplicate", parentContentId: "root", depth: 1 }),
    ]);
  });

  it("uses salted opaque author refs, exact visible counts only, and normal same-query pagination", () => {
    const ref = opaqueRedditAuthorRef("u/private-handle", "capture-salt");
    expect(ref).toMatch(/^anon:[a-f0-9]{24}$/u);
    expect(ref).not.toContain("private-handle");
    expect(opaqueRedditAuthorRef("u/private-handle", "another-capture")).not.toBe(ref);
    expect(parseVisibleRedditCount("1,234 points")).toBe(1234);
    expect(parseVisibleRedditCount("-2")).toBe(-2);
    expect(parseVisibleRedditCount("1.2k")).toBeNull();
    expect(parseVisibleRedditCount("about 20 comments")).toBeNull();
    const current = "https://www.reddit.com/search/?q=trail+bottle&type=link";
    expect(safeRedditSearchNextHref("/search/?q=trail+bottle&type=link&after=t3_abc", current, "trail bottle"))
      .toBe("https://www.reddit.com/search/?q=trail+bottle&type=link&after=t3_abc");
    expect(safeRedditSearchNextHref("https://example.com/search/?q=trail+bottle&type=link", current, "trail bottle")).toBeNull();
    expect(safeRedditSearchNextHref("/search/?q=other&type=link", current, "trail bottle")).toBeNull();
  });

  it("honors visible comment expansion and keeps identity/ownership inference conservative", () => {
    expect(shouldExpandRedditComments("View more comments", true)).toBe(true);
    expect(shouldExpandRedditComments("View more comments", false)).toBe(false);
    expect(shouldExpandRedditComments("Sign in", true)).toBe(false);
    expect(classifyRedditIdentity("This listing mentions B07G4VTV2F directly.", "B07G4VTV2F", "Bottle product title here")).toBe("EXACT");
    expect(classifyRedditIdentity("The code B07G4VTV2FX is not an exact match.", "B07G4VTV2F", "Bottle product title here")).toBe("UNRESOLVED");
    expect(classifyRedditIdentity("I own this bottle product title here.", "B07G4VTV2F", "Bottle product title here")).toBe("PROBABLE");
    expect(classifyRedditIdentity("Unrelated generic bottle discussion.", "B07G4VTV2F", "Insulated Trail Bottle 32oz Hiking Flask")).toBe("UNRESOLVED");
    expect(extractOwnerExperience("I bought this and after 4 months it cracked on a hike.")).toMatchObject({
      claimedOwnership: true,
      ownershipDuration: "4 months",
      failureMode: "cracked on a hike",
      timeToFailure: "4 months",
    });
    expect(extractOwnerExperience("People say the bottle is durable.")).toBeNull();
  });

  it("rejects non-Reddit links instead of turning arbitrary page links into evidence", () => {
    expect(parseVisibleRedditPostCard({ title: "x", body: "body", permalink: "https://example.com/r/outdoors/comments/abc/title" })).toBeNull();
  });
});
