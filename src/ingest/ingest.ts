import type { EvidenceBundle, Primitive, Extractor, AsyncExtractor, DetectedType, FileReport } from './types';
import { detectType } from './detect';
import { parseDelimited } from './csv';

/** Files larger than this are not parsed (zip-bomb / pathological-input guard). */
export const MAX_PARSE_BYTES = 25 * 1024 * 1024; // 25 MiB

const MIME: Partial<Record<DetectedType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

/** Extractors for the formats the pure core handles directly. */
function builtinExtract(type: DetectedType, name: string, bytes: Uint8Array): Primitive[] | null {
  switch (type) {
    case 'csv':
    case 'tsv': {
      const text = new TextDecoder('utf-8').decode(bytes);
      const { headers, rows } = parseDelimited(text, type === 'tsv' ? '\t' : ',');
      return [{ kind: 'table', source: name, headers, rows }];
    }
    case 'json':
    case 'text':
      return [{ kind: 'text', source: name, text: new TextDecoder('utf-8').decode(bytes) }];
    case 'png':
    case 'jpeg':
    case 'gif':
      return [{ kind: 'image', source: name, mime: MIME[type]!, bytes }];
    default:
      return null; // pdf/ooxml/ole/unknown — handled by a supplied extractor or reported not-extracted
  }
}

/**
 * Ingest a set of in-memory files into an EvidenceBundle, identifying each by content.
 * `extra` plugs in binary extractors (msg/xlsx/pdf) keyed by detected type (the extension seam).
 */
export function ingest(
  files: { name: string; bytes: Uint8Array }[],
  extra: Partial<Record<DetectedType, Extractor>> = {}
): EvidenceBundle {
  const primitives: Primitive[] = [];
  const reports: FileReport[] = [];
  for (const f of files) {
    const type = detectType(f.name, f.bytes);
    let prims = builtinExtract(type, f.name, f.bytes);
    if (prims === null && extra[type]) prims = extra[type]!(f.name, f.bytes);
    if (prims && prims.length) {
      primitives.push(...prims);
      reports.push({ name: f.name, type, ok: true });
    } else {
      reports.push({
        name: f.name,
        type,
        ok: false,
        note: type === 'unknown' ? 'unrecognized file type' : 'recognized but no extractor available yet',
      });
    }
  }
  return { primitives, files: reports };
}

/**
 * Async variant of {@link ingest} for binary formats whose parsers are async (PDF). `extra` plugs in
 * AsyncExtractors keyed by detected type. Each extractor call is isolated in try/catch so one
 * malformed file can never crash the batch, and files over MAX_PARSE_BYTES are skipped unparsed.
 */
export async function ingestAsync(
  files: { name: string; bytes: Uint8Array }[],
  extra: Partial<Record<DetectedType, AsyncExtractor>> = {}
): Promise<EvidenceBundle> {
  const primitives: Primitive[] = [];
  const reports: FileReport[] = [];
  for (const f of files) {
    const type = detectType(f.name, f.bytes);
    let prims = builtinExtract(type, f.name, f.bytes); // sync builtins (csv/json/text/images)
    let note: string | undefined;
    if (prims === null && extra[type]) {
      if (f.bytes.length > MAX_PARSE_BYTES) {
        prims = [];
        note = 'file too large to parse safely';
      } else {
        try {
          prims = await extra[type]!(f.name, f.bytes);
        } catch (e) {
          prims = [];
          note = `extractor error: ${(e as Error).message}`;
        }
      }
    }
    if (prims && prims.length) {
      primitives.push(...prims);
      reports.push({ name: f.name, type, ok: true });
    } else {
      reports.push({
        name: f.name,
        type,
        ok: false,
        note: note ?? (type === 'unknown' ? 'unrecognized file type' : 'recognized but no extractor available yet'),
      });
    }
  }
  return { primitives, files: reports };
}
