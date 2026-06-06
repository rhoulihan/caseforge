// Browser client for the launcher's anonymize/deanonymize/health endpoints. The map is serialized
// via buildMap (the single source of truth for case/whitespace/NFC variant expansion) so the
// launcher stays a dumb literal matcher. Errors surface as a typed LauncherError carrying the
// endpoint's error code (e.g. 'slug_conflict', 'payload_too_large').

import { buildMap, type MapEntry } from '../anon/mapping';
import { fetchTransport, type LauncherTransport } from './transport';

export class LauncherError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'LauncherError';
    this.code = code;
  }
}

export interface AnonResult {
  text: string;
  count: number;
}

export class LauncherClient {
  constructor(private readonly transport: LauncherTransport = fetchTransport()) {}

  private async replace(path: string, entries: MapEntry[], text: string): Promise<AnonResult> {
    let res;
    try {
      res = await this.transport.post(path, { map: buildMap(entries), text });
    } catch (e) {
      throw new LauncherError(`launcher request failed: ${(e as Error).message}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new LauncherError(`launcher returned a non-JSON response (status ${res.status})`);
    }
    if (res.status !== 200) {
      const err = body as { error?: string; code?: string };
      throw new LauncherError(err?.error ?? `launcher error (status ${res.status})`, err?.code);
    }
    const ok = body as AnonResult;
    if (typeof ok?.text !== 'string' || typeof ok?.count !== 'number') {
      throw new LauncherError('launcher returned a malformed result');
    }
    return ok;
  }

  /** Replace real phrases with slugs (real text never leaves the local machine un-anonymized). */
  anonymize(entries: MapEntry[], text: string): Promise<AnonResult> {
    return this.replace('/anonymize', entries, text);
  }

  /** Restore real phrases from slugs (locally; the response is no-store on the launcher side). */
  deanonymize(entries: MapEntry[], text: string): Promise<AnonResult> {
    return this.replace('/deanonymize', entries, text);
  }

  /** True iff the launcher is reachable and healthy. Never throws. */
  async health(): Promise<boolean> {
    try {
      const res = await this.transport.get('/health');
      if (res.status !== 200) return false;
      const body = (await res.json()) as { status?: string };
      return body?.status === 'ok';
    } catch {
      return false;
    }
  }
}
