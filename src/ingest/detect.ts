import type { DetectedType } from './types';

function startsWith(b: Uint8Array, sig: number[]): boolean {
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
}

function bytesEqualAt(b: Uint8Array, off: number, sig: number[]): boolean {
  if (b.length < off + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[off + i] !== sig[i]) return false;
  return true;
}

/** Read the central-directory filenames of a zip (no decompression). Null if it can't be parsed. */
function zipCentralNames(bytes: Uint8Array): string[] | null {
  if (bytes.byteLength < 22) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (dv.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const names: string[] = [];
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < count && n < 5000; n++) {
    if (off + 46 > bytes.length || dv.getUint32(off, true) !== CEN) break;
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const nameStart = off + 46;
    if (nameStart + nameLen > bytes.length) break;
    names.push(dec.decode(bytes.subarray(nameStart, nameStart + nameLen)));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Disambiguate a zip (OOXML) by its canonical part names. Falls back to 'ooxml' if unclear. */
function ooxmlSubtype(bytes: Uint8Array): DetectedType {
  const names = zipCentralNames(bytes);
  if (names === null) return 'ooxml';
  if (names.includes('word/document.xml') || names.some((n) => n.startsWith('word/'))) return 'docx';
  if (names.includes('ppt/presentation.xml') || names.some((n) => n.startsWith('ppt/'))) return 'pptx';
  if (names.includes('xl/workbook.xml') || names.some((n) => n.startsWith('xl/'))) return 'xlsx';
  return 'ooxml';
}

const OLE_SNIFF_LIMIT = 1024 * 1024; // OLE2 directory + key stream names live near the start

function utf16le(s: string): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c & 0xff;
    b[i * 2 + 1] = (c >> 8) & 0xff;
  }
  return b;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, limit: number): boolean {
  const end = Math.min(hay.length - needle.length, limit);
  for (let i = 0; i <= end; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    if (ok) return true;
  }
  return false;
}

/** Disambiguate an OLE2 compound file by its (UTF-16LE) stream names. Falls back to 'ole'. */
function oleSubtype(bytes: Uint8Array): DetectedType {
  const has = (s: string): boolean => indexOfBytes(bytes, utf16le(s), OLE_SNIFF_LIMIT);
  if (has('__substg1.0') || has('__properties_version1.0')) return 'msg';
  if (has('WordDocument')) return 'doc';
  if (has('Workbook') || has('Book')) return 'xls';
  return 'ole';
}

/** RFC822 heuristic: the file opens with a block of "Header: value" lines incl. a canonical mail header. */
function looksLikeEml(text: string): boolean {
  const head = text.slice(0, 8192);
  const lines = head.split(/\r?\n/);
  let headers = 0;
  for (const line of lines) {
    if (line === '') break; // end of the header block
    if (/^[A-Za-z][A-Za-z0-9-]*:/.test(line) || /^[ \t]+\S/.test(line)) headers++; // header line or folded continuation
    else return false; // a non-header line before the blank separator → not an email
  }
  // Require ≥2 headers, a canonical mail header, AND at least one address-bearing header (@ or <Name addr>)
  // so a plain memo opening with "From: Alice / To: Team" isn't misread as an email.
  return (
    headers >= 2 &&
    /^(Received|Message-ID|Return-Path|MIME-Version|From|To|Subject|Date):/im.test(head) &&
    /^(From|To|Cc|Reply-To):.*[@<]/im.test(head)
  );
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
  // RIFF....WEBP — accepted by both Claude and OpenAI vision
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesEqualAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return oleSubtype(bytes); // OLE2 compound → msg/xls/doc/ole
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return ooxmlSubtype(bytes); // zip → xlsx/docx/pptx/ooxml

  const text = tryDecodeText(bytes);
  if (text === null) return 'unknown';
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.startsWith('{\\rtf')) return 'rtf';
  if (
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    /^<(head|body|div|table|p|span|ul|ol|h[1-6]|article|section|nav|main|aside|form|figure|header|footer|script|style|meta|link)[\s>/]/.test(lower)
  )
    return 'html';
  if (lower.startsWith('<?xml') || trimmed.startsWith('<')) return 'xml'; // generic XML incl. SVG
  if (looksLikeEml(text)) return 'eml';
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isJson(trimmed)) return 'json';
  const delim = detectDelimiter(text);
  if (delim === ',') return 'csv';
  if (delim === '\t') return 'tsv';
  return 'text';
}
