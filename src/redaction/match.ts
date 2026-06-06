// PURE core of image redaction (no browser, no OCR engine) — unit-tested under Node. Given the words
// an OCR pass found (text + pixel bounding box) and the phrases to hide, it computes the redaction
// rectangles. The phrase set reuses the rep's anonymization map (all case/whitespace/NFC variants) AND
// the local detector run over the OCR'd text — so it catches names the rep listed AND identifiers that
// only appear inside a screenshot. Fail-closed bias: substring matches count and boxes are padded.

import type { MapEntry } from '../anon/mapping';
import { expandEntries } from '../anon/mapping';
import { detectCandidates } from '../anon/detect';
import type { EvidenceBundle } from '../ingest/types';

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number; // tesseract 0..100
  line: number; // index used to group words on the same text line
}

export interface RedactRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// --- Tesseract Page → flat OcrWord[] (pure; tesseract v6/v7 returns only `blocks`, so we flatten it) ---
interface TessBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TessWord {
  text?: string;
  confidence?: number;
  bbox?: TessBbox;
}
interface TessLine {
  words?: TessWord[];
}
interface TessParagraph {
  lines?: TessLine[];
}
export interface TessBlock {
  paragraphs?: TessParagraph[];
}

/** Flatten Tesseract Page.blocks → words, assigning a line index so same-line words can be stitched. */
export function flattenOcrBlocks(blocks: TessBlock[] | undefined): OcrWord[] {
  const out: OcrWord[] = [];
  let line = 0;
  for (const b of blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          if (w.text && w.text.trim() && w.bbox) out.push({ text: w.text, bbox: w.bbox, confidence: w.confidence ?? 0, line });
        }
        line++;
      }
  return out;
}

/** Mean per-word confidence (0..100); 0 when there are no words. */
export function meanConfidence(words: OcrWord[]): number {
  if (words.length === 0) return 0;
  return words.reduce((s, w) => s + w.confidence, 0) / words.length;
}

/**
 * The phrases to redact from an image: the rep's map (expanded to every case/whitespace/NFC variant)
 * PLUS whatever `detectCandidates` finds in the OCR'd text (emails / IPv4 / FQDNs / proper nouns the
 * rep may never have added). Deterministic; no LLM.
 */
export function phrasesToRedact(map: MapEntry[], ocrText: string, companyName = ''): string[] {
  const fromMap = expandEntries(map).map((e) => e.phrase);
  const bundle: EvidenceBundle = { primitives: [{ kind: 'text', source: 'ocr', text: ocrText }], files: [] };
  const fromDetector = detectCandidates(bundle, companyName).map((d) => d.phrase);
  return [...new Set([...fromMap, ...fromDetector].map((p) => p.trim()))].filter((p) => p.length >= 2);
}

function rectOf(w: OcrWord, pad: number): RedactRect {
  return { x: Math.max(0, w.bbox.x0 - pad), y: Math.max(0, w.bbox.y0 - pad), w: w.bbox.x1 - w.bbox.x0 + 2 * pad, h: w.bbox.y1 - w.bbox.y0 + 2 * pad };
}

function unionRect(ws: OcrWord[], pad: number): RedactRect {
  const x0 = Math.min(...ws.map((w) => w.bbox.x0));
  const y0 = Math.min(...ws.map((w) => w.bbox.y0));
  const x1 = Math.max(...ws.map((w) => w.bbox.x1));
  const y1 = Math.max(...ws.map((w) => w.bbox.y1));
  return { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

function dedupe(rects: RedactRect[]): RedactRect[] {
  const seen = new Set<string>();
  return rects.filter((r) => {
    const k = `${r.x},${r.y},${r.w},${r.h}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Redaction rectangles over OCR words for every phrase. Single-token phrases box any word that
 * contains them; multi-token phrases stitch consecutive same-line words and box their union. Boxes are
 * padded (fail-closed). Pure — no browser, no canvas.
 */
export function computeRedactions(words: OcrWord[], phrases: string[], pad = 4): RedactRect[] {
  const byLine = new Map<number, OcrWord[]>();
  for (const w of words) {
    const arr = byLine.get(w.line) ?? [];
    arr.push(w);
    byLine.set(w.line, arr);
  }
  for (const arr of byLine.values()) arr.sort((a, b) => a.bbox.x0 - b.bbox.x0);

  const normalized = [...new Set(phrases.map(norm))].filter((p) => p.length >= 2);
  const rects: RedactRect[] = [];
  for (const phrase of normalized) {
    const tokens = phrase.split(' ');
    for (const lineWords of byLine.values()) {
      if (tokens.length === 1) {
        for (const w of lineWords) if (norm(w.text).includes(phrase)) rects.push(rectOf(w, pad));
      } else {
        for (let i = 0; i + tokens.length <= lineWords.length; i++) {
          const window = lineWords.slice(i, i + tokens.length);
          if (norm(window.map((w) => w.text).join(' ')).includes(phrase)) rects.push(unionRect(window, pad));
        }
      }
    }
  }
  return dedupe(rects);
}
