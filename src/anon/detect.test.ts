import { describe, it, expect } from 'vitest';
import { detectCandidates, detectCandidatesInImage, mergeDetected, type DetectedPhrase } from './detect';
import type { EvidenceBundle } from '../ingest/types';

function find(out: DetectedPhrase[], phrase: string): DetectedPhrase | undefined {
  return out.find((d) => d.phrase.toLowerCase() === phrase.toLowerCase());
}

const bundle: EvidenceBundle = {
  files: [],
  primitives: [
    {
      kind: 'text',
      source: 'a.txt',
      text: 'We engaged Jane Okafor (jane.okafor@northwind.com) at Northwind Mutual Insurance. The server db-prod-01.nw.local (10.20.30.40) hosts it. Internally it is Project Atlas.',
    },
    { kind: 'table', source: 'b.csv', headers: ['Host', 'Owner'], rows: [['db-prod-01.nw.local', 'Jane Okafor']] },
    { kind: 'keyvalue', source: 'c.msg', pairs: { from: 'Jane Okafor', subject: 'Northwind sizing' } },
  ],
};

describe('detectCandidates', () => {
  const out = detectCandidates(bundle, 'Northwind Mutual Insurance');

  it('always includes the company name as an org at full confidence', () => {
    expect(find(out, 'Northwind Mutual Insurance')).toMatchObject({ type: 'org', confidence: 1.0 });
  });
  it('adds a salient company token', () => {
    const nw = find(out, 'Northwind');
    expect(nw?.type).toBe('org');
    expect(nw!.occurrences).toBeGreaterThanOrEqual(2);
  });
  it('detects an email as person', () => {
    expect(find(out, 'jane.okafor@northwind.com')).toMatchObject({ type: 'person', confidence: 0.9 });
  });
  it('detects an IPv4 as host (not as an FQDN)', () => {
    expect(find(out, '10.20.30.40')).toMatchObject({ type: 'host', confidence: 0.9 });
  });
  it('detects an FQDN as host with the right occurrence count', () => {
    const h = find(out, 'db-prod-01.nw.local');
    expect(h?.type).toBe('host');
    expect(h!.occurrences).toBe(2); // text + table
  });
  it('detects a proper-noun person and counts occurrences across primitives', () => {
    const j = find(out, 'Jane Okafor');
    expect(j?.type).toBe('person');
    expect(j!.occurrences).toBe(3); // text + table + keyvalue
  });
  it('excludes stop-word-led Title-Case phrases', () => {
    expect(find(out, 'The server')).toBeUndefined();
    expect(out.some((d) => d.phrase.split(/\s+/)[0] === 'The' || d.phrase.split(/\s+/)[0] === 'We')).toBe(false);
  });
  it('sorts by occurrences descending', () => {
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.occurrences).toBeGreaterThanOrEqual(out[i]!.occurrences);
  });
  it('detects accented / non-Latin names (privacy: must not be silently missed)', () => {
    const b: EvidenceBundle = {
      files: [],
      primitives: [{ kind: 'text', source: 'x', text: 'Proposal led by José Martínez and Björn Petersen.' }],
    };
    const o = detectCandidates(b, 'AnonCo');
    expect(find(o, 'José Martínez')).toMatchObject({ type: 'person' });
    expect(find(o, 'Björn Petersen')).toMatchObject({ type: 'person' });
  });

  it('surfaces a standalone surname of a detected person (fail-closed)', () => {
    // "Okafor" alone is detected because the full name "Jane Okafor" was detected.
    expect(find(out, 'Okafor')).toMatchObject({ type: 'person' });
  });

  it('keeps the company even when absent from the files, and emits nothing phantom', () => {
    const empty = detectCandidates({ files: [], primitives: [] }, 'Globex Corp');
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ phrase: 'Globex Corp', type: 'org', occurrences: 0 });
  });
});

describe('detectCandidatesInImage', () => {
  it('detects PII from OCR text and tags it with the image source', () => {
    const out = detectCandidatesInImage('Dashboard — Acme Corp · admin jane@acme.com · host db.prod.local', 'chart.png', 'Acme Corp');
    const email = out.find((d) => d.phrase.includes('jane@acme.com'));
    expect(email).toBeTruthy();
    expect(email!.source).toBe('image');
    expect(email!.imageSource).toBe('chart.png');
    expect(out.some((d) => d.phrase.includes('db.prod.local'))).toBe(true);
  });
});

describe('mergeDetected', () => {
  const txt: DetectedPhrase[] = [{ phrase: 'Acme Corp', type: 'org', occurrences: 3, confidence: 0.9 }];
  const img: DetectedPhrase[] = [
    { phrase: 'acme corp', type: 'org', occurrences: 1, confidence: 0.6, source: 'image', imageSource: 'chart.png' }, // dup (case-insensitive)
    { phrase: 'db.prod.local', type: 'host', occurrences: 2, confidence: 0.8, source: 'image', imageSource: 'chart.png' }, // image-only
  ];
  it('dedupes case-insensitively (text wins its source), accumulates occurrences, keeps the new image-only phrase', () => {
    const merged = mergeDetected(txt, img);
    expect(merged).toHaveLength(2);
    const acme = merged.find((d) => d.phrase.toLowerCase() === 'acme corp')!;
    expect(acme.phrase).toBe('Acme Corp'); // text entry kept
    expect(acme.source).toBeUndefined(); // stayed text-sourced
    expect(acme.occurrences).toBe(4); // 3 + 1
    const host = merged.find((d) => d.phrase === 'db.prod.local')!;
    expect(host.source).toBe('image'); // image-only phrase carries its badge
    expect(host.imageSource).toBe('chart.png');
  });
  it('keeps the HIGHER confidence when a shared phrase appears in both lists', () => {
    const lowTxt: DetectedPhrase[] = [{ phrase: 'Acme Corp', type: 'org', occurrences: 1, confidence: 0.5 }];
    const highImg: DetectedPhrase[] = [{ phrase: 'acme corp', type: 'org', occurrences: 1, confidence: 0.95, source: 'image', imageSource: 'c.png' }];
    expect(mergeDetected(lowTxt, highImg).find((d) => d.phrase.toLowerCase() === 'acme corp')!.confidence).toBe(0.95);
  });
  it('first list wins the source tag — image-first makes a shared phrase image-sourced (ordering contract)', () => {
    const merged = mergeDetected(img, txt); // image list passed FIRST
    const acme = merged.find((d) => d.phrase.toLowerCase() === 'acme corp')!;
    expect(acme.source).toBe('image'); // image entry was first → its tag wins
    expect(acme.occurrences).toBe(4); // still accumulates 1 + 3
  });
});
