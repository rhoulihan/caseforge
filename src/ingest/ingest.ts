import type { EvidenceBundle, Primitive, Extractor, AsyncExtractor, DetectedType, FileReport, FileErrorCategory } from './types';
import { detectType } from './detect';
import { parseDelimited } from './csv';
import { htmlToText, xmlToText, rtfToText } from './markup';

/** Files larger than this are not parsed (zip-bomb / pathological-input guard). */
export const MAX_PARSE_BYTES = 25 * 1024 * 1024; // 25 MiB

const MIME: Partial<Record<DetectedType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Recognized formats we deliberately don't parse — a helpful note guides the rep to a usable export. */
const UNSUPPORTED_NOTE: Partial<Record<DetectedType, string>> = {
  xls: 'legacy Excel (.xls) is not read — please re-save as .xlsx or export to CSV',
  doc: 'legacy Word (.doc) is not read — please re-save as .docx or export to PDF',
};

/** Extractors for the formats the pure core handles directly (synchronously, no vendored parser). */
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
    case 'html':
    case 'xml':
    case 'rtf': {
      const raw = new TextDecoder('utf-8').decode(bytes);
      const text = type === 'html' ? htmlToText(raw) : type === 'xml' ? xmlToText(raw) : rtfToText(raw);
      return text ? [{ kind: 'text', source: name, text }] : [];
    }
    case 'png':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return [{ kind: 'image', source: name, mime: MIME[type]!, bytes }];
    default:
      return null; // pdf/docx/pptx/msg/eml/xls/doc/unknown — handled by a supplied extractor or reported not-extracted
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
    if (f.bytes.length > MAX_PARSE_BYTES) {
      reports.push(failedReport(f.name, type, false, 'file too large to parse safely', 'file_too_large'));
      continue;
    }
    const builtin = builtinExtract(type, f.name, f.bytes);
    let prims = builtin;
    const hasExtractor = builtin === null && !!extra[type];
    if (hasExtractor) prims = extra[type]!(f.name, f.bytes);
    if (prims && prims.length) {
      primitives.push(...prims);
      reports.push({ name: f.name, type, ok: true });
    } else {
      reports.push(failedReport(f.name, type, hasExtractor));
    }
  }
  return { primitives, files: reports };
}

/** Build the FileReport for a file we couldn't extract — classifies why (note + errorCategory). */
function failedReport(name: string, type: DetectedType, hadExtractor: boolean, note?: string, errorCategory?: FileErrorCategory): FileReport {
  if (type === 'unknown') return { name, type, ok: false, note: note ?? 'unrecognized file type', errorCategory: errorCategory ?? 'unsupported_format' };
  if (errorCategory) return { name, type, ok: false, note, errorCategory }; // size/throw classified by the caller
  if (hadExtractor) return { name, type, ok: false, note: note ?? 'could not extract any content (file may be empty or corrupt)', errorCategory: 'malformed_file' };
  return { name, type, ok: false, note: note ?? UNSUPPORTED_NOTE[type] ?? 'recognized but no extractor available yet', errorCategory: 'unsupported_format' };
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
    // Size guard up front — covers BOTH the builtin path (html/rtf/csv/… text munging) and the async
    // extractors, so an oversized file can never reach a parser and OOM the tab.
    if (f.bytes.length > MAX_PARSE_BYTES) {
      reports.push(failedReport(f.name, type, false, 'file too large to parse safely', 'file_too_large'));
      continue;
    }
    const builtin = builtinExtract(type, f.name, f.bytes); // sync builtins (csv/json/text/images)
    let prims = builtin;
    const hasExtractor = builtin === null && !!extra[type];
    let note: string | undefined;
    let errorCategory: FileErrorCategory | undefined;
    if (hasExtractor) {
      try {
        prims = await extra[type]!(f.name, f.bytes);
      } catch (e) {
        prims = [];
        // Cap + de-newline the third-party parser message so a content fragment can't ride into the report.
        const msg = String((e as Error).message).replace(/[\r\n]+/g, ' ').slice(0, 120);
        note = `extractor error: ${msg}`;
        errorCategory = 'extractor_error';
      }
    }
    if (prims && prims.length) {
      primitives.push(...prims);
      reports.push({ name: f.name, type, ok: true });
    } else {
      reports.push(failedReport(f.name, type, hasExtractor, note, errorCategory));
    }
  }
  return { primitives, files: reports };
}
