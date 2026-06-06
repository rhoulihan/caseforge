import { describe, it, expect } from 'vitest';
import { detectType } from './detect';

const u8 = (...b: number[]) => new Uint8Array(b);
const txt = (s: string) => new TextEncoder().encode(s);

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
});
