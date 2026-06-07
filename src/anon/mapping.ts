// The SPA's anonymization mapping model: build/validate the phrase→slug map and
// (de)serialize it as TSV. The TSV format MUST stay byte-identical to the Go launcher
// (launcher/anon/mapio.go): `escapedPhrase \t escapedSlug` per line, escaping \ \t \n \r.
// The replace itself runs in the launcher, never here — this module only builds the map.

import type { DetectedPhrase } from './detect';

export interface MapEntry {
  phrase: string;
  slug: string;
}

const CATEGORY: Record<string, string> = {
  org: 'ORG',
  person: 'PERSON',
  host: 'HOST',
  term: 'TERM',
};

/** Opaque, LLM-stable, zero-padded slug, e.g. suggestSlug('org', 1) -> 'CF_ORG_01'. */
export function suggestSlug(category: string, index: number): string {
  const cat = CATEGORY[category.toLowerCase()] ?? category.toUpperCase().replace(/[^A-Z0-9]/g, '') ?? 'TERM';
  return `CF_${cat || 'TERM'}_${String(index).padStart(2, '0')}`;
}

/** The CF_<PREFIX>_NN prefix `suggestSlug` would use for a category (e.g. 'org' -> 'ORG'). */
function slugPrefix(category: string): string {
  return suggestSlug(category, 1).replace(/^CF_/, '').replace(/_\d+$/, '');
}

/**
 * Build a map for `merged` (the full detected list) that PRESERVES every existing slug and only assigns
 * NEW slugs to phrases not already mapped, continuing each prefix's counter from the HIGHEST index
 * actually present in `existingMap`. This is the append-on-add-files map builder: it must NOT renumber
 * existing slugs (that would break what the LLM already saw + the slug-anonymized refinement history),
 * and must NOT reuse a live slug when a removed phrase left a numbering gap. With an empty `existingMap`
 * it is exactly the first-pass numbering (sequential per type).
 */
export function extendMap(existingMap: MapEntry[], merged: DetectedPhrase[]): MapEntry[] {
  const slugByPhrase = new Map(existingMap.map((m) => [m.phrase.toLowerCase(), m.slug]));
  // Seed each prefix's counter from the MAX numeric index in use, so a gap left by a removed phrase can
  // never make a new phrase collide onto a slug still held by a surviving one.
  const maxIdx: Record<string, number> = {};
  for (const m of existingMap) {
    const mm = /^CF_([A-Z0-9]+)_(\d+)$/.exec(m.slug);
    if (mm) maxIdx[mm[1]!] = Math.max(maxIdx[mm[1]!] ?? 0, Number(mm[2]));
  }
  return merged.map((d) => {
    const existing = slugByPhrase.get(d.phrase.toLowerCase());
    if (existing) return { phrase: d.phrase, slug: existing }; // keep the slug the LLM/history already know
    const prefix = slugPrefix(d.type);
    maxIdx[prefix] = (maxIdx[prefix] ?? 0) + 1;
    return { phrase: d.phrase, slug: suggestSlug(d.type, maxIdx[prefix]!) };
  });
}

function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Case + whitespace + NFC variants of a phrase (all map to the same slug). */
function variantsOf(phrase: string): string[] {
  // NFC and NFD forms so a decomposed-Unicode source occurrence still matches the literal (Go) matcher.
  const forms = [phrase.normalize('NFC'), phrase.normalize('NFD')];
  const cased = forms.flatMap((f) => [f, f.toLowerCase(), f.toUpperCase(), titleCase(f)]);
  const collapsed = cased.map((s) => s.replace(/[\s ]+/g, ' ').trim());
  return [...new Set([...cased, ...collapsed])].filter((s) => s.length > 0);
}

/**
 * Expand each user entry into all case/whitespace/NFC variants sharing its slug, so the
 * launcher's literal matcher catches every casing (the case-variant leak fix lives HERE,
 * the single source of truth). First phrase wins on collision.
 */
export function expandEntries(entries: MapEntry[]): MapEntry[] {
  const out: MapEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const v of variantsOf(e.phrase)) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push({ phrase: v, slug: e.slug });
      }
    }
  }
  return out;
}

/** Build the map to hand to the launcher: expand variants then serialize. */
export function buildMap(entries: MapEntry[]): string {
  return serializeMap(expandEntries(entries));
}

function escapeField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function unescapeField(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const c = s[i + 1]!;
      out += c === '\\' ? '\\' : c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c;
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

export function serializeMap(entries: MapEntry[]): string {
  return entries.map((e) => `${escapeField(e.phrase)}\t${escapeField(e.slug)}`).join('\n');
}

export function parseMap(tsv: string): MapEntry[] {
  const out: MapEntry[] = [];
  for (const line of tsv.split('\n')) {
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    if (tab < 0) throw new Error('mapping line missing tab separator');
    const phrase = unescapeField(line.slice(0, tab));
    if (phrase === '') throw new Error('mapping line has empty phrase');
    out.push({ phrase, slug: unescapeField(line.slice(tab + 1)) });
  }
  return out;
}

/** Longest phrase first — the order the launcher applies replacements in. */
export function orderedForward(entries: MapEntry[]): MapEntry[] {
  return [...entries].sort((a, b) => b.phrase.length - a.phrase.length);
}

export interface Validation {
  errors: string[];
  warnings: string[];
}

export function validateMap(entries: MapEntry[]): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.phrase) errors.push('empty phrase');
    if (!e.slug) errors.push(`entry "${e.phrase}" has an empty slug`);
    else if (e.slug === e.phrase) errors.push(`entry "${e.phrase}" maps to itself (slug equals phrase)`);
    else if (seen.has(e.slug)) errors.push(`duplicate slug "${e.slug}"`);
    seen.add(e.slug);
  }
  for (const a of entries) {
    for (const b of entries) {
      if (a !== b && a.phrase && b.phrase && a.phrase !== b.phrase && b.phrase.includes(a.phrase)) {
        warnings.push(`"${a.phrase}" is a substring of "${b.phrase}" (handled by longest-first ordering)`);
      }
    }
  }
  return { errors, warnings };
}
