package anon

import (
	"strings"
	"testing"
)

var sample = []Entry{
	{Phrase: "Northwind Mutual Insurance", Slug: "CF_ORG_01"},
	{Phrase: "Northwind", Slug: "CF_ORG_02"},
	{Phrase: "Sandeep Kalidindi", Slug: "CF_PERSON_01"},
	{Phrase: "HOMDBPODSPRDH15.NORTHWIND.com", Slug: "CF_HOST_01"},
}

func TestAnonymizeBasic(t *testing.T) {
	got := Anonymize("Contact Sandeep Kalidindi at Northwind.", sample)
	want := "Contact CF_PERSON_01 at CF_ORG_02."
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestLongestPhraseFirst(t *testing.T) {
	got := Anonymize("Northwind Mutual Insurance and Northwind", sample)
	want := "CF_ORG_01 and CF_ORG_02"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestNoDoubleReplace(t *testing.T) {
	// a slug introduced by replacement must not be re-matched as a phrase
	entries := []Entry{{Phrase: "X", Slug: "CF_A"}, {Phrase: "CF_A", Slug: "CF_B"}}
	if got := Anonymize("X", entries); got != "CF_A" {
		t.Fatalf("got %q want CF_A", got)
	}
}

func TestUnicode(t *testing.T) {
	entries := []Entry{{Phrase: "Café Müller", Slug: "CF_ORG_01"}}
	if got := Anonymize("at Café Müller today", entries); got != "at CF_ORG_01 today" {
		t.Fatalf("got %q", got)
	}
}

func TestRoundTrip(t *testing.T) {
	in := "Sandeep Kalidindi runs Northwind Mutual Insurance on HOMDBPODSPRDH15.NORTHWIND.com (Northwind)."
	if got := Deanonymize(Anonymize(in, sample), sample); got != in {
		t.Fatalf("round-trip failed:\n got %q\nwant %q", got, in)
	}
}

func TestLeakCheck(t *testing.T) {
	in := "Sandeep Kalidindi at Northwind Mutual Insurance, host HOMDBPODSPRDH15.NORTHWIND.com and Northwind again"
	out := Anonymize(in, sample)
	for _, e := range sample {
		if strings.Contains(out, e.Phrase) {
			t.Fatalf("LEAK: phrase %q present in anonymized output %q", e.Phrase, out)
		}
	}
}

// With case variants in the map (as the TS builder generates), all casings are caught.
func TestLeakCheckCaseFoldedWithVariants(t *testing.T) {
	entries := []Entry{
		{Phrase: "Northwind", Slug: "CF_ORG_01"},
		{Phrase: "NORTHWIND", Slug: "CF_ORG_01"},
		{Phrase: "northwind", Slug: "CF_ORG_01"},
	}
	out := Anonymize("Northwind, NORTHWIND, and northwind walk into a bar", entries)
	if strings.Contains(strings.ToLower(out), "northwind") {
		t.Fatalf("case-variant leak: %q", out)
	}
}

func TestScanForSlugs(t *testing.T) {
	entries := []Entry{{Phrase: "Northwind", Slug: "CF_ORG_01"}}
	if got := ScanForSlugs("ref CF_ORG_01 here", entries); len(got) != 1 || got[0] != "CF_ORG_01" {
		t.Fatalf("got %v", got)
	}
	if got := ScanForSlugs("no slugs at all", entries); len(got) != 0 {
		t.Fatalf("expected none, got %v", got)
	}
}

func TestAdjacentSlugsRoundTrip(t *testing.T) {
	entries := []Entry{{Phrase: "Alpha", Slug: "CF_ORG_01"}, {Phrase: "Beta", Slug: "CF_ORG_02"}}
	in := "AlphaBeta and Alpha Beta"
	if got := Deanonymize(Anonymize(in, entries), entries); got != in {
		t.Fatalf("adjacent round-trip failed: %q", got)
	}
}
