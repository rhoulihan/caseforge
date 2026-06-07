// Local, deterministic detection of sensitive phrases in ingested evidence — runs BEFORE
// anonymization, with NO LLM (sending raw text to an AI for entity detection would leak the very
// names we protect). Emits candidates the rep reviews; the UI assigns slugs (suggestSlug) and the
// launcher does the replacement. Fail-closed bias: over-detect rather than miss.

import type { EvidenceBundle } from '../ingest/types';

export type PhraseType = 'org' | 'person' | 'host' | 'term';

export interface DetectedPhrase {
  phrase: string;
  type: PhraseType;
  occurrences: number;
  confidence: number; // 0..1, by detection method
  source?: 'image'; // set when the phrase was found by OCR'ing an image (text-derived ones leave it unset)
  imageSource?: string; // which image it came from (for the "from chart.png" badge), when source === 'image'
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const FQDN = /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}\b/g; // 3+ dotted labels (db.prod.local)
// Unicode-aware (\p{Lu}\p{L}+) so accented/non-Latin names (José, Björn) are NOT silently missed.
const PROPER = /\b\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+){1,3}\b/gu; // 2–4 Title-Case words

// KNOWN GAPS (best-effort detection; the rep reviews + can add manually — fail-closed by design):
// all-caps acronyms (IBM/AWS) are NOT auto-detected (would over-redact technical terms like CPU/SQL/ADB);
// hyphenated/apostrophe names (Jean-Luc, O'Brien) match only their sub-tokens; IDN emails/domains
// (accented domains) are not matched. Third-party org names should be added manually.

// Title-Case words that usually start a sentence/heading, not a name.
const STOP = new Set([
  'The', 'This', 'That', 'These', 'Those', 'A', 'An', 'In', 'On', 'For', 'And', 'Or', 'But', 'Our',
  'Your', 'We', 'It', 'As', 'At', 'By', 'To', 'Of', 'If', 'Is', 'Are', 'With', 'From', 'Per', 'Via',
  'All', 'Each', 'When', 'While', 'Note', 'See', 'Table', 'Figure', 'Section', 'Summary', 'Overview',
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Flatten every text-bearing primitive into one corpus for matching + counting. */
function corpusOf(bundle: EvidenceBundle): string {
  const parts: string[] = [];
  // Cells/values are joined with ' | ' (a non-word, non-space delimiter) so a Title-Case proper-noun
  // match cannot run across two unrelated cells (e.g. "Jane Okafor" | "Northwind …").
  for (const p of bundle.primitives) {
    if (p.kind === 'text') parts.push(p.text);
    else if (p.kind === 'table') {
      parts.push(p.headers.join(' | '));
      for (const r of p.rows) parts.push(r.join(' | '));
    } else if (p.kind === 'keyvalue') {
      parts.push(Object.values(p.pairs).join(' | '));
    }
  }
  return parts.join('\n');
}

function countOccurrences(corpus: string, phrase: string): number {
  if (!phrase) return 0;
  return (corpus.match(new RegExp(escapeRegExp(phrase), 'gi')) || []).length;
}

function isStoppy(phrase: string): boolean {
  const words = phrase.split(/\s+/);
  return words.every((w) => STOP.has(w));
}

/**
 * Detect candidate sensitive phrases in `bundle`, plus the user-supplied `companyName` (always
 * included as an org so it is never missed). Deduped case-insensitively, longest-first, sorted by
 * occurrences desc.
 */
export function detectCandidates(bundle: EvidenceBundle, companyName: string): DetectedPhrase[] {
  const corpus = corpusOf(bundle);
  // phraseKey(lowercased) -> candidate; first writer wins the type/confidence (company > email/ip > fqdn > proper).
  const found = new Map<string, { phrase: string; type: PhraseType; confidence: number }>();
  const add = (phrase: string, type: PhraseType, confidence: number): void => {
    const key = phrase.toLowerCase();
    if (!found.has(key)) found.set(key, { phrase, type, confidence });
  };

  // Company name (and a salient single token) — always redacted, even if 0 occurrences.
  const company = companyName.trim();
  if (company) {
    add(company, 'org', 1.0);
    const tokens = company.split(/\s+/).filter((w) => w.length >= 4 && /^[A-Z]/.test(w));
    if (tokens.length > 1 && tokens[0]) add(tokens[0], 'org', 0.9);
  }

  for (const m of corpus.match(EMAIL) || []) add(m, 'person', 0.9);
  for (const m of corpus.match(IPV4) || []) add(m, 'host', 0.9); // added before FQDN so dedup keeps the IP type
  for (const m of corpus.match(FQDN) || []) add(m, 'host', 0.8);
  for (const m of corpus.match(PROPER) || []) {
    const first = m.split(/\s+/)[0]!;
    if (STOP.has(first) || isStoppy(m)) continue;
    const words = m.split(/\s+/).length;
    add(m, words <= 2 ? 'person' : 'term', 0.6);
  }
  // Also surface the standalone surname of each detected person name (fail-closed: a bare "Okafor"
  // in a table cell would otherwise survive un-redacted). Lower confidence; deduped if already seen.
  for (const c of [...found.values()]) {
    if (c.type !== 'person') continue;
    const words = c.phrase.split(/\s+/);
    const surname = words[words.length - 1]!;
    if (words.length >= 2 && surname.length >= 4 && !STOP.has(surname)) add(surname, 'person', 0.5);
  }

  const out: DetectedPhrase[] = [];
  for (const c of found.values()) {
    const occ = countOccurrences(corpus, c.phrase);
    if (occ === 0 && c.phrase !== company) continue; // keep the full company name even if absent; drop other phantoms
    out.push({ phrase: c.phrase, type: c.type, occurrences: occ, confidence: c.confidence });
  }
  out.sort((a, b) => b.occurrences - a.occurrences || b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));
  return out;
}

/** Run the same local detection over text OCR'd from a single image, tagging each result with its
 * image source so the rep sees where it came from. Pure; no LLM. */
export function detectCandidatesInImage(ocrText: string, imageSource: string, companyName: string): DetectedPhrase[] {
  const bundle: EvidenceBundle = { primitives: [{ kind: 'text', source: imageSource, text: ocrText }], files: [] };
  return detectCandidates(bundle, companyName).map((d) => ({ ...d, source: 'image', imageSource }));
}

/** Merge candidate lists into one, deduped by case-insensitive phrase. The FIRST occurrence wins its
 * source tag (pass text-derived candidates first so a phrase seen in both stays "text"); occurrences
 * accumulate and the higher confidence is kept. Used to fold image-OCR findings into the rep's list. */
export function mergeDetected(...lists: DetectedPhrase[][]): DetectedPhrase[] {
  const byKey = new Map<string, DetectedPhrase>();
  for (const d of lists.flat()) {
    const k = d.phrase.toLowerCase();
    const existing = byKey.get(k);
    if (!existing) byKey.set(k, { ...d });
    else byKey.set(k, { ...existing, occurrences: existing.occurrences + d.occurrences, confidence: Math.max(existing.confidence, d.confidence) });
  }
  return [...byKey.values()].sort((a, b) => b.occurrences - a.occurrences || b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));
}
