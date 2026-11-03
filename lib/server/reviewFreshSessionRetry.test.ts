import { describe, expect, it, vi } from "vitest";

import {
  MAX_REVIEW_FRESH_SESSION_ATTEMPTS,
  runFreshReviewSessionAttempts,
} from "./reviewFreshSessionRetry";

describe("fresh Review session retry", () => {
  it("closes each isolated session before creating the next and stops when extraction succeeds", async () => {
    const events: string[] = [];
    const result = await runFreshReviewSessionAttempts({
      createSession: async (attempt) => {
        events.push(`create:${attempt}`);
        return { attempt };
      },
      runAttempt: async (session: { attempt: number }) => {
        events.push(`run:${session.attempt}`);
        return { status: session.attempt < 3 ? "extraction_empty" : "captured" };
      },
      shouldRetry: (attempt) => attempt.status === "extraction_empty",
      isHumanRequired: () => false,
      closeSession: async (session: { attempt: number }) => { events.push(`close:${session.attempt}`); },
    });

    expect(result).toEqual({ result: { status: "captured" }, attempts: 3, humanRequired: false });
    expect(events).toEqual([
      "create:1", "run:1", "close:1",
      "create:2", "run:2", "close:2",
      "create:3", "run:3", "close:3",
    ]);
  });

  it("never exceeds the fixed retry cap", async () => {
    const runAttempt = vi.fn(async () => ({ status: "extraction_empty" }));
    const result = await runFreshReviewSessionAttempts({
      createSession: async (attempt) => ({ attempt }),
      runAttempt,
      shouldRetry: () => true,
      isHumanRequired: () => false,
      closeSession: async () => undefined,
    });

    expect(MAX_REVIEW_FRESH_SESSION_ATTEMPTS).toBe(3);
    expect(runAttempt).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
  });

  it("uses a cumulative attempt number and consumes only the remaining budget", async () => {
    const attempts: number[] = [];
    const result = await runFreshReviewSessionAttempts({
      createSession: async (attempt) => ({ attempt }),
      runAttempt: async (_session, attempt) => {
        attempts.push(attempt);
        return { status: "extraction_empty" };
      },
      shouldRetry: () => true,
      isHumanRequired: () => false,
      closeSession: async () => undefined,
      maxAttempts: 2,
      attemptOffset: 1,
    });

    expect(attempts).toEqual([2, 3]);
    expect(result).toMatchObject({ attempts: 2, humanRequired: false, result: { status: "extraction_empty" } });
  });

  it("creates no fresh sessions when the cumulative budget is exhausted", async () => {
    const createSession = vi.fn(async () => ({}));
    const result = await runFreshReviewSessionAttempts({
      createSession,
      runAttempt: async () => ({ status: "extraction_empty" }),
      shouldRetry: () => true,
      isHumanRequired: () => false,
      closeSession: async () => undefined,
      maxAttempts: 0,
      attemptOffset: MAX_REVIEW_FRESH_SESSION_ATTEMPTS,
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(result).toEqual({ result: null, attempts: 0, humanRequired: false });
  });

  it("stops and closes the current session at a human gate", async () => {
    const runAttempt = vi.fn(async () => ({ status: "captcha_required" }));
    const closeSession = vi.fn(async () => undefined);
    const result = await runFreshReviewSessionAttempts({
      createSession: async (attempt) => ({ attempt }),
      runAttempt,
      shouldRetry: () => true,
      isHumanRequired: (attempt) => attempt.status === "captcha_required",
      closeSession,
    });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempts: 1, humanRequired: true, result: { status: "captcha_required" } });
  });
});
