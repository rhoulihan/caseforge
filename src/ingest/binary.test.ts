import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as CFB from 'cfb';
import JSZip from 'jszip';
import { xlsxExtractor, pdfExtractor, msgExtractor, docxExtractor, pptxExtractor, emlExtractor, BINARY_EXTRACTORS } from './binary';
import { encodePng } from './png';
import { ingestAsync, MAX_PARSE_BYTES } from './ingest';
import type { AsyncExtractor, TablePrimitive, TextPrimitive, KeyValuePrimitive, ImagePrimitive } from './types';

// ---- OOXML fixture generators (real zips, no committed binaries) ----
async function makeDocx(paras: string[]): Promise<Uint8Array> {
  const body = paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  return z.generateAsync({ type: 'uint8array' });
}
async function makePptx(slides: string[][]): Promise<Uint8Array> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types/>');
  z.file('ppt/presentation.xml', '<p:presentation/>');
  slides.forEach((runs, i) => {
    const ts = runs.map((r) => `<a:t>${r}</a:t>`).join('');
    z.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><p:cSld><p:spTree>${ts}</p:spTree></p:cSld></p:sld>`);
  });
  return z.generateAsync({ type: 'uint8array' });
}

// ---- fixture generators (no committed binaries) ----

async function makeXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
  }
  const buf = await wb.xlsx.writeBuffer();
  return buf instanceof Uint8Array ? new Uint8Array(buf) : new Uint8Array(buf as ArrayBuffer);
}

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 700, size: 18, font });
  return doc.save();
}

async function makePdfWithImage(text: string, png: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 700, size: 18, font });
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 50, y: 400, width: img.width, height: img.height });
  return doc.save();
}

function u16le(s: string): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c & 0xff;
    b[i * 2 + 1] = (c >> 8) & 0xff;
  }
  return b;
}

function makeMsg(opts: { subject?: string; body?: string; sender?: string }): Uint8Array {
  const { utils, write } = CFB as unknown as {
    utils: { cfb_new: () => unknown; cfb_add: (cfb: unknown, name: string, data: Uint8Array) => void };
    write: (cfb: unknown, o: { type: string }) => number[];
  };
  const cfb = utils.cfb_new();
  if (opts.subject) utils.cfb_add(cfb, '/__substg1.0_0037001F', u16le(opts.subject));
  if (opts.body) utils.cfb_add(cfb, '/__substg1.0_1000001F', u16le(opts.body));
  if (opts.sender) utils.cfb_add(cfb, '/__substg1.0_0C1A001F', u16le(opts.sender));
  utils.cfb_add(cfb, '/__properties_version1.0', new Uint8Array(32));
  return Uint8Array.from(write(cfb, { type: 'array' }) as number[]);
}

// ---- extractor tests ----

describe('xlsxExtractor', () => {
  it('extracts one table per sheet (row 1 = headers, cells stringified)', async () => {
    const bytes = await makeXlsx([
      { name: 'Sizing', rows: [['Metric', 'Value'], ['vCPU', 16], ['Storage GB', 500]] },
      { name: 'Costs', rows: [['Item', 'USD'], ['License', 240000]] },
    ]);
    const prims = await xlsxExtractor('book.xlsx', bytes);
    expect(prims).toHaveLength(2);
    const sizing = prims[0] as TablePrimitive;
    expect(sizing.kind).toBe('table');
    expect(sizing.headers).toEqual(['Metric', 'Value']);
    expect(sizing.rows).toEqual([['vCPU', '16'], ['Storage GB', '500']]);
    expect(sizing.source).toContain('Sizing');
  });
  it('returns [] for a non-xlsx ooxml (garbage), never throws', async () => {
    const garbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(40).fill(0)]);
    await expect(xlsxExtractor('x.docx', garbage)).resolves.toEqual([]);
  });
  it('caps rows at maxRows and notes the truncation', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i]); // 10 rows incl. header
    const bytes = await makeXlsx([{ name: 'Big', rows }]);
    const prims = await xlsxExtractor('big.xlsx', bytes, { maxRows: 3 });
    const t = prims[0] as TablePrimitive;
    expect(t.rows.length).toBe(2); // 3 collected (incl. header) -> 2 data rows
    expect(t.source).toMatch(/truncated to 3 rows/);
  });
});

describe('pdfExtractor', () => {
  it('extracts merged page text', async () => {
    const prims = await pdfExtractor('doc.pdf', await makePdf('Workload 3 shards 16 vCPU 500GB'));
    expect(prims).toHaveLength(1);
    const t = prims[0] as TextPrimitive;
    expect(t.kind).toBe('text');
    expect(t.text).toContain('Workload');
  });
  it('returns [] for corrupt pdf bytes', async () => {
    await expect(pdfExtractor('bad.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3, 4, 5]))).resolves.toEqual([]);
  });
  it('extracts embedded raster images as OCR-able PNG primitives (pdf.js → PNG round-trip)', async () => {
    // A real PDF carrying a real embedded image: pdf.js must decode it and we must re-encode to PNG.
    const embedded = encodePng(8, 8, 3, Uint8ClampedArray.from({ length: 8 * 8 * 3 }, (_, i) => (i * 5) & 0xff));
    const prims = await pdfExtractor('deck.pdf', await makePdfWithImage('Quarterly results', embedded));
    expect(prims.some((p) => p.kind === 'text')).toBe(true); // page text still extracted
    const img = prims.find((p) => p.kind === 'image') as ImagePrimitive | undefined;
    expect(img).toBeDefined();
    expect(img!.mime).toBe('image/png');
    expect(img!.source).toBe('deck.pdf#p1-img1');
    expect([...img!.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
    expect(img!.bytes.length).toBeGreaterThan(50);
  });
  it('drops a pdf image that exceeds the pixel cap (text still extracted)', async () => {
    const embedded = encodePng(8, 8, 3, Uint8ClampedArray.from({ length: 8 * 8 * 3 }, (_, i) => (i * 5) & 0xff));
    const prims = await pdfExtractor('deck.pdf', await makePdfWithImage('Quarterly results', embedded), { maxImagePixels: 10 });
    expect(prims.some((p) => p.kind === 'image')).toBe(false); // 64px image > 10px cap → not emitted
    expect(prims.some((p) => p.kind === 'text')).toBe(true);
  });
});

describe('msgExtractor', () => {
  it('extracts body text + subject/from keyvalue', async () => {
    const prims = await msgExtractor('mail.msg', makeMsg({ subject: 'Sizing request', body: 'We run 3 shards.', sender: 'Jane Architect' }));
    const text = prims.find((p) => p.kind === 'text') as TextPrimitive;
    const kv = prims.find((p) => p.kind === 'keyvalue') as KeyValuePrimitive;
    expect(text.text).toBe('We run 3 shards.');
    expect(kv.pairs.subject).toBe('Sizing request');
    expect(kv.pairs.from).toBe('Jane Architect');
  });
  it('returns [] for a non-msg ole', async () => {
    await expect(msgExtractor('x.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, ...new Array(40).fill(0)]))).resolves.toEqual([]);
  });
  it('caps an enormous body to MAX_TEXT_CHARS (2,000,000)', async () => {
    const huge = 'x'.repeat(2_000_010);
    const prims = await msgExtractor('big.msg', makeMsg({ subject: 'S', body: huge }));
    const t = prims.find((p) => p.kind === 'text') as TextPrimitive;
    expect(t.text.length).toBe(2_000_000);
  });
});

// ---- ingestAsync seam ----

describe('ingestAsync seam', () => {
  it('runs sync builtins and async extras together', async () => {
    const bundle = await ingestAsync(
      [
        { name: 'data.csv', bytes: new TextEncoder().encode('a,b\n1,2') },
        { name: 'doc.pdf', bytes: await makePdf('hello pdf') },
      ],
      BINARY_EXTRACTORS
    );
    expect(bundle.files.find((f) => f.name === 'data.csv')?.ok).toBe(true);
    expect(bundle.files.find((f) => f.name === 'doc.pdf')?.ok).toBe(true);
    expect(bundle.primitives.some((p) => p.kind === 'table')).toBe(true);
    expect(bundle.primitives.some((p) => p.kind === 'text')).toBe(true);
  });
  it('isolates a throwing extractor (one bad file does not crash the batch)', async () => {
    const boom: AsyncExtractor = async () => {
      throw new Error('kaboom');
    };
    const bundle = await ingestAsync([{ name: 'doc.pdf', bytes: await makePdf('ok') }], { pdf: boom });
    expect(bundle.files[0]!.ok).toBe(false);
    expect(bundle.files[0]!.note).toMatch(/kaboom/);
  });
  it('skips a file over the size cap with a note', async () => {
    const big = new Uint8Array(MAX_PARSE_BYTES + 1);
    big.set([0x25, 0x50, 0x44, 0x46]); // %PDF
    const bundle = await ingestAsync([{ name: 'huge.pdf', bytes: big }], BINARY_EXTRACTORS);
    expect(bundle.files[0]!.ok).toBe(false);
    expect(bundle.files[0]!.note).toMatch(/too large/);
  });
});

describe('ingestAsync end-to-end', () => {
  it('detects + extracts xlsx + pdf + msg + csv in one bundle', async () => {
    const files = [
      { name: 'sheet.xlsx', bytes: await makeXlsx([{ name: 'S', rows: [['h'], ['v']] }]) },
      { name: 'doc.pdf', bytes: await makePdf('pdf text here') },
      { name: 'mail.msg', bytes: makeMsg({ subject: 'Hi', body: 'Body text', sender: 'A' }) },
      { name: 'd.csv', bytes: new TextEncoder().encode('x,y\n1,2') },
    ];
    const bundle = await ingestAsync(files, BINARY_EXTRACTORS);
    expect(bundle.files.every((f) => f.ok)).toBe(true);
    expect(bundle.files.map((f) => f.type).sort()).toEqual(['csv', 'msg', 'pdf', 'xlsx']); // containers now disambiguated
    expect(bundle.primitives.filter((p) => p.kind === 'table').length).toBeGreaterThanOrEqual(2); // xlsx + csv
    expect(bundle.primitives.some((p) => p.kind === 'text')).toBe(true); // pdf + msg body
    expect(bundle.primitives.some((p) => p.kind === 'keyvalue')).toBe(true); // msg
  });

  it('detects + extracts docx, pptx, and eml in one bundle', async () => {
    const eml = 'From: Alice <a@x.com>\r\nSubject: Sizing\r\nMessage-ID: <1@x>\r\n\r\nThe cluster has 3 shards.';
    const files = [
      { name: 'notes.docx', bytes: await makeDocx(['Topology overview.', '3 shards, 32 vCPU per node.']) },
      { name: 'deck.pptx', bytes: await makePptx([['Architecture'], ['Sizing plan']]) },
      { name: 'mail.eml', bytes: new TextEncoder().encode(eml) },
    ];
    const bundle = await ingestAsync(files, BINARY_EXTRACTORS);
    expect(bundle.files.every((f) => f.ok)).toBe(true);
    expect(bundle.files.map((f) => f.type).sort()).toEqual(['docx', 'eml', 'pptx']);
  });
});

describe('docxExtractor', () => {
  it('extracts paragraph text from word/document.xml', async () => {
    const prims = await docxExtractor('d.docx', await makeDocx(['First paragraph.', 'Second one.']));
    const t = prims.find((p) => p.kind === 'text') as TextPrimitive;
    expect(t.text).toContain('First paragraph.');
    expect(t.text).toContain('Second one.');
  });
  it('returns [] for a zip without word/document.xml', async () => {
    const z = new JSZip();
    z.file('xl/workbook.xml', '<x/>');
    expect(await docxExtractor('x', await z.generateAsync({ type: 'uint8array' }))).toEqual([]);
  });
  it('also pulls embedded images out of word/media, bytes intact (so chart text is OCR-able)', async () => {
    // A REAL png (not garbage) so a broken extractor that mangles bytes would fail the round-trip.
    const realPng = encodePng(4, 4, 3, Uint8ClampedArray.from({ length: 4 * 4 * 3 }, (_, i) => (i * 11) & 0xff));
    const z = new JSZip();
    z.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:body></w:document>');
    z.file('word/media/image1.png', realPng);
    const prims = await docxExtractor('d.docx', await z.generateAsync({ type: 'uint8array' }));
    const img = prims.find((p) => p.kind === 'image') as ImagePrimitive;
    expect(img).toBeTruthy();
    expect(img.mime).toBe('image/png');
    expect(img.source).toBe('d.docx#image1.png');
    expect(Array.from(img.bytes)).toEqual(Array.from(realPng)); // bytes round-trip exactly
  });
  it('caps embedded media at MAX_EMBEDDED_IMAGES (51 entries → 50 primitives)', async () => {
    const z = new JSZip();
    z.file('word/document.xml', '<w:document><w:body/></w:document>');
    for (let i = 1; i <= 51; i++) z.file(`word/media/image${i}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, i & 0xff]));
    const prims = await docxExtractor('d.docx', await z.generateAsync({ type: 'uint8array' }));
    expect(prims.filter((p) => p.kind === 'image')).toHaveLength(50);
  });
  it('skips an embedded image larger than MAX_IMAGE_BYTES', async () => {
    const z = new JSZip();
    z.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:body></w:document>');
    z.file('word/media/huge.png', new Uint8Array(25 * 1024 * 1024 + 1)); // 1 byte over the 25 MiB cap
    const prims = await docxExtractor('d.docx', await z.generateAsync({ type: 'uint8array' }));
    expect(prims.some((p) => p.kind === 'image')).toBe(false); // oversized image dropped
    expect(prims.some((p) => p.kind === 'text')).toBe(true); // body text still extracted
  });
});

describe('pptxExtractor', () => {
  it('emits one text primitive per slide, in slide order', async () => {
    const prims = (await pptxExtractor('deck.pptx', await makePptx([['Title A', 'bullet'], ['Title B']]))) as TextPrimitive[];
    const texts = prims.filter((p) => p.kind === 'text') as TextPrimitive[];
    expect(texts).toHaveLength(2);
    expect(texts[0]!.source).toContain('slide1');
    expect(texts[0]!.text).toContain('Title A');
    expect(texts[1]!.text).toContain('Title B');
  });
  it('pulls embedded slide images out of ppt/media', async () => {
    const z = new JSZip();
    z.file('ppt/presentation.xml', '<p:presentation/>');
    z.file('ppt/slides/slide1.xml', '<p:sld><a:t>Slide</a:t></p:sld>');
    z.file('ppt/media/image2.jpeg', new Uint8Array([0xff, 0xd8, 0xff, 1, 2]));
    const prims = await pptxExtractor('deck.pptx', await z.generateAsync({ type: 'uint8array' }));
    const img = prims.find((p) => p.kind === 'image') as ImagePrimitive;
    expect(img.mime).toBe('image/jpeg');
    expect(img.source).toBe('deck.pptx#image2.jpeg');
  });
});

describe('emlExtractor', () => {
  it('extracts the body as text and headers (incl. cc) as a keyvalue, preserving every address', async () => {
    const eml =
      'From: Alice <a@x.com>\r\nTo: Bob <b@y.com>\r\nCc: Carol <carol@z.com>, Dan <dan@z.com>\r\nSubject: Sizing\r\nDate: Mon, 1 Jan 2026 00:00:00 +0000\r\n\r\nThe cluster has 3 shards.\r\n';
    const prims = await emlExtractor('mail.eml', new TextEncoder().encode(eml));
    const t = prims.find((p) => p.kind === 'text') as TextPrimitive;
    const kv = prims.find((p) => p.kind === 'keyvalue') as KeyValuePrimitive;
    expect(t.text).toContain('3 shards');
    expect(kv.pairs.subject).toBe('Sizing');
    expect(kv.pairs.from).toContain('a@x.com'); // the ADDRESS is preserved so anonymization can redact it
    expect(kv.pairs.to).toContain('b@y.com');
    expect(kv.pairs.cc).toContain('carol@z.com'); // cc recipients are PII-dense — must be captured
    expect(kv.pairs.cc).toContain('dan@z.com');
  });
});

describe('docxExtractor — supplemental parts (privacy)', () => {
  it('extracts headers/footers and comment authors, not just the body', async () => {
    const z = new JSZip();
    z.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Body line.</w:t></w:r></w:p></w:body></w:document>');
    z.file('word/header1.xml', '<w:hdr><w:p><w:r><w:t>Acme Corp · contact john@acme.com</w:t></w:r></w:p></w:hdr>');
    z.file('word/comments.xml', '<w:comments><w:comment w:author="Jane Reviewer"><w:p><w:r><w:t>Check the DR plan</w:t></w:r></w:p></w:comment></w:comments>');
    const prims = (await docxExtractor('d.docx', await z.generateAsync({ type: 'uint8array' }))) as TextPrimitive[];
    const text = prims[0]!.text;
    expect(text).toContain('Body line.');
    expect(text).toContain('john@acme.com'); // header PII reaches anonymization
    expect(text).toContain('Check the DR plan'); // comment text
    expect(text).toContain('Jane Reviewer'); // comment author
  });
});

describe('pptxExtractor — speaker notes (privacy)', () => {
  it('extracts notesSlides in addition to slides', async () => {
    const z = new JSZip();
    z.file('ppt/presentation.xml', '<p:presentation/>');
    z.file('ppt/slides/slide1.xml', '<p:sld><p:cSld><p:spTree><a:t>Architecture</a:t></p:spTree></p:cSld></p:sld>');
    z.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><p:cSld><a:t>Note: call Bob Okafor at Northwind before the QBR</a:t></p:cSld></p:notes>');
    const prims = (await pptxExtractor('deck.pptx', await z.generateAsync({ type: 'uint8array' }))) as TextPrimitive[];
    expect(prims.some((p) => p.source.includes('slide1') && p.text.includes('Architecture'))).toBe(true);
    expect(prims.some((p) => p.source.includes('notes1') && p.text.includes('Bob Okafor'))).toBe(true);
  });
});
