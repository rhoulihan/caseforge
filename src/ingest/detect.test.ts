import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { detectType } from './detect';

const u8 = (...b: number[]) => new Uint8Array(b);
const txt = (s: string) => new TextEncoder().encode(s);

/** A real zip containing the given entries (for OOXML subtype detection). */
async function zipWith(entries: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(entries)) z.file(k, v);
  return z.generateAsync({ type: 'uint8array' });
}

/** OLE2 magic followed by a UTF-16LE stream-name marker. */
function oleWith(marker: string): Uint8Array {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0];
  const m: number[] = [];
  for (const ch of marker) {
    const c = ch.charCodeAt(0);
    m.push(c & 0xff, (c >> 8) & 0xff);
  }
  return new Uint8Array([...magic, ...m]);
}

describe('detectType (by content, not extension)', () => {
  it('detects PDF by %PDF magic', () => {
    expect(detectType('whatever.bin', txt('%PDF-1.7\n%âãÏÓ'))).toBe('pdf');
  });
  it('detects PNG / JPEG / GIF by magic', () => {
    expect(detectType('a', u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    expect(detectType('a', u8(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(detectType('a', u8(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('gif');
  });
  it('detects OLE2 compound (msg/xls) and OOXML zip (xlsx/docx)', () => {
    expect(detectType('mail', u8(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('ole');
    expect(detectType('book', u8(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe('ooxml');
  });
  it('detects JSON, CSV, TSV, and plain text by content', () => {
    expect(detectType('x', txt('{"a":1,"b":[2,3]}'))).toBe('json');
    expect(detectType('x', txt('host,cpu,mem\na,0.2,128\nb,0.3,128'))).toBe('csv');
    expect(detectType('x', txt('host\tcpu\tmem\na\t0.2\t128'))).toBe('tsv');
    expect(detectType('x', txt('Just some prose.\nNo delimiters here at all.'))).toBe('text');
  });
  it('returns unknown for unrecognized binary', () => {
    expect(detectType('x', u8(0x00, 0x01, 0x02, 0x03))).toBe('unknown');
  });

  it('detects WEBP by RIFF....WEBP magic', () => {
    expect(detectType('chart', u8(0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50))).toBe('webp');
  });

  it('disambiguates OOXML zip subtypes by container contents', async () => {
    expect(detectType('a', await zipWith({ 'xl/workbook.xml': '<x/>', '[Content_Types].xml': '<t/>' }))).toBe('xlsx');
    expect(detectType('a', await zipWith({ 'word/document.xml': '<x/>', '[Content_Types].xml': '<t/>' }))).toBe('docx');
    expect(detectType('a', await zipWith({ 'ppt/presentation.xml': '<x/>', '[Content_Types].xml': '<t/>' }))).toBe('pptx');
    expect(detectType('a', await zipWith({ 'random/thing.txt': 'x' }))).toBe('ooxml'); // ambiguous zip → fallback
  });

  it('disambiguates OLE2 compound subtypes by stream names', () => {
    expect(detectType('m', oleWith('__substg1.0_0037001F'))).toBe('msg');
    expect(detectType('w', oleWith('WordDocument'))).toBe('doc');
    expect(detectType('x', oleWith('Workbook'))).toBe('xls');
    expect(detectType('o', oleWith('SomethingElse'))).toBe('ole'); // unknown compound → fallback
  });

  it('detects RTF, HTML, XML, and EML by content', () => {
    expect(detectType('n', txt('{\\rtf1\\ansi Hello\\par}'))).toBe('rtf');
    expect(detectType('p', txt('<!DOCTYPE html><html><body>hi</body></html>'))).toBe('html');
    expect(detectType('p', txt('<html><body>hi</body></html>'))).toBe('html');
    expect(detectType('s', txt('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('xml');
    expect(detectType('e', txt('From: a@x.com\r\nTo: b@y.com\r\nSubject: Hi\r\nMessage-ID: <1@x>\r\n\r\nBody text here.'))).toBe('eml');
  });

  it('does not mistake delimited data or prose for EML', () => {
    expect(detectType('x', txt('host,cpu,mem\na,0.2,128'))).toBe('csv');
    expect(detectType('x', txt('Just prose.\nNo headers here.'))).toBe('text');
  });

  it('does not misclassify a memo with header-like lines (no email address) as EML', () => {
    // From:/To:/Subject:/Date: present, but no @ or <addr> → must fall through to text, not eml.
    expect(detectType('memo', txt('From: Alice\r\nTo: Team\r\nSubject: Meeting notes\r\nDate: Monday\r\n\r\nDiscussed the migration plan.'))).toBe('text');
  });

  it('classifies HTML5 fragments (article/section/script) as html, not xml', () => {
    expect(detectType('a', txt('<article><p>Quarterly review</p></article>'))).toBe('html');
    expect(detectType('a', txt('<section>content</section>'))).toBe('html');
  });
});
