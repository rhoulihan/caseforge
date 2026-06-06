// Browser-only OCR shim over tesseract.js (WASM in a Web Worker). Assets are SELF-HOSTED under
// /tesseract (see scripts/setup-tesseract-assets.sh) so redaction works fully offline with no
// third-party network path. Lazy: the worker is created on first use. NOT unit-tested — jsdom has no
// WASM/Worker; the pure word→rect logic lives in match.ts and IS tested. Needs manual browser verify.

import { createWorker, type Worker } from 'tesseract.js';
import { flattenOcrBlocks, meanConfidence, type OcrWord, type TessBlock } from './match';

const ASSET_BASE = '/tesseract';
let workerPromise: Promise<Worker> | null = null;

function ocrWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1 /* LSTM */, {
      workerPath: `${ASSET_BASE}/worker.min.js`,
      corePath: ASSET_BASE,
      langPath: ASSET_BASE,
    });
  }
  return workerPromise;
}

/** OCR an image to words (text + pixel bbox + confidence). v7 returns only `blocks` — we flatten it. */
export async function recognizeWords(bytes: Uint8Array, mime: string): Promise<{ words: OcrWord[]; meanConfidence: number }> {
  const worker = await ocrWorker();
  const { data } = await worker.recognize(new Blob([new Uint8Array(bytes)], { type: mime }), {}, { blocks: true });
  const words = flattenOcrBlocks((data as unknown as { blocks?: TessBlock[] }).blocks);
  return { words, meanConfidence: meanConfidence(words) };
}

/** Tear down the worker (free WASM memory) — call when leaving the anonymize step. */
export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise;
    workerPromise = null;
    await w.terminate();
  }
}
