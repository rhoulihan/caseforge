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

## [0.5.2] — 2026-06-09

### Fixed

- **OpenAI vision calls failed with `400 invalid_type`.** The provider adapter sent the Chat-Completions
  image shape (`image_url: { url }`) to the OpenAI **Responses** API, which expects `image_url` to be the
  data-URL **string** itself. Any OpenAI run with images — e.g. an Outlook `.msg` with embedded
  screenshots — failed at classification (`Invalid type for 'input[0].content[1].image_url'`). The adapter
  now sends the data URL directly.

### Added

- **Loading spinner during AI calls.** A small spinner now appears whenever the LLM is working —
  classification (Step 4), cost research and generation (Step 5), and refine (Step 6) — next to the
  existing status text. It inherits the surrounding text colour and respects `prefers-reduced-motion`.

## [0.5.1] — 2026-06-09

### Fixed

- **OpenAI provider was sent the Claude model id.** The UI hardcoded `claude-opus-4-8` and sent it to
  whichever provider the rep selected, so an OpenAI key got `400 model_not_found: The requested model
  'claude-opus-4-8' does not exist.` at the Research and Generate steps. A new
  `defaultModelFor(provider)` (`src/provider/`) maps `claude → claude-opus-4-8` and `openai → gpt-5.5`;
  classification (Step 4), cost research (Step 5), and generation (`buildRunConfig`) now derive the model
  from the selected provider instead of a hardcoded constant.

## [0.5.0] — 2026-06-08

> This release closes a class of silent-default bugs on the sizing/cost path and simplifies the image
> review. Its throughline is the determinism boundary's stricter cousin: **every value feeding the
> sizing/cost/DR/research paths must be file-derived or rep-entered — never a silently substituted
> constant.**

### Changed

- **On-disk storage is now a *required* sizing input.** `data.storageSizeGb` was promoted from
  *recommended* to *required*, so a missing storage size now **blocks** the case at the §8.5 gate
  instead of silently defaulting to a hardcoded **1000 GB** — a placeholder that previously flowed into
  the dominant ADB storage cost line, the cold-DR RTO, and the cost-research prompt. The value is
  threaded post-gate through the type system (out of `EcpuStorageRates`, which is now rate-only), so the
  cost math cannot run without it. A storage figure the rep *types at the gate* is recorded as a flagged
  assumption → the report grades **Directional**, never engineering-grade; storage *read from an
  artifact* stays engineering-grade. The cost-research profile now sources topology + storage from the
  **post-gate** merged bindings (no fabricated `?? 1 / ?? 8 / ?? 0` defaults; DR posture is omitted from
  the prompt when unbound rather than hardcoded to "warm").
- **Simplified Step-3 image review.** Each image keeps its single *send / exclude* toggle; the per-image
  acknowledgement checkbox is gone, replaced by **one "images verified clean" checkbox** at the bottom
  that the rep ticks before continuing (shown only when at least one image will be sent). The
  per-image `imageReviewKeys` / `imageAcknowledgedIds` state collapses to a single `imagesVerifiedClean`
  flag (archives from earlier versions load fine — it defaults to unset).

### Fixed

- **A rich Outlook `.msg` no longer drops its body prose.** When screenshots are pasted into a rich
  Outlook compose, the prose often lives only in the **HTML** body. `msgExtractor` read only the
  plain-text body, so stated topology — "3 shards", "Data size 45.8 TB", node/RAM counts — was silently
  lost while the embedded screenshots were still classified (the case came back BLOCKED with no
  indication why). The extractor now falls back to the HTML body via `htmlToText`; `data.storageSizeGb`
  is now extractable from prose (`llm-text`) with TB→GB normalization; and `isNoise` no longer discards
  a body that contains sizing facts just because it opens with a greeting or footer.

## [0.4.0] — 2026-06-07

> Everything below landed on `main` after the `v0.3.0` tag. A local OCR image-redaction experiment was
> built during this cycle and then **removed before release** (tesseract OCR garbled real-world dark-theme
> dashboards, and the WASM+canvas path could not be CI-verified). Images are instead sent to the AI's
> vision model **as-is**, with the rep responsible for reviewing/excluding them — see *Changed*. With the
> OCR path gone, v0.4.0 no longer has a CI-unverifiable blocker.

### Added

- **Comprehensive evidence analysis.** Every artifact the rep drops — in any modality, including images —
  is now mined for *both* quantitative sizing signals *and* qualitative deliverable context. A single
  Outlook `.msg` whose data lived only in embedded screenshots (an intake form + monitoring dashboards)
  now sizes end-to-end (it previously came back BLOCKED). The narrow chart reader was replaced with
  `readArtifactImage` (multi-panel, typed bindings: scalars/enums/per-role avg-peak) and `classifyText`
  (`src/classify/llm.ts`); an Atlas **tier → vCPU** lookup lets the LLM read the tier *string* while the
  engine computes the number (determinism boundary intact). Customer concerns / objections / timeline /
  positioning are extracted and woven into all four deliverables — slug-anonymized before the LLM, restored
  at render. The classify stage is now on the cost budget.
- **Customer discount on the proposed solution.** A per-case discount (0–100%, entered in Setup and
  adjustable in Refine) scales only the proposed Oracle components (ADB primary + warm/cold DR +
  migration PS) while the baseline on-prem spend stays at list, so savings and TCO reflect the rep's
  negotiated price. `src/engine/discount.ts` (`discountFactor`/`applyDiscount`) is a strict no-op at
  0% (goldens stay byte-identical); the renderer shows "list → your price (N% off)" and the prose
  context tells the LLM the Oracle figures are already net.
- **Always-current regeneration.** "Regenerate" (Step 6) and "Re-generate" (Step 5) now re-run the
  deterministic sizing + TCO engine with the *current* `ENGINE_CONFIG`, current rates, and the current
  discount — reusing the cached triage (no re-classify) — then rewrite prose. Reopening an old archived
  case and regenerating refreshes its numbers to today's rates rather than replaying frozen figures.
- **Business-case archives.** Each generated case is persisted as a portable, launcher-managed
  `~/CaseForge/archives/<caseId>.zip` containing the original source files, the anonymized bundle the
  LLM saw, every generated content package (versioned, never overwritten), and a resume log. A
  pre-wizard **home screen** lists saved cases (New / Open / Delete); opening one hydrates the wizard
  straight into Refine (no API key needed to view). The SPA owns the zip format (`src/archive/`); the
  Go launcher is a dumb blob store with new `PUT/GET/DELETE /archive/{id}` and `GET /archives` routes
  that peek only at `manifest.json`.
- **Refine continuity + versioned content packages.** Reopening a case replays its accumulating
  `refinementHistory` so the narrative continues rather than starting cold (the LLM layer is stateless,
  so "resume" is a deterministic `docModel` reload + instruction replay). Every generate/refine/add-files
  appends a new `versions/NNN/` package (`DocModel` + four deliverables + meta); prior versions are
  never deleted on regen.
- **Add more files during refine.** A Step 6 action returns to Drop files with the existing case
  retained; only the new files are detected and folded into the approved map via `extendMap`
  (existing slugs preserved, new slugs seeded from the max existing index so a removal gap can't cause
  a collision), then the case regenerates with the carried instruction applied.
- **Refinement-instruction anonymization (fail-closed).** The Step 6 free-text box and any carried
  add-files note run through local name-detection first: an instruction naming anything not in the
  approved map is **blocked** (never sent), otherwise it is slug-anonymized before reaching the LLM and
  the raw text is kept local in the resume log (`src/ui/refine.ts`).
- **Image evidence sent to vision, reviewed per-image (Step 3).** Chart/screenshot/dashboard images are
  sent to the AI's vision model so it can read the data in them. CaseForge does **not** alter image pixels;
  Step 3 surfaces a preview of every image that will be sent, with a prominent warning that the rep is
  responsible for its content, a per-image **"send this image to the AI"** exclude, and a fail-closed
  **"I have reviewed this image — it's safe to send"** acknowledgement that gates advancing. (A name the
  vision model reads *out of* an image is still slug-anonymized in the generated prose.)
- **Embedded-image extraction.** Ingest pulls raster images out of containers and emits them as image
  primitives so the vision model can read data baked into charts/screenshots: `.msg` image attachments,
  OOXML media (`(word|ppt|xl)/media/*`), and PDF image XObjects.
- **Dependency-free PNG encoder** (`src/ingest/png.ts`) — wraps raw pixel buffers (e.g. images pdf.js
  decodes out of a PDF) into a valid PNG using *stored* (uncompressed) zlib blocks; no canvas and no
  compression dependency, so it runs identically in Node and the browser.
- **MongoDB Atlas source-profile analysis.** Analysis + a runnable sample fixture under
  `samples/atlas-demo`, with the methodology and the (not-yet-implemented) Atlas tier model
  documented in `docs/ATLAS-SOURCE-PROFILE.md`.
- **Centralized sizing & cost config** (`src/engine/config.ts`) — the Autonomous Database sizing and
  cost constants are now adjustable in one place rather than scattered through the engine; the
  formulas and the sources they derive from are documented in `docs/SIZING-METHODOLOGY.md`.

### Changed

- **Step-4 gate: a provided value is the confirmation.** Removed the per-signal "confirm a real measurement"
  checkbox — entering a value in the gate now *is* the confirmation (a `manual` measurement); a blank input
  leaves the existing reading untouched. Less confusing, one fewer click.
- **A confident vision read is now engineering-grade.** The data-sufficiency engineering floor was lowered
  to the vision confidence cap (0.70), so a required signal read off a chart/screenshot at full vision
  confidence counts as *satisfied / engineering-grade* rather than a perpetual *directional estimate* — a
  value read from an image is as good as reading it off the source. Heuristic (0.60) and assumption-default
  (0.50) reads still sit below the floor, so a fuzzy or defaulted signal still reads as needs-confirmation.
  The extraction prompts were also strengthened to pull the shard / replica-set count and topology counts
  out of intake forms, tables, and prose — not just plotted charts.
- **Regeneration is no longer wording-only.** Earlier behavior froze the numbers at first generation
  and let refine change only prose. Regeneration now recomputes every authoritative number from current
  settings (see "Always-current regeneration" above); the determinism boundary is unchanged — the engine
  still owns the math, the LLM still only writes prose.
- **Removed the local OCR image-redaction experiment.** The tesseract OCR + canvas redaction module
  (`src/redaction/`), its self-hosted WASM assets, the `tesseract.js`/`tesseract.js-core` dependencies,
  and the Step-3 "scan images for hidden text" step were all removed. Real-world dark-theme dashboards
  garbled the OCR, and the WASM+canvas path could not be CI-verified. Images now go to vision **as-is**
  with a per-image rep-review gate (see *Added*). Text anonymization is unchanged.

### Fixed

- **Claims checklist was empty unless cost research ran.** The checklist was built only from caller-supplied
  claims, which the UI populated solely from "Research costs" — so a generate without research produced an
  empty Claims Checklist. `assembleDocModel` now synthesizes the authoritative sizing + TCO claims from the
  engine numbers (each with confidence derived from the signal coverage), merged with any researched cost
  claims and deduped by id (stable across a refine round-trip). The checklist now always covers the headline
  figures (shard count, vCPU, CPU utilization, provisioned base, on-prem/ADB cost, savings, payback).
- **OOM guards on PDF image decode.** pdf.js is given a `maxImageSize` so a crafted PDF can't force a
  giant decode, with a second pixel-cap check after decode as a backstop.
- **Per-page timeout race** (`PDF_IMAGE_EXTRACT_MS`, 20s) so a stuck pdf.js object can't wedge ingest.
- **Correct image targeting.** Image preview/exclude/review state is keyed by primitive index (not by
  source), so two images sharing one source file stay independent.
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

[0.4.0]: https://github.com/rhoulihan/caseforge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rhoulihan/caseforge/compare/v0.1.1...v0.3.0
[0.1.1]: https://github.com/rhoulihan/caseforge/releases/tag/v0.1.1
