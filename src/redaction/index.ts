// Image redaction orchestrator. Ties the browser OCR + canvas-paint shims to the PURE matcher.
// Policy (rep-chosen): SEND-WITH-WARNING — OCR runs best-effort; matched phrases are boxed; if OCR
// fails or is low-confidence the image is still usable but carries a warning, and the rep reviews every
// redacted preview before it's used (Step 3). The OCR + paint deps are injected so this logic is
// unit-tested without a browser; the app passes the real tesseract/canvas shims.

import type { MapEntry } from '../anon/mapping';
import { phrasesToRedact, computeRedactions, type OcrWord, type RedactRect } from './match';

/** Below this mean OCR confidence (0..100) we warn that a name may have been missed. */
export const LOW_CONFIDENCE = 60;

export interface RedactionResult {
  bytes: Uint8Array; // redacted bytes (or the original, if OCR failed or nothing matched)
  mime: string;
  rectCount: number; // how many regions were painted over
  meanConfidence: number; // 0..100 (0 when OCR failed)
  redacted: boolean; // true iff at least one box was painted
  warning?: string; // set when the rep must look closely (OCR failed or low confidence)
}

export interface RedactionDeps {
  ocr: (bytes: Uint8Array, mime: string) => Promise<{ words: OcrWord[]; meanConfidence: number }>;
  paint: (bytes: Uint8Array, mime: string, rects: RedactRect[]) => Promise<Uint8Array>;
}

export async function redactImage(
  img: { bytes: Uint8Array; mime: string },
  map: MapEntry[],
  companyName: string,
  deps: RedactionDeps,
): Promise<RedactionResult> {
  let words: OcrWord[];
  let conf: number;
  try {
    const res = await deps.ocr(img.bytes, img.mime);
    words = res.words;
    conf = res.meanConfidence;
  } catch (e) {
    // OCR unavailable/failed → send un-redacted but flag it loudly (the rep is the backstop).
    return {
      bytes: img.bytes,
      mime: img.mime,
      rectCount: 0,
      meanConfidence: 0,
      redacted: false,
      warning: `Could not scan this image (${(e as Error).message}) — it will be sent un-redacted. Review it, or exclude it, before continuing.`,
    };
  }

  const ocrText = words.map((w) => w.text).join(' ');
  const phrases = phrasesToRedact(map, ocrText, companyName);
  const rects = computeRedactions(words, phrases);
  const bytes = rects.length > 0 ? await deps.paint(img.bytes, img.mime, rects) : img.bytes;

  const warning =
    conf < LOW_CONFIDENCE
      ? `Low text-recognition confidence (${Math.round(conf)}%) — a name in this image may not have been caught. Review it before continuing.`
      : undefined;

  return { bytes, mime: img.mime, rectCount: rects.length, meanConfidence: conf, redacted: rects.length > 0, warning };
}
