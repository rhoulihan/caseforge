// Browser entry point for image redaction — wires the real tesseract OCR + canvas-paint shims into
// the pure orchestrator. The UI dynamically imports THIS module only when the rep scans images, so
// tesseract.js stays out of the main bundle (code-split, like the binary parsers).

import { redactImage, type RedactionResult } from './index';
import { recognizeWords, terminateOcr } from './ocr';
import { paintRedactions } from './paint';
import type { OcrWord } from './match';
import type { MapEntry } from '../anon/mapping';

export { terminateOcr, recognizeWords }; // recognizeWords: the detection-time OCR pass (reused at redaction)
export type { RedactionResult };

/** Redact an image. Pass `precomputed` (words from the detection OCR pass) to avoid re-OCR. */
export function redactImageInBrowser(
  img: { bytes: Uint8Array; mime: string },
  map: MapEntry[],
  companyName: string,
  precomputed?: { words: OcrWord[]; meanConfidence: number },
): Promise<RedactionResult> {
  return redactImage(img, map, companyName, { ocr: recognizeWords, paint: paintRedactions }, precomputed);
}
