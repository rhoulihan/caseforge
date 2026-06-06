package anon

import "testing"

func TestMapRoundTrip(t *testing.T) {
	entries := []Entry{
		{Phrase: "Northwind, Inc.\t\"X\"", Slug: "CF_ORG_01"},
		{Phrase: "line1\nline2", Slug: "CF_TERM_02"},
		{Phrase: `back\slash`, Slug: "CF_TERM_03"},
	}
	got, err := ParseMap(FormatMap(entries))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(entries) {
		t.Fatalf("len %d want %d", len(got), len(entries))
	}
	for i := range entries {
		if got[i] != entries[i] {
			t.Fatalf("entry %d: got %+v want %+v", i, got[i], entries[i])
		}
	}
}

func TestParseMapErrors(t *testing.T) {
	if _, err := ParseMap("no-tab-here"); err == nil {
		t.Fatal("expected error for missing tab")
	}
	if _, err := ParseMap("\tCF_X"); err == nil {
		t.Fatal("expected error for empty phrase")
	}
}

func TestParseMapIgnoresBlankLines(t *testing.T) {
	got, err := ParseMap("a\tCF_1\n\n  \nb\tCF_2\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len %d want 2", len(got))
	}
}

func TestParseMapRejectsEmptySlug(t *testing.T) {
	if _, err := ParseMap("Northwind\t"); err == nil {
		t.Fatal("expected error for empty slug (would delete the phrase irreversibly)")
	}
}

func TestValidate(t *testing.T) {
	if err := Validate([]Entry{{Phrase: "A", Slug: "CF_1"}, {Phrase: "B", Slug: "CF_1"}}); err == nil {
		t.Fatal("expected duplicate-slug error")
	}
	if err := Validate([]Entry{{Phrase: "X", Slug: "X"}}); err == nil {
		t.Fatal("expected slug==phrase error")
	}
	if err := Validate([]Entry{{Phrase: "A", Slug: "CF_1"}, {Phrase: "B", Slug: "CF_2"}}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
