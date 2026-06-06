// Command caseforge is the system-level launcher utility. Its anonymize/deanonymize
// subcommands perform deterministic phrase<->slug substitution so real phrases are
// never rendered in an AI prompt or context window.
//
// Exit codes: 0 ok · 1 runtime error · 2 usage/arg error · 3 files quarantined (without --allow-flagged).
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/rhoulihan/caseforge/launcher/anon"
)

func main() {
	if len(os.Args) < 2 {
		fail(2, "usage: caseforge <anonymize|deanonymize|serve> ...\n"+
			"  anonymize|deanonymize --map MAP.tsv --in SRC --out OUT [--force] [--allow-flagged]\n"+
			"  serve --app-dir DIR [--port 8080] [--no-open]")
	}
	mode := os.Args[1]
	if mode == "serve" {
		os.Exit(serveCLI(os.Args[2:]))
	}
	if mode != "anonymize" && mode != "deanonymize" {
		fail(2, "unknown subcommand %q (want anonymize|deanonymize|serve)", mode)
	}
	fs := flag.NewFlagSet(mode, flag.ExitOnError)
	mapPath := fs.String("map", "", "mapping TSV file (phrase<tab>slug)")
	inDir := fs.String("in", "", "input directory")
	outDir := fs.String("out", "", "output directory")
	force := fs.Bool("force", false, "allow writing into a non-empty --out")
	allowFlagged := fs.Bool("allow-flagged", false, "exit 0 even if files were quarantined")
	_ = fs.Parse(os.Args[2:])
	if *mapPath == "" || *inDir == "" || *outDir == "" {
		fail(2, "--map, --in and --out are all required")
	}

	absIn, err := filepath.Abs(*inDir)
	check(err)
	absOut, err := filepath.Abs(*outDir)
	check(err)
	if absIn == absOut {
		fail(2, "--in and --out must differ (refusing to overwrite the source in place)")
	}
	if isNested(absOut, absIn) || isNested(absIn, absOut) {
		fail(2, "--in and --out must not be nested inside one another")
	}
	if !*force && dirHasFiles(absOut) {
		fail(2, "--out %q is not empty; pass --force to write into it", *outDir)
	}

	mapBytes, err := os.ReadFile(*mapPath)
	check(err)
	entries, err := anon.ParseMap(string(mapBytes))
	check(err)
	if err := anon.Validate(entries); err != nil {
		fail(1, "invalid mapping: %v", err)
	}

	rep, err := anon.ProcessDir(mode, entries, absIn, absOut)
	if err != nil {
		fail(1, "%v", err)
	}

	reportPath := filepath.Join(absOut, mode+"-report.txt")
	check(os.WriteFile(reportPath, []byte(anon.FormatReport(rep)), 0o644))

	flagged := rep.NumFlagged()
	fmt.Printf("%s: %d file(s) processed, %d quarantined. Report: %s\n", mode, len(rep.Results), flagged, reportPath)
	if flagged > 0 && !*allowFlagged {
		fail(3, "%d file(s) quarantined to %s/ and NOT anonymized. Review/redact them, then re-run with --allow-flagged.", flagged, anon.FlaggedDir)
	}
}

// isNested reports whether child is inside parent.
func isNested(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil || rel == "." {
		return false
	}
	return !strings.HasPrefix(rel, "..")
}

func dirHasFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false // missing/unreadable → treat as creatable
	}
	return len(entries) > 0
}

func fail(code int, format string, a ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", a...)
	os.Exit(code)
}

func check(err error) {
	if err != nil {
		fail(1, "%v", err)
	}
}
