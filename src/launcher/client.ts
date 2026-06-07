// Browser client for the launcher's anonymize/deanonymize/health endpoints. The map is serialized
// via buildMap (the single source of truth for case/whitespace/NFC variant expansion) so the
// launcher stays a dumb literal matcher. Errors surface as a typed LauncherError carrying the
// endpoint's error code (e.g. 'slug_conflict', 'payload_too_large').

import { buildMap, type MapEntry } from '../anon/mapping';
import { fetchTransport, type LauncherTransport, type LauncherResponse } from './transport';

/** One row of the home-screen list (from each archive's manifest.json). */
export interface ArchiveSummary {
  caseId: string;
  companyName: string;
  provider: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: string;
}

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

  // --- Business-case archives (the launcher is a dumb blob store; the SPA owns the zip format) ---

  /** Save (create or replace) a case archive .zip under its caseId. */
  async saveArchive(caseId: string, zipBytes: Uint8Array): Promise<void> {
    let res: LauncherResponse;
    try {
      res = await this.transport.putBinary(`/archive/${encodeURIComponent(caseId)}`, zipBytes);
    } catch (e) {
      throw new LauncherError(`could not save archive: ${(e as Error).message}`);
    }
    if (res.status !== 200) throw await errorFrom(res, 'save the archive');
  }

  /** List saved cases (newest first), one row per archive manifest. */
  async listArchives(): Promise<ArchiveSummary[]> {
    let res: LauncherResponse;
    try {
      res = await this.transport.get('/archives');
    } catch (e) {
      throw new LauncherError(`could not list archives: ${(e as Error).message}`);
    }
    if (res.status !== 200) throw await errorFrom(res, 'list archives');
    const body = await res.json();
    if (!Array.isArray(body)) throw new LauncherError('launcher returned a malformed archive list');
    return body as ArchiveSummary[];
  }

  /** Fetch a case archive's raw .zip bytes (to deserialize locally). */
  async loadArchive(caseId: string): Promise<Uint8Array> {
    let res;
    try {
      res = await this.transport.getBytes(`/archive/${encodeURIComponent(caseId)}`);
    } catch (e) {
      throw new LauncherError(`could not load archive: ${(e as Error).message}`);
    }
    // Always read the body (clears the transport's timeout); on error, surface the launcher's JSON message/code.
    const body = await res.bytes();
    if (res.status !== 200) {
      let msg = `could not load archive (status ${res.status})`;
      let code: string | undefined;
      try {
        const j = JSON.parse(new TextDecoder().decode(body)) as { error?: string; code?: string };
        msg = j.error ?? msg;
        code = j.code;
      } catch {
        /* non-JSON error body */
      }
      throw new LauncherError(msg, code);
    }
    return body;
  }

  /** Delete a saved case archive. */
  async deleteArchive(caseId: string): Promise<void> {
    let res: LauncherResponse;
    try {
      res = await this.transport.del(`/archive/${encodeURIComponent(caseId)}`);
    } catch (e) {
      throw new LauncherError(`could not delete archive: ${(e as Error).message}`);
    }
    if (res.status !== 200) throw await errorFrom(res, 'delete the archive');
  }
}

/** Build a LauncherError from a non-200 JSON error response (best-effort; tolerates a non-JSON body). */
async function errorFrom(res: LauncherResponse, action: string): Promise<LauncherError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const err = body as { error?: string; code?: string } | undefined;
  return new LauncherError(err?.error ?? `could not ${action} (status ${res.status})`, err?.code);
}
