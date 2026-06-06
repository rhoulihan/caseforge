// The HTTP seam. Adapters depend on a `Transport`, not on `fetch`, so tests inject a mock
// transport and assert the exact request shape with zero network. `fetchTransport` is the
// thin real implementation; it maps a thrown fetch TypeError (offline/DNS/CORS) to a
// retryable network ProviderError.

import { ProviderError } from './errors';

export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type Transport = (req: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>;

export const fetchTransport: Transport = async (req, signal) => {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal,
    });
  } catch {
    // fetch rejects with a TypeError for network failures, including CORS rejections —
    // common when calling a provider directly from the browser.
    throw new ProviderError({
      kind: 'network',
      provider: 'http',
      retryable: true,
      message:
        'Network request failed (offline, DNS, or a CORS restriction). When calling a provider directly from the browser, the endpoint must allow cross-origin requests (CORS).',
    });
  }
  return { status: res.status, body: await res.text() };
};
