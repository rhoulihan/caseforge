// Browser-only canvas shim: draw the image, paint opaque black boxes over the redaction rectangles,
// re-encode. NOT unit-tested — jsdom has no canvas/OffscreenCanvas; the rect computation is in match.ts
// and IS tested. Needs manual browser verify.

import type { RedactRect } from './match';

export async function paintRedactions(bytes: Uint8Array, mime: string, rects: RedactRect[]): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return bytes; // no 2d context → leave the image as-is (the caller warns + the rep reviews)
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = '#000000';
    for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
    // PNG for everything except JPEG (lossless boxes; both are vision-accepted).
    const type = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await canvas.convertToBlob({ type });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
