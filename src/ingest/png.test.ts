import { describe, it, expect } from 'vitest';
import * as zlib from 'node:zlib';
import { encodePng } from './png';

const { inflateSync } = zlib;
// zlib.crc32 exists at runtime (Node 22.2+) but @types/node may predate it — reach it through a cast.
const nodeCrc32 = (zlib as unknown as { crc32: (buf: Buffer, value?: number) => number }).crc32;

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Walk a PNG's chunks, verifying each chunk's CRC32; returns the chunks by type. */
function parseChunks(png: Uint8Array): Record<string, Uint8Array> {
  expect([...png.subarray(0, 8)]).toEqual(SIG);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Record<string, Uint8Array> = {};
  let off = 8;
  // crc check reuses the same table-driven crc32 as the encoder
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (start: number, end: number): number => {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = table[(c ^ png[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  while (off < png.length) {
    const len = dv.getUint32(off, false);
    const type = String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!);
    const dataStart = off + 8;
    const stored = dv.getUint32(dataStart + len, false);
    expect(crc32(off + 4, dataStart + len)).toBe(stored); // CRC must match
    out[type] = png.subarray(dataStart, dataStart + len);
    off = dataStart + len + 4;
  }
  return out;
}

function ihdrFields(ihdr: Uint8Array): { width: number; height: number; bitDepth: number; colorType: number } {
  const dv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  return { width: dv.getUint32(0, false), height: dv.getUint32(4, false), bitDepth: ihdr[8]!, colorType: ihdr[9]! };
}

describe('encodePng', () => {
  it('produces a structurally valid PNG whose IDAT inflates to the expected RGB scanlines', () => {
    // 2x2 RGB: red, green / blue, white
    const data = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const png = encodePng(2, 2, 3, data);
    const chunks = parseChunks(png);
    expect(chunks.IHDR).toBeDefined();
    expect(chunks.IDAT).toBeDefined();
    expect(chunks.IEND).toBeDefined();
    expect(chunks.IEND!.length).toBe(0);
    const hdr = ihdrFields(chunks.IHDR!);
    expect(hdr).toEqual({ width: 2, height: 2, bitDepth: 8, colorType: 2 });

    const raw = new Uint8Array(inflateSync(Buffer.from(chunks.IDAT!)));
    // Each scanline = 1 filter byte (0) + 2 px * 3 ch.
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  });

  it('encodes single-channel data as grayscale (color type 0)', () => {
    const png = encodePng(3, 1, 1, new Uint8ClampedArray([10, 128, 255]));
    const chunks = parseChunks(png);
    expect(ihdrFields(chunks.IHDR!).colorType).toBe(0);
    const raw = new Uint8Array(inflateSync(Buffer.from(chunks.IDAT!)));
    expect([...raw]).toEqual([0, 10, 128, 255]); // filter byte + 3 gray samples
  });

  it('composites RGBA onto white (transparent → white, opaque → kept)', () => {
    // px0: opaque black; px1: fully transparent (any rgb) → white
    const png = encodePng(2, 1, 4, new Uint8ClampedArray([0, 0, 0, 255, 12, 34, 56, 0]));
    const chunks = parseChunks(png);
    expect(ihdrFields(chunks.IHDR!).colorType).toBe(2); // RGBA flattened to RGB
    const raw = new Uint8Array(inflateSync(Buffer.from(chunks.IDAT!)));
    expect([...raw]).toEqual([0, 0, 0, 0, 255, 255, 255]); // black kept, transparent → white
  });

  it('inflates a multi-block image (raw scanlines exceed 64KB) without corruption', () => {
    // 200x200 RGB → 200*(1+600) = 120,200 raw bytes → spans >1 stored block (65535 cap).
    const w = 200;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 3);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
    const png = encodePng(w, h, 3, data);
    const raw = new Uint8Array(inflateSync(Buffer.from(parseChunks(png).IDAT!)));
    expect(raw.length).toBe(h * (1 + w * 3));
    // spot-check the first pixel of the second scanline survived the block boundary
    const row1 = 1 * (1 + w * 3);
    expect(raw[row1]).toBe(0); // filter byte
    expect(raw[row1 + 1]).toBe(data[w * 3]!);
  });

  it('chunk CRCs match an INDEPENDENT oracle (node zlib.crc32), not just the encoder', () => {
    // Guards against a systematic bug in the encoder's own CRC that the parseChunks copy would also miss.
    const png = encodePng(2, 2, 3, new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let off = 8;
    let chunksChecked = 0;
    while (off < png.length) {
      const len = dv.getUint32(off, false);
      const typeAndData = png.subarray(off + 4, off + 8 + len); // CRC covers type + data
      const stored = dv.getUint32(off + 8 + len, false);
      expect(nodeCrc32(Buffer.from(typeAndData)) >>> 0).toBe(stored);
      chunksChecked++;
      off += 12 + len;
    }
    expect(chunksChecked).toBe(3); // IHDR, IDAT, IEND
  });

  it('throws on unsupported channel counts and bad dimensions', () => {
    expect(() => encodePng(1, 1, 2, new Uint8ClampedArray([0, 0]))).toThrow();
    expect(() => encodePng(0, 1, 3, new Uint8ClampedArray([]))).toThrow();
    expect(() => encodePng(2, 2, 3, new Uint8ClampedArray([1, 2, 3]))).toThrow(); // data too short
  });
});
