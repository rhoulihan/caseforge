# Design Spec — CaseForge: Portable AI Sizing & Business-Case Generator

**Date:** 2026-06-04 · **Updated:** 2026-06-07 (current through v0.4.0) · **Status:** Built — public `v0.3.0` released; `v0.4.0` held pending manual OCR verification · **Author:** Rick Houlihan + Claude<br>
**One-line:** A self-contained, browser-based app a sales rep extracts and runs locally; it ingests a folder of customer artifacts, uses the rep's own Claude or OpenAI key to reproduce the exact sizing → proposal → business-case workflow we ran by hand, and produces an internal technical review, a customer-facing brief, and a high-level business case, with an assimilate-feedback-and-refine loop.

> **Update note (2026-06-07).** The product is built and named **CaseForge** (Preact + Vite SPA, Go launcher, TypeScript strict, Vitest, pnpm). It shipped publicly as `v0.1.1` → `v0.3.0` (the `v0.3.0` tag folded in an interim `v0.2.0` error-handling milestone); `v0.4.0` is staged but held for a manual in-browser OCR verification CI can't run. This document keeps its original design intent and adds the parts that became real: a local **anonymization** subsystem (the original "confidentiality warning" hardened into a fail-closed detect→map→replace pipeline), an **image-redaction** module, **embedded-image extraction** with a dependency-free PNG encoder, the concrete **seven-step wizard**, app-wide **error handling**, and the **CI/Release** pipeline. Sections updated in place are marked where the original draft and shipped reality differ. The canonical version story lives in `CHANGELOG.md`; sizing math + sources in `docs/SIZING-METHODOLOGY.md`.

---

## 1. Problem & goals

Field reps need to size a non-Oracle workload onto Oracle Autonomous Database (ADB) and produce credible, on-brand proposals and a TCO business case — the multi-hour expert workflow we just executed for a real customer. Goal: package that workflow so any rep can run it on their laptop in minutes, with no software install and no central service handling customer data.

**Goals**
- Reproduce the proven pipeline: ingest → extract → classify → analyze (vision) → deterministic sizing → assumptions gate → generate 3 outputs → verify → refine.
- Self-contained: extract a zip, run a tiny launcher, work in the browser. No runtime/install.
- Bring-your-own-key: works with **Claude or OpenAI**, the rep's key, billed to the rep.
- Customer documents stay on the laptop (parsed client-side); **only anonymized evidence** is sent to the rep's chosen LLM provider.
- Outputs: (1) internal technical review, (2) customer-facing brief, (3) high-level business case, plus (4) a claims→evidence checklist — each refinable from feedback.
- On-brand and consistent: the methodology, sizing model, Oracle exec-summary templates, and the global SVG house style are baked in.

**Non-goals (v1)**
- Multiple source databases (designed-for, not built — see §16).
- A hosted multi-tenant service or any server that sees customer data.
- Replacing Phase-2 engineering; this produces Phase-1 *notional* deliverables, clearly labeled.

## 2. Locked decisions
| # | Decision | Choice |
|---|---|---|
| D1 | Packaging | **Static SPA + tiny per-OS Go launcher** (serves `127.0.0.1`, opens browser). All logic + key client-side. |
| D2 | Providers | **Claude and OpenAI**, BYO-key, direct browser calls (Claude via the `anthropic-dangerous-direct-browser-access` header; OpenAI via a thin `fetch` wrapper, no SDK). |
| D3 | Cost/pricing research | **Live provider web-search tool** at run time (needs internet for the business case). |
| D4 | Source scope | **MongoDB → ADB only in v1, built behind a Source-Profile seam** for future DBs. |
| D5 | Run model | **Hybrid**: auto first-draft, one mandatory "confirm assumptions / fill gaps" gate, then jump-in-and-regenerate any stage. |
| D6 | Confidentiality | **Fail-closed local anonymization** (see §6a) — detection runs locally with no LLM, the rep approves a map, the launcher substitutes slugs *before* any AI call. The anonymized content is the only thing that leaves the machine. Provider calls default to zero-retention / no-train endpoints. |
| D7 | Ingest | **Format-agnostic**: identify evidence by *content/role*, not file extension (see §6–§7). |
| D8 | Determinism boundary | The TypeScript engine computes **every authoritative number**; the LLM only researches prices, reads charts, and writes prose. It never decides a size or a cost. |

> **Update note.** D6 originally read "in-app warning not to share customer-identifiable information." That warning hardened into a real subsystem (§6a): nothing customer-identifiable reaches an LLM unless the rep mis-approves the map. D8 was implicit in the draft (§3 "Determinism where it counts"); it is now an explicit, enforced invariant.

## 3. Guiding principles
- **Format-agnostic, content-first.** The app figures out *what each artifact is* (a CPU time-series, a topology table, a licensing doc, a metrics chart) regardless of how it arrived (`.msg`, `.eml`, CSV, PDF, `.docx`/`.pptx`/`.xlsx`, screenshot, pasted text). Detection is by magic bytes / structure, never the extension (`src/ingest/detect.ts`).
- **Make sense of a dump; name the gaps.** Reps will drop a pile of mixed, partly-irrelevant files. The app inventories and identifies what's there, ignores the noise, and produces an explicit, up-front *what's-missing* report tied to result quality — so a rep knows exactly what to collect from the customer before incomplete data yields a weak proposal. **Telling the rep what's missing is a primary feature, not an afterthought.**
- **Determinism where it counts (D8).** All sizing/TCO numbers come from a pure-JS engine (`src/engine/`, the ported `sizing_calc`/`tco_calc`, constants centralized in `src/engine/config.ts`); the LLM reads charts and writes prose but never computes totals.
- **Fail-closed anonymization (D6).** Real names, hosts, addresses, and the company name are detected locally and replaced with opaque slugs by the launcher *before* any AI call. The bias is to over-detect; the rep prunes false positives.
- **Evidence → claims traceability.** Every quantified claim in an output maps back to its evidence/source — the checklist data model is built by `src/render/claims.ts` (`buildChecklist`) and rendered by `renderClaimsChecklist`.
- **BYO-key, data stays local.** Documents are parsed in the browser; only the **anonymized** evidence is sent to the rep's provider, over a zero-retention endpoint.
- **Baked-in expertise.** Methodology, prompts, sizing model, doc templates, and SVG house style ship with the app so quality is consistent across a broad salesforce.

## 4. Architecture overview

```
┌── Go launcher (per-OS binary `caseforge`) ─────────────────────────────────────────────┐
│  serve --app-dir DIR : 127.0.0.1-only HTTP server                                       │
│    • static SPA serving (path-traversal-guarded, no bare FileServer)                    │
│    • POST /anonymize    real text → slugs (fail-closed, slug-conflict hard-fail)        │
│    • POST /deanonymize  slugs → real text (no-store; LLM output only)                   │
│    • GET  /health                                                                       │
│  Never sees the API key. Stateless: each request parses its own pre-expanded map.       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                     │ http://127.0.0.1:PORT
┌────────────────────▼─────────────────────────────────────────── Browser SPA (Preact) ───┐
│  7-step wizard: Setup → Drop files → Anonymize → Confirm → Generate → Refine → Export    │
│  Orchestrator (src/orchestrate) ─drives─► pipeline stages, token/cost budget, gate       │
│     │                                                                                    │
│  Ingest (content sniff + container extractors + embedded-image extraction + PNG encoder) │
│     → Anonymize (local detect → rep-approved map → launcher slug replace; image OCR gate)│
│     → Classify/Triage (heuristics + numeric stats + LLM vision/text) → Evidence Bundle   │
│     │                                                                                    │
│  Source Profile (MongoDB): signal schema · sizing model · prompt templates · cost model  │
│     │                                                                                    │
│  Sizing/TCO engine (deterministic JS, config-driven)   Chart generator (SVG house style) │
│     │                                                                                    │
│  Doc renderer → 3 outputs + claims checklist (HTML + print-to-PDF)   Refine module       │
│     │                                                                                    │
│  Provider adapter ──HTTPS──► Claude OR OpenAI (vision, web-search tool, JSON, BYO-key)    │
│  Redaction module (tesseract.js OCR + canvas paint, code-split, fully offline)           │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

> **Update note.** The launcher gained the `/anonymize`, `/deanonymize`, `/health` endpoints (plus a standalone `anonymize`/`deanonymize` directory-mode CLI) — it is no longer "never sees docs," it sees *raw text only to slug-replace it locally*, and still never sees the API key. The pipeline gained an explicit **Anonymize** stage between ingest and classify, and a **Redaction** module for images.

## 5. Provider adapter (the only provider-specific code)
A single `LLM` interface (`src/provider/types.ts`); everything else is provider-agnostic.
```ts
interface LLM {
  complete(opts: {
    system?, messages, images?,        // vision: base64 image blocks
    webSearch?,                         // hosted web_search tool
    jsonSchema?,                        // structured output (validated)
    model, maxTokens?, signal?         // no temperature/top_p/budget_tokens — Opus 4.8 rejects them
  }): Promise<{ text, usage }>          // usage → cost meter
}
```
Implementations: `ClaudeLLM` (Messages API + `anthropic-dangerous-direct-browser-access: true` header + `web_search` tool, currently tool type `web_search_20260209`) and `OpenAILLM` (a thin `fetch` wrapper over the Responses API `/v1/responses` with `store: false` for zero-retention + the `web_search` tool — no SDK, no browser-escape flag). Both translate `images` into the provider's native image block (Claude `image`/base64 source; OpenAI `input_image` data URL). Shared `retry.ts` handles rate-limit backoff; `errors.ts` maps wire failures to a typed `ProviderError`; `transport.ts` is an injectable seam so the adapters are unit-tested without network. A `createLLM(provider, cfg)` factory (`src/provider/index.ts`) is the rest of the app's only entry point. Model IDs are passed in from config so they're updatable without code changes (default `claude-opus-4-8`); consult the Claude API reference for current Claude model IDs at build time. Web-search multi-turn continuation is intentionally **not** supported in v1 — a tool-call-only response surfaces a loud error rather than a blank result.

## 6. Ingest & extract (format-agnostic)
- **Folder pick:** `<input type="file" webkitdirectory>` (universal; no secure-context needed).
- **Type detection by content, not extension** (`src/ingest/detect.ts`): magic-byte / structure sniffing. Containers are *disambiguated*: a zip is opened to read its central-directory names → `xlsx`/`docx`/`pptx` (fallback `ooxml`); an OLE2 compound file is sniffed for stream names → `msg`/`xls`/`doc` (fallback `ole`); RFC822 emails (`.eml`) are recognized by a header-block heuristic that requires an address-bearing header so a plain memo isn't misread as mail. Text-like content is further classified into `html`/`xml`/`rtf`/`json`/`csv`/`tsv`/`text`.
- **Container extractor plugins** (each yields *primitives*; `src/ingest/binary.ts`):
  - **PDF** — `unpdf`/pdf.js: merged page text **plus embedded image XObjects** (see §6b).
  - **OOXML** — `exceljs` for `.xlsx` (one table per sheet), JSZip + markup helpers for `.docx` (body **+ headers/footers/footnotes/endnotes/comments**, incl. comment authors) and `.pptx` (one text primitive per slide + per notes slide), **plus media images** in `(word|ppt|xl)/media/*`.
  - **Outlook `.msg`** — `@kenjiuno/msgreader`: body text + subject/from/to + **image attachments**.
  - **`.eml`** — `postal-mime`: body + subject/from/to/cc/bcc/reply-to/date (every recipient field captured so no address escapes the anonymizer).
  - **Built-in (no vendored parser):** `csv`/`tsv` (typed table), `json`/`text`, `html`/`xml`/`rtf` (markup→text helpers, `src/ingest/markup.ts`), and raster images `png`/`jpeg`/`gif`/`webp`.
  - Legacy `.xls`/`.doc` are recognized but not parsed — a helpful note tells the rep to re-save as `.xlsx`/`.docx`. Unknown binary → flagged & skipped; unknown text-like → treated as text.
- **Primitive types** (`src/ingest/types.ts`): `TextPrimitive`, `TablePrimitive` (typed headers/rows), `ImagePrimitive` (bytes + mime + provenance `source`), `KeyValuePrimitive` (metadata). The async `ingestAsync` is the entry point (PDF parsing is async); the sync `ingest` covers the no-parser builtins.
- **Hardening (untrusted input).** Every extractor is fully crash-isolated (any throw → `[]`, reported, batch continues). A **zip-bomb guard** sums uncompressed sizes from the central directory and refuses inflation beyond 200 MiB / 10 000 entries / any zip64 placeholder **before** JSZip/exceljs expand anything. A 25 MiB whole-file size guard runs before any parser. Text, rows, cols, slides, and embedded-image counts are all capped.

> **Update note.** The original draft listed the format set as a goal; the shipped set is the table above — `docx`/`pptx`/`eml`/`html`/`xml`/`rtf`/`webp` were added on top of the original `xlsx`/`pdf`/`msg`/`csv`/`txt`/image support (v0.3.0). Container subtyping and the zip-bomb/size guards are new.

### 6a. Anonymization (local, fail-closed) — *new, the hardened D6*
Anonymization is a discrete pipeline stage and the **Anonymize** wizard step, run entirely locally with **no LLM** (sending raw text to an AI for entity detection would leak the very names we protect).

1. **Detect (local, deterministic — `src/anon/detect.ts`).** Over the flattened text/table/keyvalue corpus, regexes find emails, IPv4, FQDNs (3+ labels), and Unicode-aware Title-Case proper nouns; the rep's company name (and a salient single token of it) is always included even at zero occurrences; the standalone surname of each detected person is also surfaced. Bias is fail-closed (over-detect). Known gaps are documented in-code (all-caps acronyms, hyphenated/apostrophe names, IDN domains) — the rep reviews and can add any missed phrase manually.
2. **Approve (rep, in Step 3).** Each candidate gets an opaque, LLM-stable slug (`CF_ORG_01`, `CF_PERSON_02`, `CF_HOST_03`, `CF_TERM_…`; `src/anon/mapping.ts`). The rep prunes false positives and adds misses. `validateMap` enforces invertibility (no empty/self/duplicate slugs; substring overlaps are handled by longest-first ordering).
3. **Replace (Go launcher).** The SPA expands each phrase into all case/whitespace/NFC variants sharing its slug, serializes the map to a byte-identical TSV, and POSTs `{map, text}` to `/anonymize`. The launcher is a dumb literal replacer that **fails closed** on a slug-conflict (a slug literal already in the raw source → 400, regenerate). The replaced text is what triage and the LLM ever see. After the run, LLM output is reversed through `/deanonymize` (served `no-store`).

The map's TSV format is kept byte-identical between the TS builder (`src/anon/mapping.ts`) and the Go replacer (`launcher/anon/mapio.go`) so the same map round-trips in either.

### 6b. Embedded-image extraction + PNG encoder — *new in v0.4.0*
PII is often baked into a chart or screenshot, which the LLM's vision model will happily read. So ingest now **extracts embedded raster images** as image primitives, making them reviewable: `.msg` image attachments, OOXML media (`(word|ppt|xl)/media/*`), and PDF image XObjects. PDF images are decoded by pdf.js to raw pixel buffers and re-encoded to PNG by a **dependency-free PNG encoder** (`src/ingest/png.ts`) that wraps the pixels in *stored* (uncompressed) zlib blocks with hand-computed CRC32/Adler32 — no canvas, no compression dependency, identical in Node and the browser (RGBA is composited onto white so transparent chart backgrounds read correctly for OCR). pdf.js is given a `maxImageSize` (OOM guard) plus a per-page timeout race (`PDF_IMAGE_EXTRACT_MS`, 20 s) so a stuck object can't wedge ingest; a post-decode pixel cap is a backstop. Known gaps (inline images, image masks, JPXDecode-only) are documented in-code.

## 7. Classify / triage (the new, essential stage)
Maps heterogeneous primitives onto **what the sizing needs**, regardless of source format (`src/classify/`).
- The **Source Profile declares a signal schema** (`src/profile/mongodb.ts`) — the information the sizing requires (cluster topology, node RAM/cores, data size, CPU avg/peak, memory/cache, IOPS, oplog/write rate, ops/sec & concurrency, edition, read preference, growth, …), each with **how it can be derived** and a **criticality** (*required* · *recommended* · *optional/refinement*).
- **Triage** (`src/classify/triage.ts`) assigns every primitive a semantic role and binds it to schema signals:
  - **Heuristics** (`heuristics.ts`) for the obvious (a CSV with a timestamp + numeric columns → a metric series; a formula-heavy sheet → a sizing/cost model).
  - **Numeric series handled natively** (`stats.ts`): when a signal is available as structured numbers, the JS engine computes avg/peak/P95 directly — *more accurate than reading a chart*.
  - **Vision** for images/charts: the LLM identifies "this is a System-CPU time-series, ~18% avg / ~45% peak" — the fallback when only a picture exists. (By the time vision runs, the image has been OCR-scanned and redacted — §8a.)
  - **LLM text classification** (`llm.ts`) for ambiguous prose/tables (licensing terms, topology descriptions).
- **Output → a rep-facing Data Intake & Sufficiency Report** (`sufficiency.ts`), produced before any drafting:
  - **Inventory:** every file found and what the app determined it *is* (or "unrecognized / ignored as noise"), from each `FileReport`.
  - **Signal-coverage matrix:** each needed signal marked **satisfied / partial / missing**, the evidence that satisfies it, and a confidence.
  - **"What to collect" list:** for missing or low-confidence *required* signals, a plain-language, copy-pasteable request the rep can send the customer.
  - **Output-quality verdict:** ties completeness to result tier — e.g., *"Enough for a directional estimate now; collect X and Y to reach an engineering-grade, defensible number."*
  This report informs the rep up front **and** drives the mandatory assumptions/gaps gate (§8.4).

## 8. Pipeline & run model (hybrid) — the seven steps
The wizard (`src/ui/`, `STEPS` in `src/ui/state.ts`) realizes the pipeline as seven steps; `stepValidity` is a pure, unit-tested function that gates advancement.
1. **Setup** — pick provider (Claude/OpenAI), enter company name + API key (session memory only, never persisted to the launcher), set a token budget.
2. **Drop files** — folder pick → `ingestAsync` → Evidence Bundle + per-file reports.
3. **Anonymize** (§6a, §8a) — local detect → rep-approved map → launcher slug replace; **and** the image scan/redact gate. Produces the `anonBundle` (the only thing downstream/LLM sees).
4. **Confirm** — the one mandatory stop: rep reviews the sufficiency report, edits assumptions, answers gaps (cores/node, edition, …), pre-filled with the model's proposed defaults (`src/orchestrate/gate.ts`). The gate **blocks** if a *required* signal is still unmet.
5. **Generate** — `runPipeline` (`src/orchestrate/index.ts`): triage → apply gate answers → deterministic size → LLM prose (`prose.ts`, determinism boundary intact) → assemble DocModel → render. A **token/cost budget** (`budget.ts`) accumulates usage and guards expensive steps.
6. **Refine** — per-output feedback regenerates that output with feedback + prior draft + evidence; the rep can jump back to any earlier stage and re-run downstream.
7. **Export** — HTML + browser print-to-PDF.

### 8a. Step 3 is a two-step, fail-closed gate — *new in v0.4.0*
When the bundle contains images, Step 3 splits in two and the step-advance gate fails closed (`stepValidity`: an `anonBundle` containing an image is **not** advance-valid until `imagesReviewed`):
- **Scan images for hidden text** (gated *before* Anonymize): a local OCR pass (`recognizeWords`) runs over every image, the recognized words are folded into the rep-approved candidate map (each image-derived phrase **badged to its source image** via `detectCandidatesInImage` + `mergeDetected`), and the OCR words are cached **by primitive index** (not source — two images can share a source file).
- **Anonymize & review**: text primitives are slug-replaced via the launcher; images are redacted by painting opaque boxes over matched phrases (reusing the cached OCR — no second scan), and each redacted image is surfaced for the rep to review and optionally exclude from the vision pass. On a mid-scan failure the rep gets honest messaging and the preview object URLs are revoked.

## 9. Source Profile (MongoDB v1) — the extension seam
A profile (`src/profile/`) bundles: the **signal schema** (§7), the **sizing/TCO model** (ported `sizing_calc.py`/`tco_calc.py` → `src/engine/`), the **prompt templates** for analysis/generation, the **assumptions schema + defaults**, the **cost components & web-search queries**, and the **doc templates**. Adding PostgreSQL/MySQL/SQL Server later = a new profile implementing the same interface; ingest, anonymize, redaction, classify, adapter, engine, renderer, and refine loop are reused unchanged. A MongoDB **Atlas source-profile analysis** path + sample fixture (`samples/atlas-demo`) is documented in `docs/ATLAS-SOURCE-PROFILE.md`.

## 10. Outputs
- **High-level business case** (`renderBusinessCase`) — TCO comparison + charts + the blue/green narrative.
- **Customer-facing sizing brief** (`renderSizingBrief`) — sanitized, collaborative tone.
- **Internal technical review** (`renderTechnicalReview`) — analysis, sizing scenarios, assumptions, risk/mitigation (clearly internal).
- **Claims → evidence checklist** (`renderClaimsChecklist`) — every figure mapped to its source/confidence.
All rendered HTML with embedded house-style SVGs; PDF via browser print. Renderers are pure `DocModel → {filename, html}` (`src/render/`).

## 11. Determinism, charts, rendering
- Sizing/TCO math = pure JS functions (`src/engine/sizing.ts`, `tco.ts`, `dr.ts`), unit-tested, with all knobs centralized and source-cited in `src/engine/config.ts` (ECPU/storage list rates, the Peak÷N divisors + autoscale band, the cold-DR formula). A single numeric model is consumed by both charts and docs.
- **Chart generator** ports the house-style helpers per `~/.claude/svg-guidelines.md`; every figure validated against the four non-negotiables (in-frame, no collisions, clean connectors, step-overs).
- PDF via `window.print()` against print CSS (high fidelity, zero deps).

> **Update note.** The original draft assumed a `data.json` analog; the shipped engine centralizes the *constants* in `config.ts` (engine functions default to `ENGINE_CONFIG` but accept overrides, so tests and a future Atlas profile can vary one knob without forking the math). Changing a default moves the golden-test numbers by design.

## 12. Confidentiality, key handling, errors
- **Confidentiality (D6).** The chosen retention posture is shown in the UI; provider calls default to zero-retention / no-train endpoints. **The anonymized content is the only thing that leaves the machine** — text is slug-replaced by the launcher and images are OCR-redacted (§6a, §8a) before any AI call. Documents are parsed locally.
- **Key handling.** Entered in Setup, held in session memory only (the wizard carries a `hasApiKey` flag, never the key), sent only to the provider; never to the launcher or any Oracle endpoint.
- **Errors (v0.3.0).** App-wide error handling with breadcrumb logging (`src/ui/ErrorContext.tsx`, `ErrorBoundary.tsx`) and an **error-report dialog** that composes a report to `rick.houlihan@oracle.com` via Outlook web compose with a `mailto` fallback. Ingest produces **per-file reports with error categories** (`unsupported_format`, `malformed_file`, `extractor_error`, `file_too_large`) rather than failing silently; partial results are preserved. **Help/FAQ** and **About** modals ship in-app (About links to `docs/SIZING-METHODOLOGY.md` on the canonical repo).

## 13. Packaging & distribution
```
caseforge/
  bin/caseforge(.exe)   ← Go static server + browser opener (per-OS)
  app/ (dist/)          ← built static SPA (index.html + bundled JS/CSS, no CDN)
  public/tesseract/     ← self-hosted tesseract WASM + traineddata (fully offline)
  samples/              ← demo + golden fixture (incl. atlas-demo)
  README                ← extract, run `caseforge serve --app-dir app`, paste key, point at a folder
```
`scripts/run-local.sh` runs the whole thing locally; `scripts/setup-tesseract-assets.mjs` assembles the offline OCR assets (run by `dev`/`build`). The same SPA can also be hosted at a URL from one codebase. Versioned zips per release.

## 14. Tech stack
- **Launcher:** Go (single static binary per OS, stdlib only; trivial cross-compile; no runtime). `caseforge serve` (127.0.0.1 SPA + anonymize endpoints) and the `anonymize`/`deanonymize` directory-mode CLI.
- **SPA:** **Preact + Vite**, TypeScript strict, built to static output in `dist/`. Vendored libs (no CDN, for offline/local): `@kenjiuno/msgreader` (`.msg`), `exceljs` (`.xlsx`), `unpdf`/pdf.js (PDF), `jszip` (OOXML), `postal-mime` (`.eml`), `tesseract.js` v7 + `tesseract.js-core` (offline OCR, code-split). Provider calls are thin fetch wrappers behind the `LLM` interface.
- **Tests:** Vitest (442 TS test cases at time of writing) + Go tests for the launcher. **pnpm**, Node ≥ 20.
- **No build step at runtime** — the shipped artifact is static files.

## 15. Image redaction module — *new in v0.4.0 (staged)*
`src/redaction/` is the local, offline OCR-redaction subsystem that keeps PII out of the vision pass. It is split for testability:
- `match.ts` — **pure** phrase→rectangle matcher (recognized OCR words + the rep's map → boxes to paint), unit-tested under Node.
- `index.ts` — **pure** orchestrator: OCR (or reuse precomputed words) → match → paint, with the SEND-WITH-WARNING policy (on OCR failure or low confidence the image stays usable but is flagged; the rep reviews every preview).
- `ocr.ts` / `paint.ts` — tesseract and canvas shims (injected, so the orchestrator is browser-free in tests).
- `browser.ts` — the code-split browser entry that wires the real shims; it exports `recognizeWords` so the Step-3 detection scan and the redaction pass share one OCR pass (no double scan).
tesseract WASM is self-hosted under `/tesseract` (assembled by `scripts/setup-tesseract-assets.mjs`) — fully offline, no network. Because tesseract WASM + canvas can't run under CI/jsdom, the v0.4.0 release is **held for a manual in-browser verification** of this path.

## 16. Extensibility
New source DB = new Source Profile (signal schema + model + templates + cost queries). Ingest, anonymize, redaction, classify, adapter, engine harness, renderer, refine loop, and launcher are profile-agnostic and reused.

## 17. Testing & CI/Release
- Pure-function unit tests for the sizing/TCO engine, the chart generator, the anonymization map, the PNG encoder, the redaction matcher, and `stepValidity`.
- Provider adapter behind an injectable transport for orchestrator tests.
- **A golden end-to-end fixture** (anonymized "Northwind Mutual Insurance") pins the sizing and business-case numbers; `*.golden.test.ts` files fail if the engine drifts.
- **CI** (`.github/workflows/ci.yml`): `build-test` runs `lint → typecheck → test → build` (pnpm); `launcher` runs `go vet → go test → go build`.
- **Release** (`.github/workflows/release.yml`): tagging `vX.Y.Z` publishes per-OS launcher zips. Current `package.json` version is `0.3.0`; the embedded-image/OCR-gate work is staged for `v0.4.0`, **held pending the manual OCR verification** above.

## 18. Open questions (carried / resolved)
- App name — **resolved: CaseForge.**
- Exact model defaults per provider and how the model list is updated — defaults live in config (`claude-opus-4-8`); revisit per Claude API reference at build time.
- Verification depth default (single vs dual pass) and its token budget — open.
- How much project state to persist and where — currently session-only; persistence is open.
- Multi-profile / IDN-name detection / explicit OCR-worker termination — tracked as non-blocking follow-ups.

## 19. Milestones (status)
1. ~~**Spike** the risks (web-search BYO-key, vision cost, print-PDF, `.msg`).~~ Done.
2. ~~**Core engine offline**: ingest → extract → classify → deterministic sizing + charts, tested on the golden fixture, no LLM.~~ Done.
3. ~~**Provider adapter + analyze/generate** for both providers.~~ Done.
4. ~~**Three outputs + claims checklist + refine loop.**~~ Done.
5. ~~**Packaging**: Go launcher + zip + samples; optional hosted build.~~ Done.
6. ~~**Hardening**: anonymization, error handling, broadened ingest, image OCR redaction, embedded-image extraction.~~ Done through v0.3.0; v0.4.0 staged.
7. **Manual OCR verification** → cut `v0.4.0`. Pending.
