// Pure text extraction from markup formats (HTML / XML / RTF) and from OOXML run XML (docx/pptx).
// Regex/string based so it runs identically in the browser and in Node tests (no DOMParser dependency)
// and stays cheap — the goal is the readable text content, which is what the downstream LLM needs.
// PRIVACY: link targets (mailto:/href) are pulled into the text so emails/hosts there reach the
// local anonymizer. DoS: extraction is bounded — output accumulation stops at MAX_MARKUP_CHARS.

/** Cap on extracted text from a single markup/OOXML part — bounds peak allocation on hostile input. */
export const MAX_MARKUP_CHARS = 2_000_000;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode named (&amp;) and numeric (&#39; / &#x2014;) entities; unknown entities are left as-is. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED[ent.toLowerCase()] ?? m;
  });
}

/** Collapse runs of inline whitespace + tidy blank lines, preserving intentional line breaks. */
function collapse(s: string): string {
  return s
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Collect mailto:/URL/@-bearing link targets from href/src/data-* attributes (deduped). They are
 * appended to the extracted text so emails/hosts that appear ONLY in a link reach the anonymizer. */
function collectLinkTargets(s: string): string[] {
  const re = /\b(?:href|src|data-[\w-]+)\s*=\s*"(mailto:[^"]+|https?:\/\/[^"]+|[^"\s]*@[^"\s]+)"/gi;
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) targets.push(m[1]!.replace(/^mailto:/i, ''));
  return [...new Set(targets)];
}

/** Remove the inner content of <script>/<style> blocks (and comments) before stripping tags. */
function stripCode(s: string): string {
  return s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}

function appendTargets(text: string, targets: string[]): string {
  return targets.length ? `${text}\n${targets.join(' ')}` : text;
}

/** Extract readable text from HTML: drop script/style/comments, break on block tags, keep link targets. */
export function htmlToText(html: string): string {
  const cleaned = stripCode(html);
  const targets = collectLinkTargets(cleaned);
  const withBreaks = cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article|header|footer|ul|ol|blockquote)\s*>/gi, '\n');
  return appendTargets(collapse(decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))), targets);
}

/** Extract text from generic XML (incl. SVG): drop script/style, strip tags, keep link targets. */
export function xmlToText(xml: string): string {
  const cleaned = stripCode(xml);
  const targets = collectLinkTargets(cleaned);
  return appendTargets(collapse(decodeEntities(cleaned.replace(/<[^>]+>/g, ' '))), targets);
}

/** Remove non-text RTF control groups (pict/object/bin/fonttbl/…) honoring brace nesting. */
function dropRtfGroups(rtf: string): string {
  // {\pict …} or the ignorable {\*\keyword …}. (header/footer are NOT dropped — that text can hold PII.)
  const re = /\{\\(?:\*\\)?(pict|object|bin|fonttbl|colortbl|stylesheet|themedata|datastore|info)\b/gi;
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rtf)) !== null) {
    if (m.index < last) continue; // inside a group already removed
    let depth = 0;
    let j = m.index;
    for (; j < rtf.length; j++) {
      if (rtf[j] === '{') depth++;
      else if (rtf[j] === '}') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    result += rtf.slice(last, m.index) + ' ';
    last = j;
    re.lastIndex = j;
  }
  return result + rtf.slice(last);
}

/** Strip RTF control words/symbols/groups to plain text (handles \uNNNN and \'hh escapes). */
export function rtfToText(rtf: string): string {
  const s = dropRtfGroups(rtf)
    .replace(/\\u(-?\d+)\s?\??/g, (_m, n: string) => {
      const c = parseInt(n, 10);
      return Number.isFinite(c) ? String.fromCharCode(c & 0xffff) : '';
    })
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(par|line|pard)\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '') // remaining control words (+ optional trailing space)
    .replace(/\\[^a-zA-Z]/g, '') // control symbols (\{, \}, \\, etc.)
    .replace(/[{}]/g, '');
  return collapse(s);
}

/** docx: one line per <w:p>, concatenating its <w:t> runs (captures table-cell text too). Bounded. */
export function ooxmlParagraphsToText(documentXml: string): string {
  const out: string[] = [];
  let total = 0;
  for (const para of documentXml.split(/<\/w:p>/i)) {
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
    let text = '';
    let m: RegExpExecArray | null;
    while ((m = re.exec(para)) !== null) text += decodeEntities(m[1]!);
    text = text.trim();
    if (text) {
      out.push(text);
      total += text.length + 1;
      if (total > MAX_MARKUP_CHARS) break;
    }
  }
  return out.join('\n');
}

/** pptx slide: each <a:t> run as a line (titles, bullets, table cells, notes). Bounded. */
export function ooxmlSlideText(slideXml: string): string {
  const out: string[] = [];
  let total = 0;
  const re = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slideXml)) !== null) {
    const t = decodeEntities(m[1]!).trim();
    if (t) {
      out.push(t);
      total += t.length + 1;
      if (total > MAX_MARKUP_CHARS) break;
    }
  }
  return out.join('\n');
}
