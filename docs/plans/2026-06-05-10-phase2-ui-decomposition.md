# Plan 10 — Phase 2 (SPA UI) decomposition & architecture

This records the Phase-2 architecture (from the `phase2-ui-architecture` design workflow + its adversarial critique, with my resolutions) and the sub-plan build order. The UI is the integration layer wiring the already-merged backends into the user-approved 7-step wizard. Stack: Preact + Vite + Oracle CSS (scaffold = Plan 10d).

## Approved UX (locked with the user, via the visual companion)
Left vertical stepper. **1 Setup → 2 Drop files → 3 Anonymize → 4 Confirm → 5 Generate → 6 Refine → 7 Export.** Anonymize: auto-add all locally-detected phrases (fail-closed), occurrence counts, live "what the AI sees" preview, variant collapsing. Confirm: one screen = Sufficiency Report (Blocked/Directional/Engineering-grade) + confirm-assumptions gate; generate allowed while Directional. Generate: live cost ticker + determinism note. Refine: tabs over 3 docs + Claims Checklist, preview with real names restored locally, chips + free-text regeneration (numbers locked). Export: deanonymize + download.

## Locked architecture decisions (resolving the critique)
- **detect = pure sync**, regex + heuristics, **no LLM** (it runs before anonymization on raw text — an LLM here would leak the names). Emits `{phrase, type, occurrences, confidence}` per candidate.
- **Launcher origin** = `import.meta.env.VITE_LAUNCHER_ORIGIN ?? 'http://127.0.0.1:8080'`; Vite **dev proxy** for `/anonymize` `/deanonymize` `/health` → that origin. In production the launcher serves the built SPA (same-origin).
- **API key** lives in session memory only (never localStorage), cleared on unload. Persisted to localStorage: companyName, budget, map, gateAnswers (not the key, not the bundle).
- **Triage runs once:** the Confirm step runs it for the report/gate, then passes it into `runPipeline` via optional `config.triage` so it is NOT re-run (kills the double-LLM-cost).
- **Live ticker:** `runPipeline` gains an optional `config.onCheckpoint(cp)` invoked after each budget record, so the ticker updates per stage.
- **Refine** regenerates ALL prose (sections interdepend) with the frozen numeric model + an optional `instruction`; `generateProse` gains an optional `instruction` param. Real names NEVER go to the LLM in refine — the anonymized `docModel` is the source, `docModelDeanon` is preview-only.
- **Deanonymize for preview/export** = `LauncherClient.deanonymize(map, html)`; a missing slug warns + leaves the slug visible (signals a map gap).
- **Profile** = `MONGODB_PROFILE` hardcoded (MongoDB→ADB v1); profile selection is Phase 3.
- **Research** (step 5) is optional; Generate works at Directional without sourced costs.
- **Declined:** `expandEntries` variant cap (already constant-bounded; launcher `MaxBytesReader` backstops), `ClaimInput.source` (provenance is in `declaredSource.label`), `budgetGuard` 20% buffer (changes semantics; UI labels cost "estimated"), per-section prose scope (regenerate all).

## WizardState (shared, in `src/ui/state.ts`)
Carries across steps: `config{provider,apiKey,companyName,tokenBudget}`, `bundle`, `detected[]`, `map:MapEntry[]`, `anonBundle`, `triage`, `sufficiency`, `gate`, `gateAnswers[]`, `tcoResearch`, `tcoInputs`, `claims[]`, `assumptions[]`, `pipelineOutput`, `budgetCheckpoints[]`, `docModelDeanon`, `currentStep`, `stepValidity`, per-action loading/error flags. Held via a Preact context + `useWizardState()` hook (localStorage for the persisted subset; apiKey in a ref/sessionStorage).

## Sub-plan build order (pure/testable first, UI next, packaging last)
- **10e** (this PR): `src/anon/detect.ts` (local detection) + `src/launcher/client.ts` + `src/launcher/transport.ts` + Vite dev proxy + `VITE_LAUNCHER_ORIGIN`. Pure/mockable.
- **10f**: backend refactors — `runPipeline` optional `triage` + `onCheckpoint`; `generateProse` optional `instruction`. Additive, TDD against existing suites.
- **10g**: WizardState + context + `useWizardState` + Stepper + Wizard shell (placeholder steps).
- **10h**: Step 1 Setup + Step 2 Drop files.
- **10i**: Step 3 Anonymize + Step 4 Confirm.
- **10j**: Step 5 Research + Generate (cost ticker).
- **10k**: Step 6 Refine + Step 7 Export.
- **10l**: shared components (CostTicker, GateWidget, PreviewToggle, ClaimsChecklist, ErrorBoundary) + test utils + end-to-end wiring.
- **10m–10o** (Phase 3): Vite build + launcher static integration; cross-platform packaging (CI matrix + zips); docs + sample fixture.

---

## Plan 10e — local entity detection + launcher HTTP client (BUILD-READY)

**Goal:** the pure, mockable modules the Anonymize/Refine/Export steps depend on: detect sensitive phrases locally; talk to the launcher endpoints from the browser.

### Files
- Create: `src/anon/detect.ts`, `src/anon/detect.test.ts`
- Create: `src/launcher/transport.ts`, `src/launcher/client.ts`, `src/launcher/client.test.ts`
- Modify: `vite.config.ts` (dev proxy)

### Task 1 — `detectCandidates`
- `detectCandidates(bundle: EvidenceBundle, companyName: string): DetectedPhrase[]` where `DetectedPhrase = { phrase: string; type: 'org'|'person'|'host'|'term'; occurrences: number; confidence: number }`. Pure, sync, no LLM.
- Scans all text (text primitives, table headers+cells, keyvalue values). Detects: emails (`\S+@\S+\.\S+` → person, 0.9), IPv4 (→ host, 0.9), FQDN/hostnames (`\w+(\.\w+){2,}` → host, 0.8), the companyName + its tokens (→ org, 1.0), Title-Cased multi-word proper nouns (→ person/term, 0.6). Longest-match-wins on overlap; filter a stoplist of common Title-Case starts ("The", "This", section headings); dedupe case-insensitively; count occurrences; sort by occurrences desc.
- [ ] Tests: fixture bundle with an email/IP/FQDN/proper-noun/company-name → all detected with right type; overlap (company "Acme" inside "Acme Mutual") → longest wins, counts correct; stoplist words excluded; empty bundle → [].

### Task 2 — `launcher/transport.ts`
- `interface LauncherTransport { post(path, body): Promise<{status:number; json():Promise<unknown>}> }` + a default `fetchTransport(origin, fetchImpl?, timeoutMs?)` using `fetch` with an `AbortController` timeout. `LAUNCHER_ORIGIN = import.meta.env.VITE_LAUNCHER_ORIGIN ?? 'http://127.0.0.1:8080'`.
- [ ] Tests (injected fake fetch): posts to `origin+path` with JSON body + content-type; timeout → rejects; network throw → rejects.

### Task 3 — `LauncherClient`
- `class LauncherError extends Error { code?: string }`. `class LauncherClient { constructor(transport); anonymize(entries: MapEntry[], text): Promise<{text:string;count:number}>; deanonymize(entries, text): Promise<{text,count}>; health(): Promise<boolean> }`. `anonymize/deanonymize` serialize the map via `buildMap(entries)` (keeps variant expansion in the single source of truth), POST `{map,text}`, parse `{text,count}` on 200, throw `LauncherError(code)` on the `{error,code}` body.
- [ ] Tests (mock transport): anonymize 200 → `{text,count}`, body sends `buildMap` TSV; error body `{error,code:'slug_conflict'}` → throws `LauncherError` with code; health true on `{status:'ok'}`, false on throw/non-200.

### Task 4 — Vite dev proxy
- Add `server.proxy` for `/anonymize` `/deanonymize` `/health` → `VITE_LAUNCHER_ORIGIN`. (No test; documented; doesn't affect the test suite.)

## Self-Review
- detect is pure + no-LLM (privacy invariant); client keeps variant expansion in `buildMap`; both fully mockable.
- No change to runPipeline/render here. Adversarial review before merge.
