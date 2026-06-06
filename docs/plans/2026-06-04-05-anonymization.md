# Anonymization Implementation Plan (plan 05)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Deterministic, system-level phrase↔slug substitution so real phrases never reach the LLM. Go launcher `anonymize`/`deanonymize` (the system utility) + the TS mapping model used by the SPA form.

**Architecture:** `launcher/` Go module: `anon` package (pure replace core + TSV map IO + directory processor with image flagging), `main.go` (CLI). `src/anon/mapping.ts`: slug suggestion + TSV serialize/parse + validation (the SPA's mapping model). CI gains a Go job. Two tested safety invariants: round-trip and leak-check.

**Tech Stack:** Go 1.23 (launcher), TypeScript/Vitest (mapping model), GitHub Actions.

---

### Task 1 (Go): replace core — longest-first, single-pass, with round-trip & leak-check invariants
- Files: `launcher/go.mod`, `launcher/anon/anon.go`, `launcher/anon/anon_test.go`
- Tests: basic forward/reverse; longest-phrase-first ("Northwind Mutual Insurance" before "Northwind"); no double-replace (introduced slug not re-matched); unicode; **round-trip** `Deanonymize(Anonymize(x))==x`; **leak-check** (no phrase in anonymized output).
- Run `go test ./...` red → implement `Entry`, `Anonymize`, `Deanonymize`, single-pass `replace` → green → commit.

### Task 2 (Go): TSV map IO
- Files: `launcher/anon/mapio.go`, `launcher/anon/mapio_test.go`
- Tests: `ParseMap`/`FormatMap` round-trip; escaping of tab/newline/backslash; phrases containing commas/quotes survive; malformed line errors.
- red → implement → green → commit.

### Task 3 (Go): directory processor + image flagging + CLI
- Files: `launcher/anon/dir.go`, `launcher/anon/dir_test.go`, `launcher/main.go`
- Tests (`ProcessDir(mode, entries, inDir, outDir) → Report`): text files anonymized to OUT (relative paths preserved); a `.png` copied through and flagged in `Report.Flagged`; report counts per file; deanonymize mode restores.
- `main.go`: flags `anonymize|deanonymize --map --in --out`; writes `anonymize-report.txt`. Build with `go build ./...`.
- red → implement → green → commit.

### Task 4 (Go): CI Go job
- File: `.github/workflows/ci.yml` (add a `launcher` job: setup-go 1.23, `go vet ./...`, `go test ./...`, `go build ./...`, working-directory `launcher`).
- Commit.

### Task 5 (TS): mapping model (SPA form logic)
- Files: `src/anon/mapping.ts`, `src/anon/mapping.test.ts`
- Tests: `suggestSlug(cat, i)` → `CF_<CAT>_0i` opaque/unique; `serializeMap`/`parseMap` TSV round-trip with escaping (matches the Go format); `validateMap` → errors (empty phrase, duplicate slug) + warning (phrase substring of another); `orderedForward` longest-first.
- red → implement → green → commit.

## Self-Review
- Realizes the approved anonymization spec. Safety invariants (round-trip, leak-check) are tests, not prose.
- Go (launcher) + TS (mapping model) share the TSV format by spec; each side round-trip-tested.
- Endpoints + SPA form UI deferred to the launcher/UI plans; image OCR redaction explicitly out of scope.
