# Changelog

All notable changes to **CaseForge** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

CaseForge is a portable, local-first AI sizing & business-case generator: a Preact + Vite
single-page app served by a small Go launcher (a `127.0.0.1` server exposing `/anonymize`,
`/deanonymize`, and `/health` plus the static SPA). A seven-step wizard walks a rep through
Setup → Drop files → Anonymize → Confirm → Generate → Refine → Export. Two invariants govern
every release below:

- **Determinism boundary** — the TypeScript engine computes every authoritative number; the LLM
  only researches prices, reads charts, and writes prose. It never decides a size or a cost.
- **Fail-closed anonymization** — detection runs locally (no LLM); the rep approves a fail-closed
  map; the launcher substitutes real text for slugs *before* any AI call. The anonymized content
  is the only thing that ever leaves the machine.

## [0.4.0] — Unreleased (pending manual OCR verification)

> Held for release: the OCR paths (image redaction and embedded-image scanning) exercise tesseract
> WASM + canvas, which CI/jsdom cannot run. This version is blocked on a manual in-browser
> verification of those paths. Everything below landed on `main` after the `v0.3.0` tag.

### Added

- **Local OCR image redaction before vision.** Chart/screenshot images are read by the LLM's vision
  model, so text baked into them could leak. A local, fully offline OCR pass (tesseract.js v7; WASM
  self-hosted under `/tesseract`, assets assembled by `scripts/setup-tesseract-assets.mjs`) finds
  matched phrases and paints opaque black boxes over them on a canvas *before* the image is used.
  The redaction module is split into a pure orchestrator (`src/redaction/index.ts`), a pure
  phrase→rectangle matcher (`match.ts`, unit-tested under Node), a tesseract shim (`ocr.ts`), a
  canvas shim (`paint.ts`), and a code-split browser entry (`browser.ts`) that keeps tesseract out
  of the main bundle.
- **Embedded-image extraction.** Ingest now pulls raster images out of containers and emits them as
  image primitives, so PII baked into charts and screenshots becomes reviewable: `.msg` image
  attachments, OOXML media (`(word|ppt|xl)/media/*`), and PDF image XObjects.
- **Dependency-free PNG encoder** (`src/ingest/png.ts`) — wraps raw pixel buffers (e.g. images
  pdf.js decodes out of a PDF) into a valid PNG using *stored* (uncompressed) zlib blocks; no canvas
  and no compression dependency, so it runs identically in Node and the browser.
- **Two-step Step 3 flow.** A "Scan images for hidden text" action OCRs every extracted image, folds
  any detected text into the rep-approved map (each image-derived phrase badged to its source image),
  and is **gated before** the Anonymize action. Source-tagged detection + merge live in
  `detectCandidatesInImage` and `mergeDetected` (`src/anon/detect.ts`).
- **MongoDB Atlas source-profile analysis.** Analysis + a runnable sample fixture under
  `samples/atlas-demo`, with the methodology and the (not-yet-implemented) Atlas tier model
  documented in `docs/ATLAS-SOURCE-PROFILE.md`.
- **Centralized sizing & cost config** (`src/engine/config.ts`) — the Autonomous Database sizing and
  cost constants are now adjustable in one place rather than scattered through the engine; the
  formulas and the sources they derive from are documented in `docs/SIZING-METHODOLOGY.md`.

### Changed

- **Redaction policy is SEND-WITH-WARNING.** OCR is best-effort: on failure or low confidence the
  image stays usable but is flagged, and the rep reviews every redacted preview in Step 3.
- **Redaction reuses the detection-pass OCR.** When an image is redacted it reuses the words the scan
  already recognized instead of running OCR a second time (`recognizeWords` is exported from
  `src/redaction/browser.ts` for exactly this).
- **Step-advance gate is fail-closed for images.** An `anonBundle` that contains an image is not
  advance-valid until those images have been reviewed (`stepValidity` / `imagesReviewed` in
  `src/ui/state.ts`).

### Fixed

- **OOM guards on PDF image decode.** pdf.js is given a `maxImageSize` so a crafted PDF can't force a
  giant decode, with a second pixel-cap check after decode as a backstop.
- **Per-page timeout race** (`PDF_IMAGE_EXTRACT_MS`, 20s) so a stuck pdf.js object can't wedge ingest.
- **Correct image targeting.** OCR cache, preview, and exclude state are keyed by primitive index
  (not by source), so two images sharing one source file can't redact the wrong one.
- **Honest scan-failure messaging** and **preview object URLs revoked on the error path**, so a throw
  mid-scan doesn't leak object URLs or leave a misleading "scanned" state.
- **Help/About modals no longer collapse** — the modal body is sized to its content with a sensible
  minimum height.

## [0.3.0] — 2026-06-06

> The `v0.3.0` tag is the combined release of the error-handling/help work and the broadened-ingest
> work. (An interim `v0.2.0` version bump for the error-handling milestone was folded into this
> release and never tagged separately.)

### Added

- **App-wide error handling + breadcrumb logging**, with an error-report dialog that composes a
  report to `rick.houlihan@oracle.com` (Outlook web compose, with a `mailto` fallback).
- **Per-file ingest reports with error categories** — each file that can't be extracted is
  classified (`unsupported_format`, `malformed_file`, `extractor_error`, `file_too_large`) rather
  than failing silently; partial results are preserved.
- **Help/FAQ and About modals** — About links to the sizing-methodology doc on the canonical repo.
- **Broadened ingest.** Added `docx`, `pptx`, `eml`, `html`, `xml`, `rtf`, and `webp` on top of the
  original `xlsx`/`pdf`/`msg`/`csv`/`txt`/image support. Container subtyping disambiguates OOXML
  (`xlsx`/`docx`/`pptx`) and OLE (`.msg`); markup→text helpers (`ooxmlParagraphsToText`,
  `ooxmlSlideText`, `htmlToText`) and PostalMime (`.eml`) turn each format into text primitives.

### Fixed

- **Zip-bomb and size guards on inputs** — an archive that would inflate to gigabytes is refused
  before exceljs/JSZip expands it into memory.

## [0.1.1] — 2026-06-06

### Added

- **Initial public release.** Portable, browser-based AI sizing & business-case generator built on a
  Preact + Vite SPA and a Go launcher (`127.0.0.1` server: `/anonymize`, `/deanonymize`, `/health`,
  and static SPA serving), TypeScript in strict mode, Vitest, and pnpm.
- **Seven-step wizard:** Setup → Drop files → Anonymize → Confirm → Generate → Refine → Export.
- **Determinism boundary** — the engine owns every authoritative number; the LLM only researches
  prices, reads charts, and writes prose.
- **Fail-closed local anonymization** — detect phrases locally, the rep approves a fail-closed map,
  and the launcher substitutes slugs for real text before any AI call.
- **Release & CI.** Tagging `vX.Y.Z` triggers a Release workflow that publishes per-OS launcher zips;
  CI runs build-test (the TypeScript suite + build) and launcher (Go tests).

[0.4.0]: https://github.com/rhoulihan/caseforge/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/rhoulihan/caseforge/compare/v0.1.1...v0.3.0
[0.1.1]: https://github.com/rhoulihan/caseforge/releases/tag/v0.1.1
