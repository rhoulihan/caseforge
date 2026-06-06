# Plan 10 — Application & packaging (decomposition) + Plan 10a: launcher serve + endpoints

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

Plan 10 wraps the now-complete headless kernel (`runPipeline`) in the deployable app. It is too large for one plan, so it is **decomposed into 15 sub-plans across 3 phases**, built **testable-backends-first, SPA + packaging last**. This doc records the decomposition and details the first build-ready sub-plan, **10a** (the Go launcher).

## Decomposition & build order
**Phase 1 — pure, deterministic backends (httptest / Vitest+fixtures / mock LLM):**
- **10a** Go launcher `serve` + `POST /anonymize` `/deanonymize` + `GET /health` + static file serving. *(this doc)*
- **10b** Web-search cost research (fills `TcoInputs` via the provider `web_search` tool, mockable) + budget wiring.
- **10c** Binary ingest parsers (`.msg`/`.xlsx`/`.pdf`) into the ingest registry (vendored libs; fixture-file tests).

**Phase 2 — UI components, each testable in isolation (Vitest, mocked fetch/File/LLM):** 10d anon mapping-builder form; 10e folder picker + extract + triage; 10f gate/sufficiency dialog; 10g cost ticker; 10h document preview + refine loop; 10i deanonymize + export + persistence; 10j Vite SPA scaffold; 10k provider-key management.

**Phase 3 — integration & packaging:** 10l end-to-end wizard; 10m Vite build + launcher integration; 10n cross-platform packaging (CI matrix + zips); 10o docs + sample fixture.

*Rationale:* backends are unit-tested and deterministic before the SPA consumes them; UI components are mockable in isolation before the wizard wires them; packaging is last. Each sub-plan ships working, tested software. Later sub-plans are designed when reached (the kernel `runPipeline` is consumed unchanged).

---

## Plan 10a — Go launcher `serve` + HTTP endpoints (BUILD-READY)

**Goal:** A `serve` subcommand that hosts the static SPA on **127.0.0.1** and exposes the anonymization system utility over localhost HTTP, so the browser routes extracted text through the Go replacer (real phrases never enter an AI prompt). Pure Go, dependency-free, `httptest`-tested, reusing the merged `anon` package.

**Security decisions (from the adversarial critique — non-negotiable):**
- **Localhost-only, hardcoded:** `net.Listen("tcp", "127.0.0.1:"+port)`. **No `--bind-addr` flag** (network/multi-user is a different tool). A test asserts the bound addr is `127.0.0.1`.
- **Body-size limit via `http.MaxBytesReader` BEFORE reading** (10 MiB) — not a post-hoc size check. Exceed → `413`.
- **Explicit path-traversal boundary check** for static serving (do not rely on bare `http.FileServer`): `Clean` → `Join(root,…)` → `Rel(root,…)` reject `..`; `EvalSymlinks` and re-check the real path stays within `root`; serve via `os.Open` + `mime.TypeByExtension` (avoid `ServeFile` path quirks).
- **`/anonymize` hard-fails on a slug conflict:** run `anon.ScanForSlugs(rawText, entries)` BEFORE substitution; if any slug already appears literally in the **raw source** → `400 {code:'slug_conflict'}`. (Detection must be on `/anonymize`, not `/deanonymize`: a pre-existing slug only becomes ambiguous because anonymizing introduces a second, indistinguishable occurrence — and `/deanonymize` input legitimately contains slugs, so a scan there would reject every valid call. **This corrects the design, which placed it on `/deanonymize`.**)
- **`Cache-Control: no-store, no-cache, must-revalidate, private`** on `/deanonymize` (its response carries real phrases — never cache/log).
- **Map is pre-expanded by the caller:** the Go endpoint is a dumb literal matcher; the TS `buildMap` (Plan 05 `src/anon/mapping.ts`) owns case/whitespace/NFC variant expansion. Documented; a test feeds a pre-expanded map and confirms all variants replace.
- **Stateless:** each request parses its own map (`anon.ParseMap` **only** — see Build deviations); no in-memory caching. A test sends two different maps and confirms no cross-contamination.

**JSON shapes (finalized):** success `{text: string, count: number, warnings?: string[]}`; error `{error: string, code: string}`; health `{status: 'ok'}`. Error codes: `bad_request`, `invalid_map`, `payload_too_large`, `slug_conflict`, `method_not_allowed`.

**Routes:**
- `POST /anonymize` `{map, text}` → `anon.ParseMap` → `ScanForSlugs(text)` (conflict→400) → `anon.AnonymizeN` → `{text, count}`.
- `POST /deanonymize` `{map, text}` → `anon.ParseMap` → `anon.DeanonymizeN` → `{text, count}` + no-store header.
- `GET /health` → `{status:'ok'}`.
- `GET /*` → guarded static file from `--app-dir` (404 outside / missing / dir).

**`serve` subcommand:** `caseforge serve --app-dir DIR [--port 8080] [--no-open]`. Validates app-dir exists + is a directory; binds `127.0.0.1:port` (exit 1 on bind failure); best-effort browser open (failure is non-fatal; `--no-open` for CI/headless); graceful shutdown on SIGINT/SIGTERM; exit 0 clean / 1 startup error / 2 bad flags. The existing `anonymize`/`deanonymize` CLI modes are unchanged.

**Files:** `launcher/serve.go` (config + `parseServeFlags` + `newMux(appDir) http.Handler` + handlers + `serveCLI`), `launcher/serve_test.go` (httptest unit tests), `launcher/main.go` (add the `serve` case). Stdlib only. **Signal/graceful-shutdown is NOT httptest-able** — `serveCLI` is kept thin and the testable surface is `newMux` + `parseServeFlags` + a real-listener bind test; the SIGINT path is exercised manually / in a later integration test.

### Task 1 — `parseServeFlags` + the `serve` case wiring
- Files: `launcher/serve.go`, `launcher/serve_test.go`, `launcher/main.go`
- Tests: `--app-dir <tmpdir> --port 8080` → ok; missing `--app-dir` → error; non-numeric/out-of-range `--port` → error; `--app-dir` pointing at a file → "not a directory"; `--no-open` parsed. `main.go` routes `serve` to `serveCLI` and leaves anonymize/deanonymize unchanged.

### Task 2 — `POST /anonymize` (via `newMux`, httptest)
- Files: `launcher/serve.go`, `launcher/serve_test.go`
- Tests: `{map:'John Doe\tCF_PERSON_01', text:'Hello John Doe'}` → 200 `{text:'Hello CF_PERSON_01', count:1}` and **`text` does NOT contain `'John Doe'`** (proves real slugification); empty map → 200 `{text:<unchanged>, count:0}`; a **pre-expanded** map (`buildMap`-style: `John`+`john`+`JOHN` → same slug) replaces all variants; two sequential requests with **different** maps each return the correct result (stateless); `GET /anonymize` → 405 `method_not_allowed`.

### Task 3 — `/anonymize` error paths & slug conflict
- Tests: malformed JSON → 400 `bad_request`; bad TSV (no tab) → 400 `invalid_map`; empty slug → 400 `invalid_map`; body > 10 MiB → 413 `payload_too_large` (via `MaxBytesReader`); a **slug literal pre-existing in the raw source** (`{map:'John\tCF_PERSON_01', text:'CF_PERSON_01 met John'}`) → **400 `slug_conflict`**. NOTE: a duplicate-slug map is **valid** (pre-expanded variants share a slug) and must NOT 400 — covered by Task 2.

### Task 4 — `POST /deanonymize` (round-trip, shared slugs, headers)
- Tests: `{map:'John Doe\tCF_PERSON_01', text:'Hello CF_PERSON_01'}` → 200 `{text:'Hello John Doe', count:1}`; round-trip `deanonymize(anonymize(x)) == x`; a **shared-slug** reverse map (`John`+`john` → `CF_P_01`) resolves first-wins (deterministic canonical phrase) and must NOT 400; response carries `Cache-Control: no-store`.

### Task 5 — `GET /health`
- Tests: `GET /health` → 200 `{status:'ok'}` regardless of payload.

### Task 6 — guarded static serving
- Tests (temp app-dir with `index.html` + `style.css`): `GET /` → 200 `text/html`; `GET /style.css` → 200 `text/css`; `GET /nonexistent.js` → 404; **`GET /../../etc/passwd` → 404** (boundary check); a path resolving to a dir → 404.

### Task 7 — localhost bind
- Tests: a helper that creates the listener binds `127.0.0.1` (assert `listener.Addr()` is loopback); never `0.0.0.0`.

## Build deviations from the design (discovered during TDD)
Two specification errors surfaced against the real `anon` package and were corrected (with reasoning) during the build:
1. **`anon.Validate` is NOT called at the endpoint** — only `anon.ParseMap`. The map arrives pre-expanded, where case/whitespace/NFC variants intentionally share one slug (`expandEntries` in `src/anon/mapping.ts`). `Validate` rejects duplicate slugs (it guards invertibility of an un-expanded table), so calling it would reject every expanded map and break the core case-variant-leak fix. The SPA's `validateMap` owns semantic validation of the user's pre-expansion entries; the endpoint is a dumb literal matcher (`ParseMap` is the structural gate). The CLI `anonymize`/`deanonymize` modes keep `Validate` (they ingest user-authored, un-expanded map files).
2. **Slug-conflict detection moved from `/deanonymize` to `/anonymize`** — see the Security decisions note above. The deanonymize input is supposed to be full of slugs, so a `ScanForSlugs` gate there would reject every valid request; the corruption it prevents is a slug literal sitting in the raw source pre-anonymization, detectable only on `/anonymize`.

Verified manually against the running binary: anonymize (real-phrase slugified away), pre-expanded variants (all replaced), `/anonymize` slug-conflict→400, `/deanonymize` round-trip + `no-store`, static `text/html`/`text/css`, raw & encoded `..` traversal→flat 404 (no 301), 405 on GET to POST routes, SIGINT graceful-shutdown exit 0.

## Self-Review
- All 9 critique findings encoded (path-traversal guard, hardcoded localhost, `MaxBytesReader`, slug-conflict 400, no-store, pre-expanded-map contract, finalized JSON, stateless, unit/integration split).
- Reuses the merged `anon` package verbatim; dependency-free Go 1.23; the existing CLI is untouched.
- Determinism leak guarded: a test asserts the anonymized response contains none of the real phrases; `/deanonymize` is no-store and conflict-checked.
- SPA, web-search cost research, binary parsers, packaging are the later sub-plans (this sub-plan ships the runtime host + endpoints, independently testable).
- Adversarial review before merge.
