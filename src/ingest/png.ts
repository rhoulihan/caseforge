// Minimal, dependency-free PNG encoder. Wraps raw 8-bit samples into a valid PNG using *stored*
// (uncompressed) zlib blocks — no compression library, no canvas, so it runs identically in Node and
// the browser. Used to turn the raw pixel buffers pdf.js decodes out of a PDF into a real image file the
// AI's vision model can read. Output is larger than a compressed PNG, but these images are bounded by the
// caller.

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// CRC32 (PNG chunk integrity) — table built once, then a tight per-byte loop over a chunk slice.
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(bytes: Uint8Array, start: number, end: number): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Adler32 (zlib stream integrity) over the raw (pre-compression) scanline bytes.
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Wrap `raw` in a zlib stream made entirely of stored (BTYPE=00, uncompressed) deflate blocks. A
 * decoder treats this as valid zlib; it just doesn't shrink. Each block holds up to 65535 bytes. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 0xffff;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let o = 0;
  out[o++] = 0x78; // CMF: deflate, 32K window
  out[o++] = 0x01; // FLG: no preset dict, fastest (checkbits make 0x7801 a multiple of 31)
  let off = 0;
  do {
    const len = Math.min(MAX, raw.length - off);
    const final = off + len >= raw.length ? 1 : 0;
    out[o++] = final; // BFINAL in bit0, BTYPE=00 (stored) in bits1-2
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    const nlen = ~len & 0xffff;
    out[o++] = nlen & 0xff;
    out[o++] = (nlen >>> 8) & 0xff;
    out.set(raw.subarray(off, off + len), o);
    o += len;
    off += len;
  } while (off < raw.length);
  const ad = adler32(raw);
  out[o++] = (ad >>> 24) & 0xff;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out.subarray(0, o);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false); // big-endian length
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length), false); // CRC over type+data
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Encode raw 8-bit samples into a PNG. `channels` is 1 (grayscale), 3 (RGB) or 4 (RGBA); `data` is
 * row-major with no padding (length must be width*height*channels). RGBA is composited onto a white
 * background (so transparent chart backgrounds read as white for OCR rather than collapsing to black).
 * Throws on bad dimensions / channel count / data length — the caller crash-isolates per image.
 */
export function encodePng(width: number, height: number, channels: number, data: ArrayLike<number>): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('png: bad dimensions');
  if (channels !== 1 && channels !== 3 && channels !== 4) throw new Error('png: unsupported channel count');
  if (data.length < width * height * channels) throw new Error('png: data too short');

  const gray = channels === 1;
  const outCh = gray ? 1 : 3;
  const colorType = gray ? 0 : 2; // 0 = grayscale, 2 = truecolour
  const stride = width * outCh;
  const raw = new Uint8Array(height * (1 + stride));
  let r = 0;
  for (let y = 0; y < height; y++) {
    raw[r++] = 0; // per-scanline filter: none
    const rowBase = y * width * channels;
    for (let x = 0; x < width; x++) {
      const s = rowBase + x * channels;
      if (gray) {
        raw[r++] = data[s]!;
      } else if (channels === 3) {
        raw[r++] = data[s]!;
        raw[r++] = data[s + 1]!;
        raw[r++] = data[s + 2]!;
      } else {
        const a = data[s + 3]! / 255;
        const inv = 255 * (1 - a);
        raw[r++] = Math.round(data[s]! * a + inv);
        raw[r++] = Math.round(data[s + 1]! * a + inv);
        raw[r++] = Math.round(data[s + 2]! * a + inv);
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  // ihdr[10..12] = compression 0, filter 0, interlace 0 (already zeroed)
  return concat([new Uint8Array(PNG_SIG), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]);
}
