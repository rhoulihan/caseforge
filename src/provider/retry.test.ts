import { describe, it, expect } from 'vitest';
import { withRetry } from './retry';
import { ProviderError } from './errors';

const cfg = { maxRetries: 2, baseDelayMs: 500 };

function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

function rateLimit(retryAfterMs?: number) {
  return new ProviderError({
    kind: 'rate_limit',
    provider: 'claude',
    message: 'slow down',
    retryable: true,
    retryAfterMs,
  });
}

describe('withRetry', () => {
  it('returns the result without sleeping when the first call succeeds', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      cfg,
      sleep,
    );
    expect(out).toBe('ok');
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries a retryable error then succeeds, backing off exponentially', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw rateLimit();
        return 'ok';
      },
      cfg,
      sleep,
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([500, 1000]); // base*2^0, base*2^1
  });

  it('honors retryAfterMs over the computed backoff', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw rateLimit(7000);
        return 'ok';
      },
      cfg,
      sleep,
    );
    expect(delays).toEqual([7000]);
  });

  it('does not retry a non-retryable error', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const bad = new ProviderError({
      kind: 'invalid_request',
      provider: 'openai',
      message: 'bad',
      retryable: false,
    });
    await expect(
      withRetry(
        async () => {
          calls++;
          throw bad;
        },
        cfg,
        sleep,
      ),
    ).rejects.toBe(bad);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('exhausts retries and rethrows the last error', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw rateLimit();
        },
        cfg,
        sleep,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(3); // initial + 2 retries
    expect(delays).toEqual([500, 1000]);
  });

  it('throws immediately without calling fn when the signal is already aborted', async () => {
    const { delays, sleep } = recordingSleep();
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return 'ok';
        },
        cfg,
        sleep,
        ctrl.signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(0);
    expect(delays).toEqual([]);
  });

  it('does not sleep/retry once the signal aborts mid-flight; rethrows the last error', async () => {
    const { delays, sleep } = recordingSleep();
    const ctrl = new AbortController();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          ctrl.abort(); // abort during the first (failing) attempt
          throw rateLimit();
        },
        cfg,
        sleep,
        ctrl.signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(1); // not retried
    expect(delays).toEqual([]); // no backoff slept
  });

  it('rethrows a non-ProviderError immediately without retrying', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const boom = new Error('unexpected');
    await expect(
      withRetry(
        async () => {
          calls++;
          throw boom;
        },
        cfg,
        sleep,
      ),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
});
