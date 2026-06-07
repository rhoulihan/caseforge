# CaseForge

**Forge a sizing, a customer proposal, and a TCO business case from a folder of raw customer artifacts — locally, with your own LLM key.**

CaseForge is a self-contained, browser-based tool for the field salesforce. A rep runs a tiny launcher, brings their own **Claude or OpenAI** API key, and walks a 7-step wizard that reproduces an expert sizing → proposal → business-case workflow:

1. **Setup** — pick a provider, paste an API key (kept in the browser session only, never written to disk), set a token budget, and optionally a customer discount on the proposed solution.
2. **Drop files** — drag in whatever the customer sent (xlsx, docx, pptx, pdf, .msg/.eml, csv, txt, html, xml, rtf, images…); parsed **locally**, nothing leaves the machine.
3. **Anonymize** — sensitive phrases are detected locally (no AI). If any artifact carries images, a local OCR pass surfaces text *baked into charts/screenshots* and folds it into the same list. The rep reviews a fail-closed map; the launcher replaces real text with opaque slugs and the redactor blacks out matched text in images **before any AI call**.
4. **Confirm** — a Data Intake & Sufficiency Report (Blocked / Directional / Engineering-grade) plus a one-screen gate to confirm assumptions or supply real values.
5. **Generate** — deterministic sizing/TCO math runs in code (never the model); a live cost ticker shows spend while the AI only researches list prices, reads charts, and writes prose.
6. **Refine** — preview the three deliverables + a claims checklist; regenerate to recompute the numbers with current rates/config/discount (the engine still owns every figure; the LLM only rewrites prose), adjust the discount, refine the wording, or add more files to the case.
7. **Export** — download the deliverables (real names already in place).

Each generated case is **saved as a portable archive** the rep can reopen, refine, and add files to later — managed by the launcher under `~/CaseForge/archives/` and listed on a home screen, with the same fail-closed anonymization guarantees as a fresh run.

Customer documents stay on the laptop (parsed in-browser); only **anonymized** evidence is sent to the rep's chosen provider, over a zero-retention endpoint.

Two invariants govern the whole tool:

- **Determinism boundary** — the TypeScript engine computes every authoritative number; the LLM only researches prices, reads charts, and writes prose. It never decides a size or a cost.
- **Fail-closed anonymization** — detection runs locally (no LLM); the rep approves a fail-closed map; the launcher substitutes real text for slugs *before* any AI call. The anonymized content is the only thing that ever leaves the machine.

**v1 scope:** MongoDB → Oracle Autonomous Database, built behind a Source-Profile seam so other source databases can be added later.

> **Using CaseForge as a sales rep?** You don't need any of the developer setup below — see the plain-English **[Sales Rep Guide](docs/USER-GUIDE.md)**: download, double-click, and walk the wizard. (The same guide ships inside every release zip as `Guide.md`.)

## Features

- **Seven-step wizard** — Setup → Drop files → Anonymize → Confirm → Generate → Refine → Export, with a fail-closed step-advance gate (you cannot advance past Anonymize until the map is approved, and not until any extracted images have been reviewed).
- **Broad local ingest.** Drop `xlsx`, `docx`, `pptx`, `pdf`, `.msg`/`.eml`, `csv`, `txt`, `html`, `xml`, `rtf`, and images (`png`/`jpeg`/`gif`/`webp`). Container subtyping disambiguates OOXML (`xlsx`/`docx`/`pptx`) and OLE (`.msg`); markup→text helpers (`ooxmlParagraphsToText`, `ooxmlSlideText`, `htmlToText`) and PostalMime (`.eml`) turn each format into text/table/keyvalue/image primitives. Every extractor is crash-isolated and bounded — a zip-bomb or oversized input is refused before it inflates into memory.
- **Embedded-image extraction.** Ingest pulls raster images *out of containers* and emits them as image primitives, so PII baked into charts and screenshots becomes reviewable: `.msg` image attachments, OOXML media (`(word|ppt|xl)/media/*`), and PDF image XObjects. PDF images are decoded via unpdf/pdf.js and re-encoded with a dependency-free PNG encoder (`src/ingest/png.ts`, *stored* zlib blocks — no canvas, no compression dependency, identical in Node and the browser).
- **Local OCR image redaction before vision.** Chart/screenshot images are read by the LLM's vision model, so text baked into them could leak. A fully offline OCR pass (tesseract.js v7; WASM self-hosted under `/tesseract`, assembled by `scripts/setup-tesseract-assets.mjs`) finds matched phrases and paints opaque black boxes over them on a canvas *before* the image is used. Policy is **send-with-warning**: OCR is best-effort, so on failure or low confidence the image stays usable but is flagged, and the rep reviews every redacted preview.
- **Fail-closed local anonymization** — phrases are detected with regex/heuristics (no LLM), the rep edits the map, the launcher substitutes slugs over `/anonymize`, and `/deanonymize` restores real names into the final deliverables.
- **Centralized sizing & cost config** (`src/engine/config.ts`) — the Autonomous Database sizing and cost constants live in one adjustable place; the formulas and their sources are documented in `docs/SIZING-METHODOLOGY.md`.
- **MongoDB Atlas source-profile analysis** — analyze an Atlas-sourced source profile, with a runnable fixture under `samples/atlas-demo` and methodology in `docs/ATLAS-SOURCE-PROFILE.md`.
- **Business-case archives.** Each generated case is persisted as a portable, launcher-managed `~/CaseForge/archives/<caseId>.zip` (original sources + the anonymized bundle the LLM saw + every generated content package + a resume log). A pre-wizard **home screen** lists saved cases (New / Open / Delete); opening one hydrates the wizard straight into Refine — no API key needed to view. The SPA owns the zip format (`src/archive/`, JSZip); the Go launcher is a dumb blob store with `PUT/GET/DELETE /archive/{id}` + `GET /archives` routes that peek only at `manifest.json`. Every generate/refine/add-files **appends** a new version — regeneration never deletes a prior package. Archives contain customer PII and are local-only, never uploaded.
- **Customer discount + always-current regeneration.** A per-case discount (0–100%, set in Setup, adjustable in Refine) scales only the proposed Oracle solution (ADB + warm/cold DR + migration PS) while the baseline stays at list — a strict no-op at 0% so goldens are byte-identical (`src/engine/discount.ts`). **Regenerate** re-runs the deterministic sizing + TCO engine with the *current* `ENGINE_CONFIG`, current rates, and current discount (cached triage, no re-classify), then rewrites prose — so reopening an old case refreshes its numbers to today's rates rather than replaying frozen figures. The determinism boundary is intact: the LLM never sees or sets the discount, only the resulting net figures.
- **Refine continuity + add files later.** Reopening a case replays its accumulating refinement history so the narrative continues (the stateless LLM layer makes "resume" a deterministic `docModel` reload + instruction replay). The Step 6 refine box and any carried "add more files" note are **detect-and-blocked then slug-anonymized** before reaching the LLM (fail-closed; raw text kept local). Adding files returns to Drop files with the case retained and detects only the new files, folding them into the approved map via `extendMap` (existing slugs preserved).
- **Error handling + Help/About.** App-wide error handling with breadcrumb logging and an error-report dialog that composes a report to `rick.houlihan@oracle.com` (Outlook web compose, with a `mailto` fallback); per-file ingest reports classify failures (`unsupported_format`, `malformed_file`, `extractor_error`, `file_too_large`) rather than failing silently. Help/FAQ and About modals (About links to the sizing-methodology doc) are reachable from the header.

## Quick start (run locally)

Requires **Node ≥ 20**, **pnpm**, and **Go ≥ 1.23**.

```bash
./scripts/run-local.sh          # builds the SPA + launcher, serves on http://127.0.0.1:8080
# or, step by step:
pnpm install && pnpm build      # → dist/  (build also assembles the offline OCR assets)
cd launcher && go build -o bin/caseforge . && cd ..
./launcher/bin/caseforge serve --app-dir dist
```

Then open the printed URL. For UI development, `pnpm dev` runs the Vite dev server, which proxies the launcher endpoints to `127.0.0.1:8080` (run the launcher alongside, or override with `VITE_LAUNCHER_ORIGIN`).

> **OCR assets:** `pnpm dev` and `pnpm build` run `scripts/setup-tesseract-assets.mjs` first, which populates `public/tesseract/` (worker + SIMD WASM core + English traineddata) so in-browser OCR redaction works fully offline. If the traineddata can't be fetched on a first offline run, the build still succeeds — image redaction just degrades to *sent un-redacted, with a warning* until the asset is present. You can populate it explicitly with `pnpm setup:ocr`.

**Try it with sample data:** drop the artifact files in [`samples/northwind-demo/`](samples/northwind-demo/) (fictional customer artifacts) into the wizard — they exercise anonymization and reach a sizing result. An Atlas-profile fixture lives under [`samples/atlas-demo/`](samples/atlas-demo/). Pre-built per-OS zips (launcher + SPA) are produced by the Release workflow.

## Status

Functional end-to-end — the full 7-step wizard, with 486 TypeScript tests plus the Go launcher tests. Built with full CI/CD and strict TDD. Design spec: [`docs/specs/2026-06-04-adb-sizing-app-design.md`](docs/specs/2026-06-04-adb-sizing-app-design.md); sizing methodology: [`docs/SIZING-METHODOLOGY.md`](docs/SIZING-METHODOLOGY.md).

> Several feature sets are complete and slated for **v0.4.0**: the embedded-image extraction + OCR-into-anonymization work (the two-step Step 3), the customer discount + always-current regeneration, and the business-case archives (save/open/version + add-files). v0.4.0 is held pending a manual in-browser verification of the OCR path — CI/jsdom cannot exercise tesseract WASM + canvas. See [`CHANGELOG.md`](CHANGELOG.md).

## Architecture (summary)

- **SPA** (TypeScript, built to static assets) — all logic + the API key live in the browser.
- **Go launcher** (per-OS static binary, cross-compiled in CI) — serves the app on `http://127.0.0.1` and exposes `/anonymize`, `/deanonymize`, `/health`, and the archive store (`PUT/GET/DELETE /archive/{id}`, `GET /archives`); never sees docs or keys, and treats archives as opaque blobs (peeking only at `manifest.json` to build the list).
- **Provider adapter** — one interface over Claude and OpenAI (vision, web-search tool, structured output).
- **Source Profile (MongoDB)** — signal schema, sizing/TCO model, prompt + document templates.
- **Engine config** (`src/engine/config.ts`) — the ADB sizing/cost knobs the deterministic engine reads, adjustable in one place.

See the spec for full detail.

## Release & CI

Tagging `vX.Y.Z` triggers a Release workflow that publishes per-OS launcher zips (launcher + SPA + the offline OCR assets). CI runs **build-test** (the TypeScript suite + build) and **launcher** (Go tests).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Oracle and/or its affiliates.
