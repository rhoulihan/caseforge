# Plan 10b — Web-search cost research (fills `TcoInputs`)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A mockable module that researches current market cost figures via the provider's hosted web-search and produces a `TcoInputs` object (plus sourcing + confidence + claims) to feed `runPipeline`. It produces **inputs**, never authoritative TCO numbers — the pure engine still computes all TCO math.

**Architecture:** Cost research is a **caller pre-step**, NOT inside `runPipeline` (which stays stateless and UNCHANGED). `researchTcoCosts()` returns sourced inputs; the rep confirms them at the confirm-assumptions gate (D5, wired in Plan 10l) before they reach the engine. The enforceable determinism invariant at this boundary: a researched-cost claim carries numeric confidence ≤ 0.75 (llm-text tier), which maps to `ClaimConfidence ∈ {medium, low}` — **never `high`** — so a researched figure can never render as authoritative without rep promotion.

**Tech Stack:** TypeScript strict, Vitest; reuses `src/provider` (`LLM.complete({webSearch, jsonSchema})`), `src/engine/types` (`TcoInputs`), `src/orchestrate/budget`, `src/render/types` (`ClaimInput`), `src/classify/confidence` (`ClaimConfidence`).

---

## Locked decisions (resolving the design critique)

- **Pre-step, not in-pipeline** — `runPipeline` is untouched (kills the "silent determinism leak" + statelessness/mutation findings: research output is gated by the rep before the engine sees it). `TcoInputs` stays a pure engine type — **no `researchMetadata` field added**; provenance travels in `sourcing` + `ClaimInput.declaredSource`.
- **Determinism invariant (tested here):** researched numeric confidence is capped at **0.75**; `sourcesToClaims` maps it to a `ClaimConfidence` tier (`≥0.85 high · ≥0.6 medium · else low`), so a researched cost claim is **at most `medium`** — never `high`.
- **Single LLM call** with `webSearch:true` + `jsonSchema` (verified: both `claude.ts` and `openai.ts` set `tools` + structured-output in one request). Failure modes are distinguished:
  - **`ProviderError`** (provider rejects web_search, or the known web-search-pause / non-final-output loud error) → if `opts.budget`, re-guard; then **one retry without `webSearch`** (knowledge-only), confidence capped at **0.6**, every source marked `sourceQuality:'training-cutoff'`. If the retry also throws → `TcoResearchValidationError`.
  - **`JSON.parse` / schema-validation failure** → throw `TcoResearchValidationError` immediately (**no retry** — it is a logic failure, not a provider failure).
- **Two-pass normalize→validate** (fixes ambiguous order-of-operations): (1) parse JSON; (2) **normalize** each Range — if `high/low < 1.1` (point-estimate), set `low = round(central*0.8)`, `high = round(central*1.2)`; (3) **validate** — every number finite, `≥0`, and `low ≤ central ≤ high`; reject `NaN`/`Infinity`/negative/missing.
- **Sources, hallucination-resistant:** schema `sources: [{ component(enum), source, url, asOfDate (YYYY-MM-DD), sourceQuality: 'published'|'synthesized'|'training-cutoff' }]`, `minItems:1`. Validation: `asOfDate` parsed strictly (reject `2026-13-01`); `url` required **unless** `sourceQuality==='training-cutoff'`. **Staleness** vs an injected clock (`opts.now`, default `Date.now()`): a source older than **180 days** is downgraded. Overall confidence = min(per-source) capped 0.75; if all sources are `training-cutoff` (or web-search was on but returned zero web sources) → cap **0.5**; if all merely stale → cap **0.6**.
- **No range derivation** — the LLM returns each component's `{low,central,high}` directly *and* cites sources; we never average/blend (removes the multi-source opacity finding). A component may carry >1 source row for transparency.
- **`TcoProfile` validated** via `validateTcoProfile` (throws before any LLM call): `dbType ∈ {mongodb,postgresql,mysql}`, `shards/hoVcpu/drVcpu/dataCompressedGb` finite `>0`, `licenseModel? ∈ {enterprise,community,premium}`, `drPosture ∈ {none,cold,warm}`. **`region` dropped for v1** (D4 defers regional scaling to 10c; removes an accepted-but-unused field).
- **Clock injection** — `opts.now?: number` (epoch ms) so staleness/golden tests never touch the system clock.
- **Component taxonomy** = the engine's `NORTHWIND` fixture exactly: on-prem `{license, hardware, storage, facility, labor, backup}` + `adbPrimary, coldDrAdd, warmDrAdd, migrationPs`. So the golden mock returns `NORTHWIND` and the result reconciles to every existing engine golden.

**Out of scope (later sub-plans):** the gate UI that shows researched ranges and lets the rep confirm/override (10l); regional scaling and dbType-specialized cost models (10c+); A/B-ing Claude vs OpenAI search quality in production.

## Files
- Create: `src/research/tco.ts` — types, `TCO_RESEARCH_SCHEMA`, `validateTcoProfile`, `normalizeAndValidate`, `researchTcoCosts`, `sourcesToClaims`, `TcoResearchValidationError`.
- Create: `src/research/tco.test.ts` — unit tests (mock `LLM`, mock budget).
- Create: `src/research/tco.golden.test.ts` — NORTHWIND round-trip + engine reconciliation + confidence paths.

---

### Task 1 — `TcoProfile` + `validateTcoProfile`
- Files: `src/research/tco.ts`, `src/research/tco.test.ts`
- [ ] Test: a valid mongodb/enterprise/warm profile passes; bad `dbType`, non-positive `shards`/`dataCompressedGb`, bad `licenseModel`, bad `drPosture` each throw `TcoResearchValidationError`.
- [ ] Implement `TcoProfile` interface + `validateTcoProfile(p): void` (throws). Enums via `const` arrays + `.includes`.

### Task 2 — `TCO_RESEARCH_SCHEMA` + `normalizeAndValidate`
- Files: `src/research/tco.ts`, `src/research/tco.test.ts`
- [ ] Test: a well-formed parsed object yields ordered ranges unchanged; a point-estimate `{100,100,100}` normalizes to `{80,100,120}` then passes; `low>central` (after normalize) throws; negative/`NaN`/`Infinity`/missing component throws; `asOfDate:'2026-13-01'` throws; a `published` source missing `url` throws; a `training-cutoff` source without `url` passes.
- [ ] Implement `TCO_RESEARCH_SCHEMA: JsonSchema` (10 ranges + `sources[]`) and `normalizeAndValidate(parsed, now): { inputs: TcoInputs; sources: CostSourceRow[] }` (two-pass).

### Task 3 — `researchTcoCosts` (single call + fallback + budget)
- Files: `src/research/tco.ts`, `src/research/tco.test.ts`
- [ ] Test (mock `LLM`): valid response → `{inputs, sourcing, confidence, usage}`, `inputs` deep-equals the mock, `usage` captured, fresh published sources → `confidence===0.75`.
- [ ] Test: mock throws `ProviderError` first call, returns valid JSON on the no-`webSearch` retry → succeeds, `confidence===0.6`, all sources `training-cutoff`; assert the second call omitted `webSearch`.
- [ ] Test: mock returns non-JSON → `TcoResearchValidationError`, and assert **only one** call was made (no retry).
- [ ] Test: `opts.budget` with a limit too small → `budgetGuard` blocks → `recordSkipped(budget,'research',…)` called and `TcoResearchValidationError` thrown (caller falls back); a generous budget → `recordUsage(budget,'research',usage)` checkpoint present.
- [ ] Test: all sources stale (asOf > 180 days before `opts.now`) → `confidence===0.6` + a warning; all `training-cutoff` → `confidence===0.5`.
- [ ] Implement `researchTcoCosts(llm, model, profile, opts?: { now?: number; budget?: Budget }): Promise<TcoResearchResult>` — validate profile → (budget guard) → build prompt → `llm.complete({ webSearch:true, jsonSchema })` → on `ProviderError` retry once without `webSearch` (re-guard budget) → `JSON.parse` (throw on fail) → `normalizeAndValidate` → compute confidence → `recordUsage` → return. `TcoResearchResult = { inputs: TcoInputs; sourcing: CostSourceRow[]; confidence: number; usage: Usage; warnings: string[] }`.

### Task 4 — `sourcesToClaims`
- Files: `src/research/tco.ts`, `src/research/tco.test.ts`
- [ ] Test: produces one `ClaimInput` per cost component (10), each `id==='research:<component>'`, `section:'D'`, `value` = that component's `central`, sensible `unit` (`USD/yr` for annual, `USD` one-time for `migrationPs`), `declaredSource.label` embeds source+url+asOfDate, and `declaredSource.confidence` is `'medium'` for confidence 0.75 / `'low'` for ≤0.5 — **never `'high'`**.
- [ ] Test: returns a NEW array; calling twice does not accumulate/mutate.
- [ ] Implement `sourcesToClaims(result: TcoResearchResult): ClaimInput[]` with a numeric→`ClaimConfidence` map (`≥0.85 high · ≥0.6 medium · else low`).

### Task 5 — Golden fixture + engine reconciliation
- Files: `src/research/tco.golden.test.ts`
- [ ] Test: mock `LLM` returns the `NORTHWIND` values + fresh published sources (`asOf 2026-05-01`, `now 2026-06-05`); `researchTcoCosts` → `inputs` deep-equals `NORTHWIND`, `confidence===0.75`.
- [ ] Test: feeding `result.inputs` into `onpremTotal/adbTotal/net5` reproduces the existing engine goldens (on-prem central, ADB warm/cold, net5) — proving researched inputs flow through the deterministic engine unchanged.

## Self-Review
- All 5 critical + 5 major + 2 minor critique findings resolved (architecture eliminates leak+mutation; combo verified; two-pass normalize; staleness+date parsing enforced w/ injected clock; hallucination-resistant sources w/ `sourceQuality`; claims integration specified; profile validated; region dropped; golden confidence computed not hardcoded; no range derivation; budgeted retry).
- `runPipeline` and all Plan 06/08/09 types are untouched; reuses them verbatim.
- Determinism boundary explicit and tested: researched figures are sourced inputs, never `high`-confidence, never reach the engine without rep promotion.
- Adversarial review before merge.
