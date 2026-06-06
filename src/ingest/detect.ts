import type { DetectedType } from './types';

function startsWith(b: Uint8Array, sig: number[]): boolean {
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
}

/** Decode as UTF-8 text, or null if the bytes look binary (NUL or many control chars). */
function tryDecodeText(bytes: Uint8Array): string | null {
  const n = Math.min(bytes.length, 4096);
  let nonPrintable = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    if (c === 0) return null;
    if (c < 9 || (c > 13 && c < 32)) nonPrintable++;
  }
  if (n > 0 && nonPrintable / n > 0.05) return null;
  return new TextDecoder('utf-8').decode(bytes);
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function countUnquoted(line: string, delim: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delim && !inQuotes) count++;
  }
  return count;
}

function detectDelimiter(text: string): ',' | '\t' | null {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 10);
  if (lines.length < 1) return null;
  for (const d of [',', '\t'] as const) {
    const counts = lines.map((l) => countUnquoted(l, d));
    if (counts[0]! >= 1 && counts.every((c) => c === counts[0])) return d;
  }
  return null;
}

/** Identify a file by its CONTENT (magic bytes / structure), not its extension. */
export function detectType(_name: string, bytes: Uint8Array): DetectedType {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // GIF8
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return 'ole'; // OLE2 compound (msg/xls/doc)
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'ooxml'; // zip (xlsx/docx/pptx)

  const text = tryDecodeText(bytes);
  if (text === null) return 'unknown';
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isJson(trimmed)) return 'json';
  const delim = detectDelimiter(text);
  if (delim === ',') return 'csv';
  if (delim === '\t') return 'tsv';
  return 'text';
}
