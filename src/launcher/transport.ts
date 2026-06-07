// Browser transport for the launcher endpoints. Same-origin in production (the launcher serves the
// built SPA); in dev, the Vite proxy forwards the launcher routes to the launcher origin. fetch is
// injectable so the client is unit-testable offline. Adds binary PUT/GET + DELETE for archive .zip
// blobs (a longer timeout — archives carry source docs + images, not just text).

const META_ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
export const LAUNCHER_ORIGIN = META_ENV?.VITE_LAUNCHER_ORIGIN ?? '';

export interface LauncherResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface BinaryResponse {
  status: number;
  bytes(): Promise<Uint8Array>;
}

export interface LauncherTransport {
  post(path: string, body: unknown): Promise<LauncherResponse>;
  get(path: string): Promise<LauncherResponse>;
  putBinary(path: string, bytes: Uint8Array): Promise<LauncherResponse>;
  getBytes(path: string): Promise<BinaryResponse>;
  del(path: string): Promise<LauncherResponse>;
}

/**
 * Default transport over `fetch`. `origin` defaults to LAUNCHER_ORIGIN ('' = same-origin / Vite
 * proxy). A per-request AbortController enforces a timeout — `timeoutMs` for JSON, the larger
 * `binaryTimeoutMs` for archive blobs.
 */
export function fetchTransport(origin: string = LAUNCHER_ORIGIN, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000, binaryTimeoutMs = 120_000): LauncherTransport {
  const raw = async (path: string, init: RequestInit, ms: number): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetchImpl(origin + path, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const asJson = (res: Response): LauncherResponse => ({ status: res.status, json: () => res.json() });
  return {
    post: async (path, body) => asJson(await raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs)),
    get: async (path) => asJson(await raw(path, { method: 'GET' }, timeoutMs)),
    putBinary: async (path, bytes) => asJson(await raw(path, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: new Blob([new Uint8Array(bytes)]) }, binaryTimeoutMs)),
    getBytes: async (path) => {
      // The timeout must also cover the BODY read (a stalled stream after headers must still abort),
      // so we keep the controller/timer alive until bytes() resolves rather than clearing it on headers.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), binaryTimeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(origin + path, { method: 'GET', signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
      return {
        status: res.status,
        bytes: async () => {
          try {
            return new Uint8Array(await res.arrayBuffer());
          } finally {
            clearTimeout(timer);
          }
        },
      };
    },
    del: async (path) => asJson(await raw(path, { method: 'DELETE' }, timeoutMs)),
  };
}
