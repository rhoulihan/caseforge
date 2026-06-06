import { describe, it, expect, vi } from 'vitest';
import { redactImage, LOW_CONFIDENCE, type RedactionDeps } from './index';
import type { OcrWord } from './match';
import type { MapEntry } from '../anon/mapping';

const bytes = (n: number) => new Uint8Array(n);
const word = (text: string, x0: number, conf = 90, line = 0): OcrWord => ({ text, bbox: { x0, y0: 10, x1: x0 + 40, y1: 28 }, confidence: conf, line });
const map: MapEntry[] = [{ phrase: 'Acme Corp', slug: 'CF_ORG_01' }];

function deps(words: OcrWord[], conf: number, ocrThrows = false): RedactionDeps & { paint: ReturnType<typeof vi.fn> } {
  const paint = vi.fn(async (...a: [Uint8Array, string, unknown]) => ({ bytes: new Uint8Array([1, 2, 3]), mime: a[1] === 'image/jpeg' ? 'image/jpeg' : 'image/png' }));
  return {
    ocr: ocrThrows
      ? vi.fn(async () => {
          throw new Error('worker boom');
        })
      : vi.fn(async () => ({ words, meanConfidence: conf })),
    paint,
  };
}

describe('redactImage', () => {
  it('paints matched phrases and returns redacted bytes', async () => {
    const d = deps([word('Acme', 0), word('Corp', 50)], 92);
    const r = await redactImage({ bytes: bytes(100), mime: 'image/png' }, map, 'Acme Corp', d);
    expect(r.redacted).toBe(true);
    expect(r.rectCount).toBeGreaterThan(0);
    expect(d.paint).toHaveBeenCalledTimes(1);
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]); // came from paint()
    expect(r.warning).toBeUndefined(); // high confidence
  });

  it('does not call paint and returns the original bytes when nothing matches', async () => {
    const d = deps([word('Revenue', 0), word('Q3', 50)], 95);
    const r = await redactImage({ bytes: bytes(100), mime: 'image/png' }, map, 'Acme Corp', d);
    expect(r.redacted).toBe(false);
    expect(r.rectCount).toBe(0);
    expect(d.paint).not.toHaveBeenCalled();
    expect(r.bytes.length).toBe(100); // original
  });

  it('warns (but still returns the image) when OCR confidence is low — send-with-warning policy', async () => {
    const d = deps([word('Acme', 0)], LOW_CONFIDENCE - 10);
    const r = await redactImage({ bytes: bytes(100), mime: 'image/png' }, map, 'Acme Corp', d);
    expect(r.warning).toMatch(/low text-recognition confidence/i);
    expect(r.redacted).toBe(true); // it still redacted what it found
  });

  it('on OCR failure, returns the un-redacted image with a loud warning (rep is the backstop)', async () => {
    const d = deps([], 0, true);
    const r = await redactImage({ bytes: bytes(100), mime: 'image/png' }, map, 'Acme Corp', d);
    expect(r.redacted).toBe(false);
    expect(r.bytes.length).toBe(100); // original, un-redacted
    expect(r.warning).toMatch(/could not scan|un-redacted/i);
    expect(d.paint).not.toHaveBeenCalled();
  });

  it('does NOT cry low-confidence on a graphical image where OCR found zero words', async () => {
    const d = deps([], 0); // OCR ran fine, just no text (conf 0 only because there are no words)
    const r = await redactImage({ bytes: bytes(100), mime: 'image/png' }, map, 'Acme Corp', d);
    expect(r.warning).toBeUndefined();
    expect(r.redacted).toBe(false);
  });

  it('reports the re-encoded MIME for a non-JPEG image so vision gets the right mediaType', async () => {
    const d = deps([word('Acme', 0)], 92);
    const r = await redactImage({ bytes: bytes(100), mime: 'image/webp' }, map, 'Acme Corp', d);
    expect(r.redacted).toBe(true);
    expect(r.mime).toBe('image/png'); // webp re-encoded to png by paint
  });
});
