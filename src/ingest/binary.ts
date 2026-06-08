// Binary-format extractors (xlsx / pdf / msg) that plug into the ingest async seam. They turn real
// customer artifacts into ingest Primitives using vendored libraries. The input is UNTRUSTED, so
// every extractor is fully crash-isolated (any parse error -> [], reported as not-extracted) and
// bounds its work: a zip-bomb guard rejects xlsx that would inflate to gigabytes BEFORE exceljs
// decompresses; rows/cols/text are capped. Extracted text is anonymized downstream (launcher
// /anonymize) before any LLM sees it — no LLM is involved here.

import ExcelJS from 'exceljs';
import { extractText, extractImages, getDocumentProxy } from 'unpdf';
import MsgReader from '@kenjiuno/msgreader';
import JSZip from 'jszip';
import PostalMime from 'postal-mime';
import { ooxmlParagraphsToText, ooxmlSlideText, htmlToText } from './markup';
import { encodePng } from './png';
import type { AsyncExtractor, Primitive, DetectedType } from './types';

const MAX_TEXT_CHARS = 2_000_000; // cap a single text primitive (memory guard)
const MAX_ROWS = 50_000; // cap rows collected per sheet
const MAX_COLS = 1024; // cap columns read per row (ignore cells beyond this)
const MAX_INFLATED_BYTES = 200 * 1024 * 1024; // reject an xlsx whose zip entries inflate beyond this
const MAX_ZIP_ENTRIES = 10_000; // reject a zip with absurdly many entries (entry-count bomb)
const MAX_SLIDES = 2_000; // cap slides/notes processed from one pptx
const MAX_EMBEDDED_IMAGES = 50; // cap images pulled out of one container (.msg / ooxml / pdf)
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // skip an embedded image larger than this
const MAX_PDF_PAGES_SCANNED = 500; // cap pages we pull embedded images from
const MAX_PDF_IMAGE_PIXELS = 40_000_000; // skip a pdf image larger than ~40MP (pdf.js refuses it pre-decode)
const PDF_IMAGE_EXTRACT_MS = 20_000; // per-page deadline so a stuck pdf.js object can't wedge ingest
const IMAGE_EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const OOXML_MEDIA = /^(word|ppt|xl)\/media\/[^/]+\.(png|jpe?g|gif|webp)$/i;
const STOP = Symbol('stop-iteration');

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  // Copy into a fresh (non-shared) ArrayBuffer — the parser libs want an ArrayBuffer, and this
  // avoids both pooled-buffer offset bugs and the ArrayBuffer|SharedArrayBuffer union.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return copy.buffer;
}

function cap(s: string): string {
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;
}

/** Reject after `ms` if `p` hasn't settled. Used to bound a pdf.js call that can hang indefinitely
 * (its internal object-resolve callback may never fire on a crafted PDF — and that await is otherwise
 * uncatchable). The losing promise keeps running but can no longer block the pipeline. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Resolve a concrete image/* mime from a declared mime and/or a filename/extension; null if not an image. */
function imageMimeFor(nameOrExt: string, declared?: string): string | null {
  const d = (declared ?? '').toLowerCase();
  if (d === 'image/jpg') return 'image/jpeg';
  if (/^image\/(png|jpeg|gif|webp)$/.test(d)) return d;
  const ext = nameOrExt.toLowerCase().split('.').pop() ?? '';
  return IMAGE_EXT_MIME[ext] ?? null;
}

/** Pull embedded raster images out of an OOXML container's media folder ((word|ppt|xl)/media/*),
 * so PII inside an embedded chart/screenshot is readable by the AI's vision model downstream. Bounded + per-file crash-isolated. */
async function ooxmlMediaImages(zip: JSZip, name: string): Promise<Primitive[]> {
  const paths = Object.keys(zip.files)
    .filter((p) => OOXML_MEDIA.test(p))
    .slice(0, MAX_EMBEDDED_IMAGES);
  const out: Primitive[] = [];
  for (const p of paths) {
    try {
      const bytes = await zip.file(p)!.async('uint8array');
      const mime = imageMimeFor(p);
      if (mime && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) {
        out.push({ kind: 'image', source: `${name}#${p.split('/').pop()}`, mime, bytes });
      }
    } catch {
      /* skip one unreadable media entry */
    }
  }
  return out;
}

/** "Name <addr>" when both present, else whichever exists — keeps the ADDRESS visible to the local
 * anonymizer (dropping it to just the display name would let an email address escape redaction). */
function formatAddress(name?: string, address?: string): string {
  const n = (name ?? '').trim();
  const a = (address ?? '').trim();
  return n && a ? `${n} <${a}>` : n || a;
}

/**
 * Sum the uncompressed sizes recorded in a zip's central directory WITHOUT decompressing, so a
 * zip-bomb is refused before exceljs/JSZip inflates it into memory. Returns false if the total
 * exceeds `max`, if a zip64 size placeholder (0xFFFFFFFF) is present, or if the central directory
 * cannot be parsed (untrusted input — fail closed).
 */
function zipInflatedSizeOk(bytes: Uint8Array, max: number): boolean {
  if (bytes.byteLength < 22) return false;
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
  if (eocd < 0) return false;
  const count = dv.getUint16(eocd + 10, true);
  if (count > MAX_ZIP_ENTRIES) return false; // entry-count bomb (e.g. 65k near-empty slide entries)
  let off = dv.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > bytes.length || dv.getUint32(off, true) !== CEN) return false;
    const usize = dv.getUint32(off + 24, true);
    if (usize === 0xffffffff) return false; // zip64 placeholder — refuse
    total += usize;
    if (total > max) return false;
    off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
  return true;
}

/** Render an exceljs cell value (string/number/date/formula/richText/hyperlink) to a flat string. */
function cellToString(v: unknown, depth = 0): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (depth < 4 && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.result !== undefined) return cellToString(o.result, depth + 1); // formula cell
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
    if (typeof o.text === 'string') return o.text; // hyperlink cell
    if (typeof o.error === 'string') return o.error; // error cell
  }
  return typeof v === 'object' ? '' : String(v);
}

/**
 * ooxml -> one TablePrimitive per worksheet (row 1 = headers). Non-xlsx ooxml (docx/pptx) -> [].
 * `opts` (caps) defaults to the module constants; tests inject small caps. Assignable to AsyncExtractor.
 */
export async function xlsxExtractor(name: string, bytes: Uint8Array, opts?: { maxRows?: number; maxCols?: number }): Promise<Primitive[]> {
  const maxRows = opts?.maxRows ?? MAX_ROWS;
  const maxCols = opts?.maxCols ?? MAX_COLS;
  try {
    if (!zipInflatedSizeOk(bytes, MAX_INFLATED_BYTES)) return []; // zip-bomb / not-a-zip guard
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    const out: Primitive[] = [];
    wb.eachSheet((sheet) => {
      const allRows: string[][] = [];
      let truncated = false;
      try {
        sheet.eachRow((row) => {
          if (allRows.length >= maxRows) {
            truncated = true;
            throw STOP; // break the forEach inside eachRow (return cannot)
          }
          const cells: string[] = [];
          row.eachCell((cell, col) => {
            if (col <= maxCols) cells[col - 1] = cellToString(cell.value);
          });
          for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = ''; // fill sparse holes
          allRows.push(cells);
        });
      } catch (e) {
        if (e !== STOP) throw e;
      }
      if (allRows.length === 0) return;
      out.push({
        kind: 'table',
        source: truncated ? `${name}#${sheet.name} (truncated to ${maxRows} rows)` : `${name}#${sheet.name}`,
        headers: allRows[0]!,
        rows: allRows.slice(1),
      });
    });
    out.push(...(await ooxmlMediaImages(await JSZip.loadAsync(toArrayBuffer(bytes)), name))); // embedded images
    return out;
  } catch {
    return []; // encrypted / non-xlsx ooxml / malformed -> reported as not-extracted
  }
}

/** pdf -> a TextPrimitive with all page text merged, plus an ImagePrimitive per embedded raster image
 * (charts/screenshots) so PII baked into them is readable by the AI's vision model downstream. `opts.maxImagePixels` (default
 * MAX_PDF_IMAGE_PIXELS) bounds image size both for pdf.js decode and our re-encode; tests inject a small
 * cap. Assignable to AsyncExtractor (the extra param is optional). */
export async function pdfExtractor(name: string, bytes: Uint8Array, opts?: { maxImagePixels?: number }): Promise<Primitive[]> {
  const maxPixels = opts?.maxImagePixels ?? MAX_PDF_IMAGE_PIXELS;
  try {
    // disableFontFace: text extraction needs no @font-face rendering. (useSystemFonts stays at the
    // unpdf default of true — local fonts only, no network fetch — so no standardFontDataUrl is needed.)
    // maxImageSize: pdf.js refuses to decode any image larger than this many pixels, so a crafted PDF
    // declaring a huge image can't OOM the tab BEFORE our post-decode pixel guard would ever run.
    const pdf = await getDocumentProxy(bytes, { disableFontFace: true, maxImageSize: maxPixels });
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join('\n') : String(text ?? '')).trim();
    const out: Primitive[] = merged ? [{ kind: 'text', source: name, text: cap(merged) }] : [];
    out.push(...(await pdfEmbeddedImages(pdf, name, maxPixels)));
    return out;
  } catch {
    return [];
  }
}

/** Pull embedded raster images out of a PDF: pdf.js decodes each image XObject to raw pixels, which we
 * re-encode to PNG so the AI's vision model can read it downstream. Bounded + per-page/per-image
 * crash-isolated. Known gaps: inline images, image masks, and JPXDecode-only images are not surfaced
 * (pdf.js paints them via ops we don't collect or in channel counts it doesn't expose). */
async function pdfEmbeddedImages(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, name: string, maxPixels: number): Promise<Primitive[]> {
  const out: Primitive[] = [];
  const pages = Math.min(pdf.numPages, MAX_PDF_PAGES_SCANNED);
  for (let p = 1; p <= pages && out.length < MAX_EMBEDDED_IMAGES; p++) {
    let imgs: Awaited<ReturnType<typeof extractImages>>;
    try {
      imgs = await withTimeout(extractImages(pdf, p), PDF_IMAGE_EXTRACT_MS, 'pdf image extract timeout');
    } catch {
      continue; // an unparseable OR stuck page never loses the rest of the document
    }
    let k = 0;
    for (const img of imgs) {
      if (out.length >= MAX_EMBEDDED_IMAGES) break;
      k++;
      try {
        if (img.width * img.height > maxPixels) continue; // second line after pdf.js's maxImageSize
        const png = encodePng(img.width, img.height, img.channels, img.data);
        if (png.length > 0 && png.length <= MAX_IMAGE_BYTES) {
          out.push({ kind: 'image', source: `${name}#p${p}-img${k}`, mime: 'image/png', bytes: png });
        }
      } catch {
        /* one undecodable image never loses the rest of the page */
      }
    }
  }
  return out;
}

interface MsgAttachment {
  fileName?: string;
  fileNameShort?: string;
  extension?: string;
  attachMimeTag?: string;
  innerMsgContent?: boolean; // true when the attachment is an embedded .msg (not a file)
}
interface MsgData {
  error?: string;
  subject?: string;
  body?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: Array<{ name?: string; email?: string }>;
  attachments?: MsgAttachment[];
}
interface MsgReaderLike {
  getFileData(): MsgData;
  getAttachment(a: MsgAttachment | number): { fileName?: string; content?: Uint8Array };
}

/** ole(.msg) -> body TextPrimitive + subject/from/to KeyValuePrimitive + an ImagePrimitive per embedded/
 * attached IMAGE (so performance charts pasted into an email are readable by the AI's vision model). Non-msg ole -> []. */
export const msgExtractor: AsyncExtractor = async (name, bytes) => {
  try {
    const reader = new MsgReader(toArrayBuffer(bytes)) as unknown as MsgReaderLike;
    const data = reader.getFileData();
    if (data.error) return [];
    const out: Primitive[] = [];
    const body = (data.body ?? '').trim();
    if (body) out.push({ kind: 'text', source: name, text: cap(body) });
    const pairs: Record<string, string> = {};
    if (data.subject) pairs.subject = data.subject;
    const from = formatAddress(data.senderName, data.senderEmail);
    if (from) pairs.from = from;
    const to = (data.recipients ?? [])
      .map((r) => formatAddress(r.name, r.email))
      .filter(Boolean)
      .join('; ');
    if (to) pairs.to = to;
    if (Object.keys(pairs).length) out.push({ kind: 'keyvalue', source: name, pairs });

    let images = 0;
    for (const att of data.attachments ?? []) {
      if (images >= MAX_EMBEDDED_IMAGES) break;
      if (att.innerMsgContent === true) continue; // embedded email, not an image file
      const label = att.fileName ?? att.fileNameShort ?? att.extension ?? '';
      const mime = imageMimeFor(label, att.attachMimeTag);
      if (!mime) continue;
      try {
        const content = reader.getAttachment(att).content;
        if (content && content.length > 0 && content.length <= MAX_IMAGE_BYTES) {
          // Prefix the attachment index so two attachments sharing a filename get DISTINCT sources —
          // downstream keys vision/extraction by primitive identity, but a unique source keeps it unambiguous.
          out.push({ kind: 'image', source: `${name}#att${images + 1}-${att.fileName ?? att.fileNameShort ?? 'image'}`, mime, bytes: content });
          images++;
        }
      } catch {
        /* one bad attachment never loses the rest of the email */
      }
    }
    return out;
  } catch {
    return [];
  }
};

// docx parts that carry rep-relevant text/PII (body + letterhead headers/footers + notes + comments).
const DOCX_TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i;

/** docx -> one TextPrimitive covering the body AND headers/footers/notes/comments, so PII in those
 * supplemental parts (letterhead, author, contacts, reviewer names) still reaches the anonymizer. */
export const docxExtractor: AsyncExtractor = async (name, bytes) => {
  try {
    if (!zipInflatedSizeOk(bytes, MAX_INFLATED_BYTES)) return [];
    const zip = await JSZip.loadAsync(toArrayBuffer(bytes));
    const parts = Object.keys(zip.files)
      .filter((p) => DOCX_TEXT_PARTS.test(p))
      .sort((a, b) => (a.includes('document.xml') ? -1 : b.includes('document.xml') ? 1 : a.localeCompare(b)));
    let text = '';
    let authors = '';
    for (const p of parts) {
      if (text.length > MAX_TEXT_CHARS) break;
      const xml = await zip.file(p)!.async('string');
      const t = ooxmlParagraphsToText(xml);
      if (t) text += (text ? '\n' : '') + t;
      if (/comments\.xml$/i.test(p)) {
        const re = /w:author="([^"]+)"/gi; // reviewer names live in the comment's author attribute
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml)) !== null) authors += (authors ? '; ' : '') + m[1]!;
      }
    }
    if (authors) text += `\ncomment authors: ${authors}`;
    text = text.trim();
    const out: Primitive[] = text ? [{ kind: 'text', source: name, text: cap(text) }] : [];
    out.push(...(await ooxmlMediaImages(zip, name))); // embedded images (logos/charts) → readable by the AI's vision model downstream
    return out;
  } catch {
    return [];
  }
};

/** pptx -> one TextPrimitive per slide (in order) plus one per notes slide (speaker notes carry PII). */
export const pptxExtractor: AsyncExtractor = async (name, bytes) => {
  try {
    if (!zipInflatedSizeOk(bytes, MAX_INFLATED_BYTES)) return [];
    const zip = await JSZip.loadAsync(toArrayBuffer(bytes));
    const collect = (re: RegExp): { path: string; n: number }[] =>
      Object.keys(zip.files)
        .map((p) => {
          const m = re.exec(p);
          return m ? { path: p, n: parseInt(m[1]!, 10) } : null;
        })
        .filter((x): x is { path: string; n: number } => x !== null)
        .sort((a, b) => a.n - b.n)
        .slice(0, MAX_SLIDES);
    const out: Primitive[] = [];
    for (const s of collect(/^ppt\/slides\/slide(\d+)\.xml$/)) {
      const text = ooxmlSlideText(await zip.file(s.path)!.async('string')).trim();
      if (text) out.push({ kind: 'text', source: `${name}#slide${s.n}`, text: cap(text) });
    }
    for (const s of collect(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)) {
      const text = ooxmlSlideText(await zip.file(s.path)!.async('string')).trim();
      if (text) out.push({ kind: 'text', source: `${name}#notes${s.n}`, text: cap(text) });
    }
    out.push(...(await ooxmlMediaImages(zip, name))); // embedded slide images (charts/screenshots)
    return out;
  } catch {
    return [];
  }
};

interface EmlAddress {
  address?: string;
  name?: string;
}
interface ParsedEml {
  subject?: string;
  from?: EmlAddress;
  to?: EmlAddress[];
  cc?: EmlAddress[];
  bcc?: EmlAddress[];
  replyTo?: EmlAddress[];
  date?: string;
  text?: string;
  html?: string;
}

const joinAddrs = (xs?: EmlAddress[]): string =>
  (xs ?? [])
    .map((r) => formatAddress(r.name, r.address))
    .filter(Boolean)
    .join('; ');

/** eml(.eml RFC822) -> body TextPrimitive + subject/from/to/cc/bcc/reply-to/date KeyValuePrimitive.
 * All recipient fields are captured so every address reaches the anonymizer (parallels .msg). */
export const emlExtractor: AsyncExtractor = async (name, bytes) => {
  try {
    const email = (await PostalMime.parse(toArrayBuffer(bytes))) as ParsedEml;
    const out: Primitive[] = [];
    const body = (email.text ?? (email.html ? htmlToText(email.html) : '')).trim();
    if (body) out.push({ kind: 'text', source: name, text: cap(body) });
    const pairs: Record<string, string> = {};
    if (email.subject) pairs.subject = email.subject;
    const from = formatAddress(email.from?.name, email.from?.address);
    if (from) pairs.from = from;
    const to = joinAddrs(email.to);
    if (to) pairs.to = to;
    const cc = joinAddrs(email.cc);
    if (cc) pairs.cc = cc;
    const bcc = joinAddrs(email.bcc);
    if (bcc) pairs.bcc = bcc;
    const replyTo = joinAddrs(email.replyTo);
    if (replyTo) pairs.replyTo = replyTo;
    if (email.date) pairs.date = email.date;
    if (Object.keys(pairs).length) out.push({ kind: 'keyvalue', source: name, pairs });
    return out;
  } catch {
    return [];
  }
};

/** Best-effort extractor for a zip we couldn't disambiguate — try each OOXML parser, first hit wins. */
const ooxmlFallbackExtractor: AsyncExtractor = async (name, bytes) => {
  for (const ex of [xlsxExtractor, docxExtractor, pptxExtractor]) {
    const r = await ex(name, bytes);
    if (r.length) return r;
  }
  return [];
};

/** The binary extractor registry to pass to ingestAsync. Container subtypes route to their own
 * extractor; 'ooxml'/'ole' remain as best-effort fallbacks for containers we couldn't disambiguate. */
export const BINARY_EXTRACTORS: Partial<Record<DetectedType, AsyncExtractor>> = {
  xlsx: xlsxExtractor,
  docx: docxExtractor,
  pptx: pptxExtractor,
  ooxml: ooxmlFallbackExtractor,
  pdf: pdfExtractor,
  msg: msgExtractor,
  ole: msgExtractor,
  eml: emlExtractor,
};
