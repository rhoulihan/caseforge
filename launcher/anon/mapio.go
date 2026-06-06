package anon

import (
	"fmt"
	"strings"
)

// TSV mapping format: one entry per line, `escapedPhrase \t escapedSlug`.
// Escaping (both fields): \ -> \\, tab -> \t, newline -> \n, CR -> \r.
// This must stay byte-identical to the TypeScript mapping model (src/anon/mapping.ts).

func escapeField(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "\t", `\t`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	return s
}

func unescapeField(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			switch s[i+1] {
			case '\\':
				b.WriteByte('\\')
			case 't':
				b.WriteByte('\t')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			default:
				b.WriteByte(s[i+1])
			}
			i++
		} else {
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// FormatMap serializes entries to TSV.
func FormatMap(entries []Entry) string {
	lines := make([]string, 0, len(entries))
	for _, e := range entries {
		lines = append(lines, escapeField(e.Phrase)+"\t"+escapeField(e.Slug))
	}
	return strings.Join(lines, "\n")
}

// ParseMap parses TSV into entries. Blank lines are ignored; a line without a
// tab, or with an empty phrase, is an error.
func ParseMap(tsv string) ([]Entry, error) {
	var entries []Entry
	for n, line := range strings.Split(tsv, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		tab := strings.IndexByte(line, '\t')
		if tab < 0 {
			return nil, fmt.Errorf("line %d: missing tab separator", n+1)
		}
		phrase := unescapeField(line[:tab])
		slug := unescapeField(line[tab+1:])
		if phrase == "" {
			return nil, fmt.Errorf("line %d: empty phrase", n+1)
		}
		if slug == "" {
			return nil, fmt.Errorf("line %d: empty slug (would delete the phrase irreversibly)", n+1)
		}
		entries = append(entries, Entry{Phrase: phrase, Slug: slug})
	}
	return entries, nil
}

// Validate ensures the substitution table is invertible: no duplicate slugs and
// no no-op entry (slug == phrase). Empty fields are already rejected by ParseMap.
func Validate(entries []Entry) error {
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Slug == e.Phrase {
			return fmt.Errorf("entry %q maps to itself (slug == phrase)", e.Phrase)
		}
		if seen[e.Slug] {
			return fmt.Errorf("duplicate slug %q (would make deanonymize ambiguous)", e.Slug)
		}
		seen[e.Slug] = true
	}
	return nil
}
