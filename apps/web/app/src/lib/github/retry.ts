// ---------------------------------------------------------------------------
// withGitHubRetry — exponential-backoff wrapper for GitHub API calls.
//
// Retries on transient server-side failures (502, 503, 504) and on
// secondary-rate-limit 403 responses. Backoff schedule: 250ms, 500ms,
// 1000ms with ±30% jitter to avoid thundering-herd when GitHub retries a
// webhook delivery and we, in turn, retry our outbound calls. Anything
// that isn't clearly a retryable GitHub response rethrows immediately.
//
// Callers wrap GitHub fetches like:
//   const pr = await withGitHubRetry(() =>
//     getPullRequest(token, repo, number),
//   );
// ---------------------------------------------------------------------------

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 4;

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export async function withGitHubRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const retryable =
        status !== undefined && RETRYABLE_STATUSES.has(status);
      const rateLimited = status === 403 && isSecondaryRateLimit(err);

      if (!retryable && !rateLimited) throw err;
      if (attempt === MAX_ATTEMPTS - 1) throw err;

      const baseMs = 250 * Math.pow(2, attempt);
      const jitter = baseMs * 0.3 * (Math.random() * 2 - 1);
      await new Promise((r) => setTimeout(r, baseMs + jitter));
    }
  }
  throw lastErr;
}

function isSecondaryRateLimit(err: unknown): boolean {
  const msg = (err as { message?: string }).message ?? "";
  return msg.toLowerCase().includes("secondary rate limit");
}
