/** Review session retries are deliberately bounded and always close before recreation. */
export const MAX_REVIEW_FRESH_SESSION_ATTEMPTS = 3 as const;

export async function runFreshReviewSessionAttempts<TSession, TResult>(input: {
  createSession(attempt: number): Promise<TSession>;
  runAttempt(session: TSession, attempt: number): Promise<TResult>;
  shouldRetry(result: TResult): boolean;
  isHumanRequired(result: TResult): boolean;
  closeSession(session: TSession): Promise<void>;
  /** Number of attempts available in this invocation after prior runs. */
  maxAttempts?: number;
  /** Attempts already consumed for this ASIN; attempt callbacks remain cumulative. */
  attemptOffset?: number;
}): Promise<{ result: TResult | null; attempts: number; humanRequired: boolean }> {
  let result: TResult | null = null;
  let attempts = 0;
  let humanRequired = false;
  const attemptOffset = Number.isSafeInteger(input.attemptOffset)
    ? Math.min(MAX_REVIEW_FRESH_SESSION_ATTEMPTS, Math.max(0, input.attemptOffset as number))
    : 0;
  const requestedAttempts = input.maxAttempts === undefined
    ? MAX_REVIEW_FRESH_SESSION_ATTEMPTS
    : Number.isSafeInteger(input.maxAttempts)
      ? Math.max(0, input.maxAttempts)
      : 0;
  const maxAttempts = Math.min(
    MAX_REVIEW_FRESH_SESSION_ATTEMPTS - attemptOffset,
    requestedAttempts,
  );

  for (let attempt = attemptOffset + 1; attempt <= attemptOffset + maxAttempts; attempt += 1) {
    const session = await input.createSession(attempt);
    attempts += 1;
    let currentResult: TResult;
    try {
      currentResult = await input.runAttempt(session, attempt);
    } finally {
      // If close fails, fail closed and do not create another browser session.
      await input.closeSession(session);
    }

    result = currentResult;
    if (input.isHumanRequired(currentResult)) {
      humanRequired = true;
      break;
    }
    if (!input.shouldRetry(currentResult)) break;
  }

  return { result, attempts, humanRequired };
}
