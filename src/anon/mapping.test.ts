import { describe, it, expect } from 'vitest';
import {
  suggestSlug,
  serializeMap,
  parseMap,
  validateMap,
  orderedForward,
  expandEntries,
  buildMap,
  extendMap,
  type MapEntry,
} from './mapping';
import type { DetectedPhrase } from './detect';

describe('suggestSlug', () => {
  it('builds opaque, stable, zero-padded slugs by category', () => {
    expect(suggestSlug('org', 1)).toBe('CF_ORG_01');
    expect(suggestSlug('person', 12)).toBe('CF_PERSON_12');
    expect(suggestSlug('host', 3)).toBe('CF_HOST_03');
  });
});

describe('extendMap (add-files: preserve existing slugs, append new without renumbering)', () => {
  const ph = (phrase: string, type: DetectedPhrase['type'], occurrences = 1): DetectedPhrase => ({ phrase, type, occurrences, confidence: 1 });

  it('with empty existing, behaves exactly like a fresh per-type numbering', () => {
    const detected = [ph('Acme Mutual', 'org'), ph('Jane Okafor', 'person'), ph('db.prod.local', 'host')];
    expect(extendMap([], detected)).toEqual([
      { phrase: 'Acme Mutual', slug: 'CF_ORG_01' },
      { phrase: 'Jane Okafor', slug: 'CF_PERSON_01' },
      { phrase: 'db.prod.local', slug: 'CF_HOST_01' },
    ]);
  });

  it('keeps existing slugs even when the merged sort order changes, and continues each type counter', () => {
    const existingMap: MapEntry[] = [
      { phrase: 'Acme Mutual', slug: 'CF_ORG_01' },
      { phrase: 'Jane Okafor', slug: 'CF_PERSON_01' },
    ];
    // New files bumped Jane to the front (more occurrences) and added two new phrases.
    const merged = [ph('Jane Okafor', 'person', 9), ph('Acme Mutual', 'org', 2), ph('Globex Re', 'org'), ph('Pat Lee', 'person')];
    const out = extendMap(existingMap, merged);
    const slugOf = (p: string) => out.find((m) => m.phrase === p)!.slug;
    expect(slugOf('Acme Mutual')).toBe('CF_ORG_01'); // unchanged despite reordering
    expect(slugOf('Jane Okafor')).toBe('CF_PERSON_01'); // unchanged
    expect(slugOf('Globex Re')).toBe('CF_ORG_02'); // new org continues after 01
    expect(slugOf('Pat Lee')).toBe('CF_PERSON_02'); // new person continues after 01
  });

  it('does NOT reuse a slug freed by a removed phrase (seeds from the max index, not the count)', () => {
    // Rep detected 2 orgs (CF_ORG_01, CF_ORG_02), then removed the first → a gap in the numbering.
    const afterRemoval: MapEntry[] = [{ phrase: 'Globex Re', slug: 'CF_ORG_02' }];
    // Add-files brings a 3rd org; it must NOT collapse onto CF_ORG_02 (the surviving phrase's slug).
    const out = extendMap(afterRemoval, [ph('Globex Re', 'org'), ph('Initech', 'org')]);
    const slugs = out.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // all distinct — no duplicate slug
    expect(out.find((m) => m.phrase === 'Globex Re')!.slug).toBe('CF_ORG_02'); // survivor unchanged
    expect(out.find((m) => m.phrase === 'Initech')!.slug).toBe('CF_ORG_03'); // continues past the max, skips the gap
  });
});

describe('serializeMap / parseMap (TSV, must match the Go launcher format)', () => {
  it('round-trips entries including tabs, newlines, and backslashes in phrases', () => {
    const entries: MapEntry[] = [
      { phrase: 'Northwind, Inc.\t"X"', slug: 'CF_ORG_01' },
      { phrase: 'line1\nline2', slug: 'CF_TERM_02' },
      { phrase: 'back\\slash', slug: 'CF_TERM_03' },
    ];
    expect(parseMap(serializeMap(entries))).toEqual(entries);
  });
  it('throws on a line without a tab and on an empty phrase', () => {
    expect(() => parseMap('no-tab-here')).toThrow();
    expect(() => parseMap('\tCF_X')).toThrow();
  });
  it('ignores blank lines', () => {
    expect(parseMap('a\tCF_1\n\n  \nb\tCF_2')).toHaveLength(2);
  });
});

describe('validateMap', () => {
  it('flags duplicate slugs and empty fields as errors', () => {
    const v = validateMap([
      { phrase: 'A', slug: 'CF_1' },
      { phrase: 'B', slug: 'CF_1' },
      { phrase: 'C', slug: '' },
    ]);
    expect(v.errors.length).toBeGreaterThanOrEqual(2);
  });
  it('warns when a phrase is a substring of another (handled by longest-first)', () => {
    const v = validateMap([
      { phrase: 'Northwind', slug: 'CF_ORG_02' },
      { phrase: 'Northwind Mutual Insurance', slug: 'CF_ORG_01' },
    ]);
    expect(v.warnings.some((w) => w.includes('substring'))).toBe(true);
    expect(v.errors).toHaveLength(0);
  });
});

describe('orderedForward', () => {
  it('orders longest phrase first', () => {
    const out = orderedForward([
      { phrase: 'Northwind', slug: 'b' },
      { phrase: 'Northwind Mutual Insurance', slug: 'a' },
    ]);
    expect(out[0]!.phrase).toBe('Northwind Mutual Insurance');
  });
});

describe('expandEntries / buildMap (case-variant leak fix)', () => {
  it('generates lower/UPPER/Title/original variants sharing one slug', () => {
    const out = expandEntries([{ phrase: 'Northwind Mutual', slug: 'CF_ORG_01' }]);
    const phrases = out.map((e) => e.phrase);
    expect(phrases).toContain('Northwind Mutual');
    expect(phrases).toContain('northwind mutual');
    expect(phrases).toContain('NORTHWIND MUTUAL');
    expect(out.every((e) => e.slug === 'CF_ORG_01')).toBe(true);
  });
  it('NFC-normalizes decomposed phrases', () => {
    const nfd = 'Café'; // "Café" with a combining accent
    const phrases = expandEntries([{ phrase: nfd, slug: 'CF_ORG_01' }]).map((e) => e.phrase);
    expect(phrases).toContain('Café'.normalize('NFC'));
  });
  it('adds a collapsed-whitespace variant', () => {
    const phrases = expandEntries([{ phrase: 'Northwind   Mutual', slug: 'CF_ORG_01' }]).map((e) => e.phrase);
    expect(phrases).toContain('Northwind Mutual');
  });
  it('buildMap serializes the expanded entries to TSV', () => {
    const tsv = buildMap([{ phrase: 'Northwind', slug: 'CF_ORG_01' }]);
    const parsed = parseMap(tsv);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed.every((e) => e.slug === 'CF_ORG_01')).toBe(true);
  });
});

describe('validateMap (hardened)', () => {
  it('flags empty slug and slug==phrase as errors', () => {
    expect(validateMap([{ phrase: 'A', slug: '' }]).errors.length).toBeGreaterThan(0);
    expect(validateMap([{ phrase: 'X', slug: 'X' }]).errors.length).toBeGreaterThan(0);
  });
});
