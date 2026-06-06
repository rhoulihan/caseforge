// Typed provider errors + API-key redaction. A leaked key in an error message or log is
// the security failure mode for a BYO-key browser app, so redaction is a tested invariant.

import type { ProviderName } from './types';

/** A ProviderError can originate at the HTTP/transport layer ('http') before a specific provider is involved. */
export type ErrorOrigin = ProviderName | 'http';

export type ProviderErrorKind =
  | 'auth' // 401/403 — bad or unauthorized key
  | 'rate_limit' // 429
  | 'invalid_request' // 400 — malformed request (our bug; not retryable)
  | 'server' // >=500
  | 'network' // fetch threw (offline, DNS, CORS)
  | 'unknown';

/** Map an HTTP status to an error kind. */
export function classifyStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  if (status >= 500) return 'server';
  return 'unknown';
}

// Matches OpenAI (sk-…, sk-proj-…, sk-svcacct-…) and Anthropic (sk-ant-…) key shapes.
const KEY_SHAPE = /sk-[A-Za-z0-9_-]{4,}/g;

/**
 * Remove an API key from text before it is surfaced in an error or log.
 * Strips the exact key first, then any sk-/sk-ant-/sk-proj-shaped token defensively.
 */
export function redactKey(text: string, key?: string): string {
  let out = text;
  if (key) out = out.split(key).join('***');
  return out.replace(KEY_SHAPE, '***');
}

export interface ProviderErrorInit {
  kind: ProviderErrorKind;
  provider: ErrorOrigin;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  /** The key to scrub from `message` (the constructor redacts it). */
  apiKey?: string;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ErrorOrigin;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(init: ProviderErrorInit) {
    super(redactKey(init.message, init.apiKey));
    this.name = 'ProviderError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.retryable = init.retryable;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
  }
}
