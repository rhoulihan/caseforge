import { describe, it, expect } from 'vitest';
import { phrasesToRedact, computeRedactions, type OcrWord } from './match';
import type { MapEntry } from '../anon/mapping';

const word = (text: string, x0: number, line = 0, w = 40): OcrWord => ({ text, bbox: { x0, y0: 10, x1: x0 + w, y1: 28 }, confidence: 90, line });

describe('redaction/phrasesToRedact', () => {
  it('combines the rep map (with variants) and the detector over the OCR text', () => {
    const map: MapEntry[] = [{ phrase: 'Acme Corp', slug: 'CF_ORG_01' }];
    const phrases = phrasesToRedact(map, 'Dashboard for Acme Corp — owner jane@acme.com host db.prod.local', 'Acme Corp');
    expect(phrases).toContain('Acme Corp');
    expect(phrases.some((p) => p.includes('jane@acme.com'))).toBe(true); // detector found the email
    expect(phrases.some((p) => p.includes('db.prod.local'))).toBe(true); // detector found the FQDN
  });
});

describe('redaction/computeRedactions', () => {
  it('boxes a single-word match (padded, clamped at 0)', () => {
    const words = [word('Acme', 0), word('dashboard', 50)];
    const rects = computeRedactions(words, ['acme'], 4);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 0, y: 6, w: 48, h: 26 }); // x clamped to 0; 40+2*4 w; 18+2*4 h
  });

  it('stitches a multi-word phrase across adjacent same-line words into one box', () => {
    const words = [word('Northwind', 0), word('Mutual', 50), word('Insurance', 110)];
    const rects = computeRedactions(words, ['northwind mutual insurance'], 0);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBe(0);
    expect(rects[0]!.w).toBe(150); // spans from x0=0 to x1=150 (110+40)
  });

  it('does not box words on a different line for a multi-word phrase', () => {
    const words = [word('Northwind', 0, 0), word('Mutual', 0, 1)];
    expect(computeRedactions(words, ['northwind mutual'], 0)).toHaveLength(0);
  });

  it('returns nothing when no phrase matches', () => {
    expect(computeRedactions([word('Revenue', 0)], ['acme', 'northwind'], 4)).toHaveLength(0);
  });

  it('matches case-insensitively and on substrings (fail-closed over-redact)', () => {
    const rects = computeRedactions([word('ACME,', 0)], ['acme'], 0);
    expect(rects).toHaveLength(1);
  });
});
