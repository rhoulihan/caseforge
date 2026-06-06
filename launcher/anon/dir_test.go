package anon

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, dir, rel string, data []byte) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestProcessDirAnonymizesTextAndQuarantinesImages(t *testing.T) {
	in, out := t.TempDir(), t.TempDir()
	write(t, in, "notes.txt", []byte("Call Sandeep Kalidindi at Northwind."))
	write(t, in, "sub/chart.png", []byte{0x89, 0x50, 0x4e, 0x47, 0, 1, 2})
	entries := []Entry{{Phrase: "Sandeep Kalidindi", Slug: "CF_PERSON_01"}, {Phrase: "Northwind", Slug: "CF_ORG_01"}}
	rep, err := ProcessDir("anonymize", entries, in, out)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(out, "notes.txt"))
	if string(got) != "Call CF_PERSON_01 at CF_ORG_01." {
		t.Fatalf("anonymized text wrong: %q", got)
	}
	// image must NOT be in the main (LLM-bound) tree
	if _, err := os.Stat(filepath.Join(out, "sub", "chart.png")); !os.IsNotExist(err) {
		t.Fatal("image leaked into the main output tree")
	}
	// it must be quarantined
	if _, err := os.Stat(filepath.Join(out, FlaggedDir, "sub", "chart.png")); err != nil {
		t.Fatalf("image not quarantined: %v", err)
	}
	if rep.NumFlagged() != 1 {
		t.Fatalf("expected 1 flagged (the png), got %d", rep.NumFlagged())
	}
}

func TestProcessDirRoundTrip(t *testing.T) {
	in, out, back := t.TempDir(), t.TempDir(), t.TempDir()
	orig := "Sandeep Kalidindi at Northwind Mutual Insurance (Northwind)"
	write(t, in, "f.txt", []byte(orig))
	entries := []Entry{
		{Phrase: "Sandeep Kalidindi", Slug: "CF_PERSON_01"},
		{Phrase: "Northwind Mutual Insurance", Slug: "CF_ORG_01"},
		{Phrase: "Northwind", Slug: "CF_ORG_02"},
	}
	if _, err := ProcessDir("anonymize", entries, in, out); err != nil {
		t.Fatal(err)
	}
	if _, err := ProcessDir("deanonymize", entries, out, back); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(back, "f.txt"))
	if string(got) != orig {
		t.Fatalf("dir round-trip failed: got %q want %q", got, orig)
	}
}

func TestProcessDirSkipsReportFile(t *testing.T) {
	in, out := t.TempDir(), t.TempDir()
	write(t, in, "anonymize-report.txt", []byte("Northwind was here"))
	write(t, in, "f.txt", []byte("Northwind"))
	rep, err := ProcessDir("deanonymize", []Entry{{Phrase: "Northwind", Slug: "CF_ORG_01"}}, in, out)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rep.Results {
		if r.Path == "anonymize-report.txt" {
			t.Fatal("the report file must be skipped, not processed")
		}
	}
}

func TestPreflightAbortsOnSlugInSource(t *testing.T) {
	in, out := t.TempDir(), t.TempDir()
	write(t, in, "f.txt", []byte("ticket CF_ORG_01 about Northwind"))
	if _, err := ProcessDir("anonymize", []Entry{{Phrase: "Northwind", Slug: "CF_ORG_01"}}, in, out); err == nil {
		t.Fatal("expected preflight error: slug literal already in source")
	}
}

func TestNonUTF8Quarantined(t *testing.T) {
	in, out := t.TempDir(), t.TempDir()
	write(t, in, "weird.txt", []byte{0x41, 0xc3, 0x28, 0x42}) // invalid UTF-8, no NUL
	rep, err := ProcessDir("anonymize", nil, in, out)
	if err != nil {
		t.Fatal(err)
	}
	if rep.NumFlagged() != 1 {
		t.Fatalf("expected non-UTF8 file flagged, got %d", rep.NumFlagged())
	}
}

func TestLargeFileQuarantined(t *testing.T) {
	old := MaxTextBytes
	MaxTextBytes = 8
	defer func() { MaxTextBytes = old }()
	in, out := t.TempDir(), t.TempDir()
	write(t, in, "big.txt", []byte("this is more than eight bytes"))
	rep, err := ProcessDir("anonymize", nil, in, out)
	if err != nil {
		t.Fatal(err)
	}
	if rep.NumFlagged() != 1 {
		t.Fatalf("expected large file flagged, got %d", rep.NumFlagged())
	}
}

func TestSymlinkFlaggedNotFollowed(t *testing.T) {
	in, out := t.TempDir(), t.TempDir()
	write(t, in, "real.txt", []byte("Northwind"))
	if err := os.Symlink(filepath.Join(in, "real.txt"), filepath.Join(in, "link.txt")); err != nil {
		t.Skip("symlinks unsupported on this platform")
	}
	rep, err := ProcessDir("anonymize", []Entry{{Phrase: "Northwind", Slug: "CF_ORG_01"}}, in, out)
	if err != nil {
		t.Fatal(err)
	}
	flagged := false
	for _, r := range rep.Results {
		if r.Path == "link.txt" && r.Flagged {
			flagged = true
		}
	}
	if !flagged {
		t.Fatal("symlink should be flagged (not followed)")
	}
}

func TestLooksBinary(t *testing.T) {
	if looksBinary([]byte("plain ascii text\twith tabs\n")) {
		t.Fatal("ascii text misflagged as binary")
	}
	if !looksBinary([]byte{0x00, 0x41}) {
		t.Fatal("NUL byte not detected as binary")
	}
	if looksBinary([]byte("café — résumé")) {
		t.Fatal("utf-8 accents misflagged as binary")
	}
	if looksBinary([]byte{}) {
		t.Fatal("empty content should be treated as text")
	}
}
