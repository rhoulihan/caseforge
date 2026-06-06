// Deterministic exponential backoff. No Math.random jitter — this is a single-user local
// app, so a fixed schedule is fine and keeps tests reproducible. `sleep` is injected so
// tests assert the delay schedule without real timers.

import { ProviderError } from './errors';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying only retryable ProviderErrors up to `maxRetries` times.
 * Delay is `retryAfterMs` if the error carries one, else `baseDelayMs * 2**attempt`.
 * Non-retryable ProviderErrors and any non-ProviderError throw immediately.
 * If `signal` aborts, we never start a new attempt and never sleep a pending backoff —
 * the in-flight request is cancelled by the transport, which holds the same signal.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig,
  sleep: Sleep = realSleep,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) {
      throw new ProviderError({
        kind: 'unknown',
        provider: 'http',
        retryable: false,
        message: 'request aborted',
      });
    }
    try {
      return await fn();
    } catch (err) {
      const isRetryable = err instanceof ProviderError && err.retryable;
      if (!isRetryable || attempt >= cfg.maxRetries || signal?.aborted) throw err;
      const delay = err.retryAfterMs ?? cfg.baseDelayMs * 2 ** attempt;
      await sleep(delay);
      attempt++;
    }
  }
}
