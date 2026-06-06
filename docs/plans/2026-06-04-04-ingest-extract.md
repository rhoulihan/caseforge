# Ingest / Extract Implementation Plan (plan 04)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Format-agnostic ingest core: identify each file by CONTENT (magic bytes / structure), not extension, and extract it into normalized primitives (text / table / image / key-value) forming an EvidenceBundle. Pure, fully-testable core (detection + CSV/TSV/text/JSON + registry); binary parsers (msg/xlsx/pdf) plug into the same registry in a follow-up.

**Architecture:** `detect.ts` sniffs type; `csv.ts` is an RFC4180-ish delimited parser; `ingest.ts` walks files, dispatches via a parser registry to produce an `EvidenceBundle`, and honestly reports any file it recognized but could not yet extract. No I/O beyond the bytes passed in; runs identically in Node (tests) and the browser.

**Tech Stack:** TypeScript, Vitest.

---
- **Task 1:** `types.ts` (Primitive union, EvidenceBundle, DetectedType) + `detect.ts` (`detectType(name, bytes)`), TDD: pdf/png/jpeg/gif/ole/ooxml magic bytes; json/csv/tsv/text by content; unknown.
- **Task 2:** `csv.ts` (`parseDelimited(text, delim)`), TDD: simple, quoted fields with embedded delimiter/newline, escaped quotes, tsv.
- **Task 3:** `ingest.ts` (`ingest(files, extraExtractors?)` → EvidenceBundle), TDD: csv→table, png→image, json/text→text, binary (pdf/ooxml/ole) recorded as recognized-not-extracted (ok:false), unknown ok:false. Registry seam for binary parsers.

## Self-Review
- Realizes spec §6/§7 (format-agnostic ingest, content-not-extension). Binary parsers deferred (plug into the registry) — not a gap, sequenced.
- CSV is first-class (a primary raw input). Numeric reduction over Table primitives happens in the classify/sizing stages (later plans).
