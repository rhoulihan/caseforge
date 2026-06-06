# Anonymization — Design

**Date:** 2026-06-04 · **Status:** Approved · Part of CaseForge (see `2026-06-04-adb-sizing-app-design.md`).

## Goal
Replace sensitive phrases (customer name, people, hostnames, …) with opaque slugs **before any analysis**, so the LLM provider only ever receives slugs; restore the real phrases in the **final deliverables**. The substitution is performed by a deterministic **system utility (the Go launcher)** — never by the model, and never by an agent reading the raw content — so real phrases are never rendered in an AI prompt or context window.

## Pipeline placement
`anonymize(source)` → SPA ingests anonymized output → analyze / generate (slugs only) → `deanonymize(artifacts)` → final deliverables.

## Components

### 1. Mapping model (TypeScript, in the SPA form)
- `MapEntry { phrase: string; slug: string }`; the map is an ordered list.
- **Slug suggestion:** opaque, LLM-stable tokens by category — `CF_ORG_01`, `CF_PERSON_02`, `CF_HOST_03`, `CF_TERM_04`… (uppercase, underscore, zero-padded index). Stable = unlikely to be paraphrased by the model and trivially matched on the reverse pass.
- **Serialize/parse:** TSV (`phrase⇥slug`), with `\t`/`\n`/`\\` escaped, so phrases may contain commas/quotes freely.
- **Validation:** non-empty phrases; unique slugs; warn on a phrase that is a substring of another (longest-first ordering makes this safe but the warning is useful); deterministic ordering = longest phrase first.
- Pure and unit-tested. The form UI ships with the SPA UI work; this model/logic is built now.

### 2. Replace core + CLI (Go launcher)
- `caseforge anonymize --map M --in SRC --out OUT` and `caseforge deanonymize --map M --in SRC --out OUT`.
- **Algorithm:** longest-phrase-first, **literal**, **single-pass** substitution — once a region is replaced it is not re-scanned, so an introduced slug can never be re-matched. Forward = phrase→slug; reverse = slug→phrase.
- Operates on **UTF-8 text** files. **Does not mutate** binary/image files; copies them through and records them in a report.
- **`anonymize-report`** (written to OUT): per-file replacement counts; text files anonymized; **every image/binary flagged for manual redaction or exclusion** (identifiers baked into images cannot be text-replaced — the rep's explicit decision).
- **stdin→stdout / local endpoint mode** so the SPA can route the *extracted text* of office/PDF/email docs through the same core before the LLM (single source of truth for the replace).
- Deterministic; non-zero exit on error; suitable for scripting.

### 3. Integration (later SPA/launcher plans)
- Launcher serves `POST /anonymize` and `/deanonymize` (same core) alongside the static SPA, so the browser routes extracted text through the system utility.
- The SPA mapping-builder form writes the TSV map; the rep runs (or the SPA triggers) anonymize before analysis and deanonymize after generation.

## Safety invariants (tested — the whole point)
- **Round-trip:** `deanonymize(anonymize(x)) == x` for text inputs (no data loss).
- **Leak-check:** the anonymized output contains **none** of the mapped phrases. Enforced as a test, analogous to the charts' `noCollisions`/`withinFrame` invariants.

## CI / testing
- Adds a **Go job** to CI (`go vet`, `go test`, `go build`) alongside the Node job.
- Go tests: replace core (ordering, no double-replace, unicode, escaping, round-trip, leak-check) + CLI (dir in/out, report, image flagging).
- TS tests: mapping model (slug suggestion uniqueness, TSV round-trip with escaping, validation).
- Adversarial review before merge (security-sensitive: a bug = leaked identifiers).

## Scope (YAGNI)
v1 = text + extracted-text anonymization + image flagging. **OCR-based image redaction is explicitly deferred.** Regex/fuzzy matching deferred (literal only).
