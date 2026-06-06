// Package anon performs deterministic phrase<->slug substitution for CaseForge.
// The replace runs here (a compiled system utility), never via the LLM, so real
// phrases are never rendered in an AI prompt or context window.
package anon

import (
	"sort"
	"strings"
)

// Entry maps a sensitive phrase to an opaque slug.
type Entry struct {
	Phrase string
	Slug   string
}

type pair struct{ from, to string }

// replaceSinglePass scans left-to-right; at each position it emits the first
// (longest) matching `from` as its `to` and advances past it, so an emitted
// replacement is never re-scanned (no double-replacement, no phantom matches).
func replaceSinglePass(text string, pairs []pair) (string, int) {
	out := make([]byte, 0, len(text))
	count := 0
	i := 0
	for i < len(text) {
		matched := false
		for _, p := range pairs {
			if p.from == "" {
				continue
			}
			n := len(p.from)
			if i+n <= len(text) && text[i:i+n] == p.from {
				out = append(out, p.to...)
				i += n
				count++
				matched = true
				break
			}
		}
		if !matched {
			out = append(out, text[i])
			i++
		}
	}
	return string(out), count
}

func ordered(entries []Entry, reverse bool) []pair {
	pairs := make([]pair, 0, len(entries))
	for _, e := range entries {
		if reverse {
			pairs = append(pairs, pair{from: e.Slug, to: e.Phrase})
		} else {
			pairs = append(pairs, pair{from: e.Phrase, to: e.Slug})
		}
	}
	// longest `from` first, so e.g. "Northwind Mutual Insurance" wins over "Northwind"
	sort.SliceStable(pairs, func(a, b int) bool { return len(pairs[a].from) > len(pairs[b].from) })
	return pairs
}

// AnonymizeN replaces each phrase with its slug (longest phrase first, single pass) and returns the count.
func AnonymizeN(text string, entries []Entry) (string, int) {
	return replaceSinglePass(text, ordered(entries, false))
}

// DeanonymizeN replaces each slug with its phrase and returns the count.
func DeanonymizeN(text string, entries []Entry) (string, int) {
	return replaceSinglePass(text, ordered(entries, true))
}

// Anonymize replaces each phrase with its slug.
func Anonymize(text string, entries []Entry) string {
	s, _ := AnonymizeN(text, entries)
	return s
}

// Deanonymize replaces each slug with its phrase.
func Deanonymize(text string, entries []Entry) string {
	s, _ := DeanonymizeN(text, entries)
	return s
}

// ScanForSlugs returns slugs that already appear literally in text. Such a
// pre-existing slug would be corrupted on the deanonymize pass, so callers must
// treat a non-empty result as a hard error (regenerate the colliding slug).
func ScanForSlugs(text string, entries []Entry) []string {
	var found []string
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Slug != "" && !seen[e.Slug] && strings.Contains(text, e.Slug) {
			found = append(found, e.Slug)
			seen[e.Slug] = true
		}
	}
	return found
}
