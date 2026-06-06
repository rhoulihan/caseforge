// The SPA's anonymization mapping model: build/validate the phrase→slug map and
// (de)serialize it as TSV. The TSV format MUST stay byte-identical to the Go launcher
// (launcher/anon/mapio.go): `escapedPhrase \t escapedSlug` per line, escaping \ \t \n \r.
// The replace itself runs in the launcher, never here — this module only builds the map.

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
