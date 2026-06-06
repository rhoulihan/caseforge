import { describe, it, expect } from 'vitest';
import { ProviderError, classifyStatus, redactKey } from './errors';

describe('classifyStatus', () => {
  it('maps HTTP status ranges to error kinds', () => {
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(403)).toBe('auth');
    expect(classifyStatus(429)).toBe('rate_limit');
    expect(classifyStatus(400)).toBe('invalid_request');
    expect(classifyStatus(500)).toBe('server');
    expect(classifyStatus(503)).toBe('server');
    expect(classifyStatus(418)).toBe('unknown');
  });
});

describe('redactKey', () => {
  it('removes every occurrence of the exact key', () => {
    const out = redactKey('header sk-ant-abc123 and again sk-ant-abc123', 'sk-ant-abc123');
    expect(out).not.toContain('sk-ant-abc123');
    expect(out).toContain('***');
  });
  it('also redacts sk-/sk-ant- shaped tokens defensively even if the key is unknown', () => {
    expect(redactKey('leaked sk-ant-api03-ZZZ99 here', '')).not.toContain('sk-ant-api03-ZZZ99');
    expect(redactKey('leaked sk-proj-ABC123def here', undefined)).not.toContain('sk-proj-ABC123def');
  });
  it('is a no-op when there is nothing to redact', () => {
    expect(redactKey('nothing secret here', 'sk-ant-xyz')).toBe('nothing secret here');
  });
});

describe('ProviderError', () => {
  it('carries kind/status/provider/retryable and redacts the passed apiKey from its message', () => {
    const key = 'sk-ant-secret-XYZ';
    const err = new ProviderError({
      kind: 'auth',
      status: 401,
      provider: 'claude',
      message: `401 unauthorized for key ${key}`,
      retryable: false,
      apiKey: key,
    });
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.provider).toBe('claude');
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(key);
    expect(String(err)).not.toContain(key);
  });

  it('redacts via the explicit apiKey path even when the key is NOT sk-shaped (regex would miss it)', () => {
    const key = 'CUSTOM-proxy-token-9f8e7d'; // does not match the sk- defensive regex
    const err = new ProviderError({
      kind: 'auth',
      provider: 'openai',
      message: `bad credentials: ${key}`,
      retryable: false,
      apiKey: key,
    });
    expect(err.message).not.toContain(key);
    expect(err.message).toContain('***');
  });

  it('marks rate_limit and server and network as retryable', () => {
    const mk = (kind: 'rate_limit' | 'server' | 'network' | 'auth') =>
      new ProviderError({ kind, provider: 'openai', message: 'x', retryable: kind !== 'auth' });
    expect(mk('rate_limit').retryable).toBe(true);
    expect(mk('server').retryable).toBe(true);
    expect(mk('network').retryable).toBe(true);
    expect(mk('auth').retryable).toBe(false);
  });

  it('carries an optional retryAfterMs hint', () => {
    const err = new ProviderError({
      kind: 'rate_limit',
      provider: 'claude',
      message: 'slow down',
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(err.retryAfterMs).toBe(2000);
  });
});
