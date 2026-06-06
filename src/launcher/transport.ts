// Browser transport for the launcher endpoints. Same-origin in production (the launcher serves the
// built SPA); in dev, the Vite proxy forwards /anonymize//deanonymize//health to the launcher origin.
// fetch is injectable so the client is unit-testable offline.

const META_ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
export const LAUNCHER_ORIGIN = META_ENV?.VITE_LAUNCHER_ORIGIN ?? '';

export interface LauncherResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface LauncherTransport {
  post(path: string, body: unknown): Promise<LauncherResponse>;
  get(path: string): Promise<LauncherResponse>;
}

/**
 * Default transport over `fetch`. `origin` defaults to LAUNCHER_ORIGIN ('' = same-origin / Vite
 * proxy). A per-request AbortController enforces `timeoutMs`.
 */
export function fetchTransport(origin: string = LAUNCHER_ORIGIN, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): LauncherTransport {
  const send = async (path: string, init: RequestInit): Promise<LauncherResponse> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(origin + path, { ...init, signal: ctrl.signal });
      return { status: res.status, json: () => res.json() };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    post: (path, body) => send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    get: (path) => send(path, { method: 'GET' }),
  };
}
