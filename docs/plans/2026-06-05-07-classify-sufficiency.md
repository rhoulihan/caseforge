# Classify/Triage + Data Intake & Sufficiency Report — Implementation Plan (plan 07)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Realize spec §7 + §9. A MongoDB **Source Profile** declares the *signal schema* (what sizing needs, with criticality), **triage** binds ingest `Primitive`s onto those signals (deterministic-first; LLM only to read charts / label ambiguous prose), and a pure **Data Intake & Sufficiency Report** tells the rep what was understood, what's missing, what to collect, and which result tier the evidence supports — driving the §8.5 assumptions/gaps gate.

**Architecture:** `src/profile/` = WHAT sizing needs (profile-agnostic vocabulary + the MongoDB v1 profile — the D4/§17 seam). `src/classify/` = HOW evidence maps to it: deterministic `stats` (avg/peak/P95) + `heuristics` (no-LLM binds) + a mocked `llm` seam (vision/prose), orchestrated by `triage`, then a pure `sufficiency` report builder. **Determinism boundary (non-negotiable):** `stats.ts` owns all numbers, `sufficiency.ts` owns coverage/tier, the LLM only *labels roles and reads values off pictures/prose* — it never computes a stat, coverage, tier, or total. Validated by the Northwind golden: chart-read util → `directional-estimate`; the same workload as native CSV → `engineering-grade`, with **no code change**.

**Tech Stack:** TypeScript strict / Vitest, pure-function + TDD house style (mirrors `src/engine`, `src/anon`). The LLM seam uses the existing `src/provider` `LLM` interface, mocked in tests via the `src/provider/index.test.ts` recorder pattern (object literal returning queued `CompleteResult`s — zero network).

**Decisions (open questions resolved):** util modeled as **3 `avgPeak` signals** (one per role, matching `RoleUtil`); the Peak÷N divisor is **engine policy, not a signal**; v1 sizes the full cluster (all 6 required entries), **never auto-defaults silently** (defaultable-required signals surface as asks; the gate fills them later); binders emit **raw** confidence, `sufficiency` applies the **method cap** (cap policy centralized on `ProfileThresholds`); sufficiency lives under `src/classify/`.

---

## Signal schema (MongoDB v1) — `src/profile/mongodb.ts`

**6 required entries → the 9 `SizingInputs` scalars** (`engine-required wins`):

| signal id | engineSlot | valueKind | defaultable | cap source |
|---|---|---|---|---|
| `cluster.shardCount` | `shards` | scalar | **false** | exact (keyvalue/table-lookup → 1.0) |
| `node.hoVcpu` | `hoVcpu` | scalar | **false** | exact |
| `node.drVcpu` | `drVcpu` | scalar | true (→`hoVcpu`, flagged) | exact |
| `util.primary` | `util.primary` | avgPeak | **false** | numeric-series 1.0 / vision 0.70 |
| `util.hoSec` | `util.hoSec` | avgPeak | true (fraction-of-primary, flagged) | numeric-series / vision |
| `util.dr` | `util.dr` | avgPeak | true (~.08/.20, flagged) | numeric-series / vision |

> `node.hoVcpu` covers BOTH primary and hoSec roles — its `collectWhy` documents the **home-region-homogeneity assumption**; a separate `node.hoSecVcpu` signal is a deferred v1 limitation (engine has one `hoVcpu` field). Triage flags an assumption if topology shows heterogeneous home-region tiers.

**Recommended** (coverage matrix + cost/confidence; `tcoCritical` ones also drive `whatToCollect`): `topology.nodesPerShard`, `data.logicalSizeGb`*, `data.storageSizeGb`*, `data.indexSizeGb`, `workingSetGb`, `node.ramGb`, `disk.iops`, `workload.opsPerSec`, `workload.concurrency`, `workload.oplogGbPerHour`, `mongo.edition`, `workload.readPreference`, `growth.annualPct`, `dr.posture`. (`*` = `tcoCritical: true` — storage ≈79% of the Northwind bill; a `directional-estimate` missing it must still ask for it.)
**Optional** (refinement only): `data.collectionProfile`, `network.egressGbMonth`, `workload.peakWindow`.
**Excluded:** all `TcoInputs` cost-model fields (come from a cost model + web search, not artifacts) — only the customer-derived *selectors* `mongo.edition` / `dr.posture` are signals.
`growth.annualPct` derivation in v1 = **stated assumption / LLM-text only** (no native trend-slope — that's a modeling choice, deferred).

## File structure
- `src/profile/types.ts` — profile-agnostic vocabulary: `Criticality`, `DerivationMethod` (`numeric-series`|`keyvalue`|`table-lookup`|`vision`|`llm-text`|`heuristic`|`assumption-default`|`manual`), `SignalValueKind`, `SignalSpec` (`id,label,unit?,valueKind,criticality,defaultable,tcoCritical?,derivableBy[],aliases[],engineSlot?,collectRequest,collectWhy`), `SignalSchema`, `SourceProfile`, `ProfileThresholds` (the method caps + tier floors).
- `src/profile/mongodb.ts` — `MONGODB_PROFILE: SourceProfile` (pure data; the 23 signals above). `src/profile/mongodb.test.ts`.
- `src/classify/types.ts` — `Coverage`, `EvidenceRef{source,primitiveKind,locator?}`, `SignalValue = number | {avgPct,peakPct} | string`, `BindingResult{signalId,value?,confidence,method,evidence[],note?}`, `PrimitiveClassification`, `TriageResult{profileId,inventory[],bindings[]}`.
- `src/classify/stats.ts` (+test) — `parseNumericColumn`, `seriesStats`, `isTimestampColumn`, `detectPercentScale(header,values)`, `asUtilFraction(stats,percentScaled)`.
- `src/classify/heuristics.ts` (+test) — `classifyTable` (per-column cost-model routing), `bindKeyValue`, `bindNumericSeries` (role-token + metric-token disambiguation), `matchSignalByAlias`, `roleTokenOf`, `isNoise`.
- `src/classify/llm.ts` — `readChartImage`, `classifyProse`, `CHART_SCHEMA`/`PROSE_SCHEMA` (the only LLM-touching code).
- `src/classify/triage.ts` (+test) — `triage(bundle,profile,llm?)`, `mergeBindings`, `coverageFor`, `toSizingInputs`.
- `src/classify/sufficiency-types.ts` — `ResultTier`, `InventoryItem` (role `evidence|noise|unrecognized` — **no `flagged` in v1**), `SignalCoverageItem`, `OutputQualityVerdict`, `WhatToCollectItem`, `SufficiencyReport`.
- `src/classify/sufficiency.ts` (+test) — `buildSufficiencyReport(triage,files,profile)` + pure sub-functions.
- `src/classify/northwind-classify.golden.test.ts` — end-to-end determinism-seam proof.

## Method caps & tier rules (on `ProfileThresholds`, the critique fixes)
- **Caps:** `numeric-series`/`keyvalue`/`table-lookup`/`manual` = **1.0** (exact parse or rep-confirmed measurement); `llm-text` = 0.75; `vision` = 0.70; `heuristic` (inferred/fuzzy alias or role guess) = 0.60; `assumption-default` = **0.50**.
- **Coverage:** `effectiveConfidence = min(rawConfidence, methodCap)`; `missing` if `value==null || eff < MISSING_FLOOR(0.2)`; `satisfied` if `eff >= ENG_FLOOR(0.8)`; else `partial`.
- **Verdict (`computeVerdict`, over REQUIRED signals only):**
  - `blocked` — any required `missing`.
  - `engineering-grade` — required `missing==0 && partial==0 && every eff>=ENG_FLOOR && mean>=ENG_MEAN(0.85) && no required method === 'assumption-default'`.
  - `directional-estimate` — otherwise (no hard gaps, but not all required clear the bar). *Northwind lands here:* vision util capped 0.70 → `partial`.
  - `rationale` additionally flags a missing `tcoCritical` recommended signal ("storage size absent — the dominant cost line is unevidenced") so a directional estimate isn't mistaken for cost-defensible.
- **whatToCollect (required-only + missing `tcoCritical` recommended):** `missing`→`blocking`; `partial`→`upgrade`. `request`/`why` from the static `collectRequest`/`collectWhy` (deterministic, not LLM). Order: blocking → upgrade, then ascending `eff`, then `signalId` lexical (stable, copy-pasteable).

---

### Task 1 — profile vocabulary (`src/profile/types.ts`)
Type-only; compiled by tsc strict, exercised by Task 2. Acceptance: all unions + `SignalSpec`/`SignalSchema`/`SourceProfile`/`ProfileThresholds` type-check.

### Task 2 — MongoDB v1 profile (`src/profile/mongodb.ts` + test)
Tests: exactly 6 required signals; their `engineSlot`s are exactly `{shards,hoVcpu,drVcpu,util.primary,util.hoSec,util.dr}` (every `SizingInputs` field); `defaultable===false` only for `cluster.shardCount`/`node.hoVcpu`/`util.primary`; util signals are `valueKind:'avgPeak'`; `data.logicalSizeGb`/`data.storageSizeGb` are `tcoCritical`; every signal has non-empty `collectRequest`+`collectWhy`; aliases all-lowercase and globally unique.

### Task 3 — deterministic stats (`src/classify/stats.ts` + test)
Tests: `seriesStats([10,20,30,40])` → `{avg:25,peak:40,p95:40,min:10,n:4}`; `parseNumericColumn(['45%','1,200','32 vCPU','','x'])` → `[45,1200,32]`; `isTimestampColumn` true for ISO/epoch, false for `['18','22','45']`; **`detectPercentScale('System CPU %',[...])` true; `detectPercentScale('cpu',[18,22,45])` true (max>1.5); `detectPercentScale('util',[0.18,0.45])` false**; `asUtilFraction({avg:18,peak:45},true)`→`{avgPct:0.18,peakPct:0.45}` and `(…,false)` leaves `0.18/0.45` untouched (the 100× guard).

### Task 4 — classify result types (`src/classify/types.ts`)
Type-only. Acceptance: `BindingResult.value` accepts `number | {avgPct,peakPct} | string`; `EvidenceRef.primitiveKind` is `Primitive['kind']`; `TriageResult` holds `inventory+bindings` (no tier/toCollect — those are sufficiency's).

### Task 5 — no-LLM heuristics (`src/classify/heuristics.ts` + test)
Tests: `classifyTable` on `{timestamp,cpu%}` → `'metric-time-series'` with series cols; **per-column routing** — a BOM table with a `cores` column AND a `cost ($)` column still binds `node.hoVcpu` from `cores` while the currency column is ignored for sizing; `bindKeyValue({'cores per node':'32'})`→`node.hoVcpu=32` method `keyvalue`, `{'shards':'3'}`→`cluster.shardCount=3`; `matchSignalByAlias('System CPU')` resolves primary-util case-insensitively; **role disambiguation** — two same-named `System CPU` series, one with a `secondary`/`DR` role token in header/source, do NOT both bind `util.primary` (the unlabeled one stays unresolved for LLM role-labeling); `isNoise` true for empty tables + signature footers, false for a CPU table.

### Task 6 — triage merge + toSizingInputs, heuristics-only (`src/classify/triage.ts` + test)
Tests: `triage(northwindBundle, MONGODB_PROFILE)` with NO llm binds shards/vcpu/util from native tables; `mergeBindings` prefers a `numeric-series` candidate over a `vision` candidate for the same signal; `toSizingInputs` over a full Northwind binding set returns inputs `deepEqual NORTHWIND_SIZING` and `consumedEcpu(inputs,'workload').ratio` **`toBe(2.5)`**; `toSizingInputs` with `util.primary` unbound → `{missing:[…]}` and **no inputs** (never invents).

### Task 7 — the LLM seam, mocked (`src/classify/llm.ts` + triage.test)
Tests (mock `LLM` = object literal returning queued `CompleteResult`): `readChartImage` sends the base64 bytes as a per-message `ImageInput` and emits `BindingResult(method 'vision', confidence raw)` parsed from `{signalId,avgPct,peakPct,confidence}`; `classifyProse('MongoDB Enterprise Advanced, reads to secondaries')` emits `mongo.edition` + `workload.readPreference` binds method `'llm-text'`; `triage` with the mock escalates ONLY image/ambiguous-prose primitives (native tables stay heuristic).

### Task 8 — sufficiency types (`src/classify/sufficiency-types.ts`)
Type-only. Acceptance: `ResultTier` is exactly `'blocked'|'directional-estimate'|'engineering-grade'`; `WhatToCollectItem.severity` is `'blocking'|'upgrade'`; `InventoryItem.role` has no `'flagged'` in v1.

### Task 9 — deterministic sufficiency report (`src/classify/sufficiency.ts` + test)
Tests: (1) empty `TriageResult` → `'blocked'`, whatToCollect lists all 6 required as `'blocking'`. (2) all-native high-conf required → `'engineering-grade'`, whatToCollect empty, `requiredPartial 0`. (3) Northwind vision util (cap 0.70) → `'directional-estimate'`, exactly **6** `'upgrade'` items (assert exact array), 0 `'blocking'`, `limitingSignals` = the 3 util signals. (4) one required `missing` among satisfied → `'blocked'` with that lone `limitingSignal`. (5) **a required signal filled by `assumption-default` (conf 1.0 raw) is capped to 0.5 → `partial` → tier stays `'directional-estimate'`, never `engineering-grade`** (the critical fix); a `manual` rep-confirmed (1.0) on the same signal → `satisfied` → promotes. (6) exact-scalar: `keyvalue`-bound `cluster.shardCount` reaches `satisfied`/ENG_FLOOR (the cap fix). (7) inventory: ok-but-unbound→`'noise'`, `!ok`→`'unrecognized'`. (8) coverage left-join: a required signal absent from bindings still appears as a `'missing'` row. (9) a missing `tcoCritical` recommended signal adds an `'upgrade'` ask and a `rationale` flag. (10) whatToCollect ordering: blocking→upgrade, then ascending eff, then signalId; MISSING_FLOOR/ENG_FLOOR boundary cases.

### Task 10 — Northwind golden end-to-end (`src/classify/northwind-classify.golden.test.ts`)
An Northwind-shaped `EvidenceBundle` (CPU charts as `ImagePrimitive`s + topology/HW `keyvalue`) → `triage` with the mock vision LLM → `buildSufficiencyReport` → `toSizingInputs`: report `tier === 'directional-estimate'`, exactly 6 `'upgrade'` asks. The SAME workload as native CPU CSV tables (no images) → `tier === 'engineering-grade'` and `toSizingInputs` `deepEqual NORTHWIND_SIZING`, feeding the existing `baseFor`/`ceilings` golden (n=2→22, 44/66; n=3→18, 36/54). Note: the vision path assumes anonymization is OFF / charts cleared (on-anon images are quarantined by the launcher per §8 step 2 — that contract threads in Plan 10).

## Self-Review
- Realizes spec §7/§9; determinism boundary is structural (stats/sufficiency pure; LLM only labels/reads, injected + mocked).
- All adversarial-critique fixes are encoded as tests: assumption-default cap, exact-scalar cap, role disambiguation, percentScaled rule, per-column cost routing, tcoCritical asks, exact assertions.
- `flagged[]` (anon quarantine) and the §8.5 gate's manual-override UI are deferred to Plan 10; the `manual` method + cap exist now so the gate has a seam.
- Adversarial review before merge.
