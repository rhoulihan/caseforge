package anon

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// FileResult records what happened to one file.
type FileResult struct {
	Path         string // relative to the input dir
	Replacements int
	Flagged      bool // quarantined (image/binary/symlink/oversized/non-UTF8); NOT in the LLM-bound tree
	Reason       string
}

// Report summarizes a ProcessDir run.
type Report struct {
	Mode    string
	Results []FileResult
}

// NumFlagged is the count of quarantined files.
func (r Report) NumFlagged() int {
	n := 0
	for _, x := range r.Results {
		if x.Flagged {
			n++
		}
	}
	return n
}

// MaxTextBytes: files larger than this are flagged rather than loaded/substituted (var so tests can lower it).
var MaxTextBytes int64 = 64 << 20 // 64 MiB

var imageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".bmp": true, ".webp": true, ".tif": true, ".tiff": true,
}

// reportNames are written by ProcessDir; never (de)anonymize them when a prior output dir is reused as input.
var reportNames = map[string]bool{"anonymize-report.txt": true, "deanonymize-report.txt": true}

// FlaggedDir is the quarantine subdirectory; the SPA must NOT ingest it.
const FlaggedDir = "_FLAGGED"

func looksBinary(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	nonPrintable := 0
	for _, c := range b {
		if c == 0 {
			return true
		}
		if c < 9 || (c > 13 && c < 32) {
			nonPrintable++
		}
	}
	return float64(nonPrintable)/float64(len(b)) > 0.05
}

// classify returns (isText, flagReason). A non-empty reason means the file must be quarantined.
func classify(path string, size int64, data []byte) (bool, string) {
	if imageExts[strings.ToLower(filepath.Ext(path))] {
		return false, "image — may contain identifiers visible to the vision model; redact or exclude"
	}
	if size > MaxTextBytes {
		return false, fmt.Sprintf("too large (%d bytes) — review manually", size)
	}
	if looksBinary(data) {
		return false, "binary file — not text-anonymizable; review manually"
	}
	if !utf8.Valid(data) {
		return false, "non-UTF8 encoding (e.g. UTF-16) — re-export as UTF-8, then re-run"
	}
	return true, ""
}

// PreflightSlugConflicts scans text files for slug literals already present in the source
// (those would be corrupted on deanonymize). Returns "relpath: slug" descriptions.
func PreflightSlugConflicts(entries []Entry, inDir string) ([]string, error) {
	var conflicts []string
	err := filepath.WalkDir(inDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Type()&fs.ModeSymlink != 0 || reportNames[d.Name()] {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() > MaxTextBytes {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if isText, _ := classify(path, info.Size(), data); !isText {
			return nil
		}
		rel, _ := filepath.Rel(inDir, path)
		for _, slug := range ScanForSlugs(string(data), entries) {
			conflicts = append(conflicts, fmt.Sprintf("%s: %s", rel, slug))
		}
		return nil
	})
	return conflicts, err
}

// ProcessDir walks inDir; text files are (de)anonymized into outDir (relative paths preserved).
// Symlinks, images, binaries, oversized and non-UTF8 files are QUARANTINED to outDir/_FLAGGED
// (never the LLM-bound tree) and recorded as Flagged. On the anonymize pass it first aborts if
// any slug literal already exists in the source.
func ProcessDir(mode string, entries []Entry, inDir, outDir string) (Report, error) {
	rep := Report{Mode: mode}
	if mode == "anonymize" {
		conflicts, err := PreflightSlugConflicts(entries, inDir)
		if err != nil {
			return rep, err
		}
		if len(conflicts) > 0 {
			return rep, fmt.Errorf("slug literal(s) already present in source — regenerate the colliding slug(s):\n  %s",
				strings.Join(conflicts, "\n  "))
		}
	}
	err := filepath.WalkDir(inDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(inDir, path)
		if err != nil {
			return err
		}
		if reportNames[d.Name()] {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			rep.Results = append(rep.Results, FileResult{Path: rel, Flagged: true, Reason: "symlink — skipped (not followed); review manually"})
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		var data []byte
		if info.Size() <= MaxTextBytes {
			if data, err = os.ReadFile(path); err != nil {
				return err
			}
		}
		isText, reason := classify(path, info.Size(), data)
		if !isText {
			dst := filepath.Join(outDir, FlaggedDir, rel)
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			if info.Size() <= MaxTextBytes {
				if err := os.WriteFile(dst, data, 0o644); err != nil {
					return err
				}
			} else if err := streamCopy(path, dst); err != nil {
				return err
			}
			rep.Results = append(rep.Results, FileResult{Path: rel, Flagged: true, Reason: reason})
			return nil
		}
		var out string
		var count int
		if mode == "deanonymize" {
			out, count = DeanonymizeN(string(data), entries)
		} else {
			out, count = AnonymizeN(string(data), entries)
		}
		dst := filepath.Join(outDir, rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, []byte(out), 0o644); err != nil {
			return err
		}
		rep.Results = append(rep.Results, FileResult{Path: rel, Replacements: count})
		return nil
	})
	if err != nil {
		return rep, err
	}
	sort.Slice(rep.Results, func(a, b int) bool { return rep.Results[a].Path < rep.Results[b].Path })
	return rep, nil
}

func streamCopy(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// FormatReport renders a human-readable report.
func FormatReport(rep Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CaseForge %s report\n%d file(s)\n\n", rep.Mode, len(rep.Results))
	for _, r := range rep.Results {
		if r.Flagged {
			fmt.Fprintf(&b, "  [QUARANTINED] %s — %s\n", r.Path, r.Reason)
		} else {
			fmt.Fprintf(&b, "  [ok]          %s — %d substitution(s)\n", r.Path, r.Replacements)
		}
	}
	if n := rep.NumFlagged(); n > 0 {
		fmt.Fprintf(&b, "\n%d file(s) QUARANTINED to %s/ — NOT anonymized and NOT sent for analysis. Review/redact, then opt in explicitly.\n", n, FlaggedDir)
	}
	return b.String()
}
