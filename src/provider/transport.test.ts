import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchTransport } from './transport';
import { ProviderError } from './errors';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const req = {
  url: 'https://api.example.com/v1/x',
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
  body: '{"hello":"world"}',
};

describe('fetchTransport', () => {
  it('forwards method, url, headers, and body to fetch and returns {status, body}', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;

    const res = await fetchTransport(req);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(req.url);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(req.body);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('returns non-2xx responses as-is (the parser classifies them)', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"nope"}', { status: 429 })) as unknown as typeof fetch;
    const res = await fetchTransport(req);
    expect(res.status).toBe(429);
    expect(res.body).toContain('nope');
  });

  it('maps a fetch TypeError (offline/CORS) to a retryable network ProviderError mentioning CORS', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(fetchTransport(req)).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
    await expect(fetchTransport(req)).rejects.toBeInstanceOf(ProviderError);
    await expect(fetchTransport(req)).rejects.toThrow(/CORS/i);
  });

  it('passes an AbortSignal through to fetch', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    const ctrl = new AbortController();
    await fetchTransport(req, ctrl.signal);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(ctrl.signal);
  });
});
