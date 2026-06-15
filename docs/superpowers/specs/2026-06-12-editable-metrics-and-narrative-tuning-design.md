# Editable metrics, Step-5 narrative tuning, and compressed/uncompressed storage

_Design spec · 2026-06-12 · status: approved, pre-implementation_

Three related rep-facing improvements to the Step-4 (Confirm) and Step-5 (Generate) wizard steps:

1. **Adjustable discovered metrics.** Today the rep can only supply *missing* required signals at the
   gate; values CaseForge already discovered are read-only. The rep must be able to **adjust any
   discovered metric** — and adjusting (or filling) any metric makes the estimate **Directional**.
2. **Narrative tuning on Generate.** The rep can provide a narrative-tuning prompt on Step 5 so the
   *first* generation reflects it — no Generate-then-Refine round trip required.
3. **Compressed/uncompressed storage.** The rep can mark the storage estimate as compressed or
   uncompressed (**default uncompressed**); an uncompressed figure is converted to the effective Oracle
   on-disk footprint via a researched, tunable **3× compression factor** before it feeds the ADB storage
   cost, the cold-DR RTO, and the cost-research prompt.

## 1. Background — current behavior

**Step 4 metrics.** Step 4 renders a **read-only** "Evidence coverage" table (every required signal:
value · method · confidence) plus a **separate** gate that only renders inputs for required signals that
are **missing or below the engineering floor** (`buildGateData`, `orchestrate/gate.ts`). A discovered,
confident signal is therefore not adjustable.

**Gate-answer mechanics.** A gate entry becomes a binding in `applyGateAnswers`: `confirmed:true → method
'manual'` (trust 7, cap 1.0), `confirmed:false → 'assumption-default'` (trust 0, cap 0.5), evidence source
`'rep-gate-answer'`. `mergeBindings` (`classify/triage.ts`) keeps the **highest-trust** binding per
signal. So `'manual'` (7) *wins* over any artifact-read method (numeric-series 6, keyvalue 5,
table-lookup 4, vision 3, llm-text 2) — an override takes effect — while `'assumption-default'` (0)
*loses* the merge. The v0.5.0 storage work special-cases storage to `confirmed:false` (→ Directional);
all other gate fills are `'manual'` (→ can be engineering-grade).

**Verdict.** `computeVerdict` (`classify/sufficiency.ts`): over the **required** coverage, engineering-grade
requires `partial.length === 0 && every eff ≥ engFloor (0.70) && mean ≥ engMean && !hasAssumed`; a missing
required signal → Blocked; otherwise Directional.

**Narrative tuning.** Step 6 (Refine) has a prose textarea + quick chips → `prepareRefineInstruction`
(`ui/refine.ts`: fail-closed — blocks names not in the anonymization map, slug-anonymizes, replays prior
slugged refinements) → `proseInstruction` → `runPipeline` → `generateProse`. Step 5 passes a
`proseInstruction` **only** in add-files mode; a first-time Generate has no narrative input.

## 2. Decisions (locked)

| # | Question | Decision |
|---|----------|----------|
| 1 | Tier policy when the rep touches a metric | **Policy B (uniform).** *Any* value the rep fills or adjusts at the gate → **Directional**. Engineering-grade means every **required** signal was read from an uploaded artifact at/above the bar, with **no rep entry**. |
| 2 | Step-4 UI | One **unified editable metrics table** (replaces the read-only coverage table + the separate gate inputs). |
| 3 | Which metrics are adjustable | Required signals + storage in the main table; recommended/`tcoCritical` signals in an expandable **Additional Metrics** section. |
| 4 | Tier scope | The engineering-grade / Directional / Blocked tier is driven by the **required** signals only. Editing an *Additional* (recommended) metric is used in the cost case but does **not** itself flip the tier. |
| 5 | Oracle compression factor | **3×** (uncompressed → effective on-disk), a tunable `ENGINE_CONFIG` constant. Midpoint of Advanced Compression's 2–4× and OSON's ~2.7–3×; conservative so we never overstate Oracle's storage efficiency. |
| 6 | Storage compression modeling | **One storage value + a compressed/uncompressed toggle** (default uncompressed), modeled as a companion enum signal rendered inline on the storage row — not its own metrics row. |
| 7 | Does the compression assumption demote the tier? | **No.** The 3× factor is a documented engine constant (like the ECPU ratio or the DR formula); only Policy-B rep entry/adjustment of the storage *value* demotes. |

## 3. Goals / non-goals

**Goals.** Let the rep correct anything CaseForge read; make the verdict honestly reflect rep involvement
(any touch → Directional; pure source-read → engineering-grade); let the rep shape the narrative before
the first Generate.

**Non-goals.** A model/temperature picker; per-metric "measured vs estimated" sub-distinctions (Policy B
collapses them — any rep entry is Directional); changing the deterministic engine math; the cost-ticker
provider-pricing follow-up.

## 4. Design

### 4.1 Verdict model under Policy B (`classify/sufficiency.ts`, `sufficiency-types.ts`)

- Add `repEntered: boolean` to `SignalCoverageItem`. `buildCoverage` sets it from the winning binding:
  `repEntered = !!b && b.evidence.some((e) => e.source === 'rep-gate-answer')`.
- `computeVerdict`: engineering-grade now also requires **no required signal is `repEntered`**. Concretely,
  replace the `!hasAssumed` clause with `!req.some((c) => c.repEntered)` (a rep-entered required signal —
  whether a fill or an override — forces Directional). Missing → Blocked is unchanged. The verdict
  rationale/`limitingSignals` should name the rep-entered signals ("Directional — rep-adjusted: …").
- This **generalizes** the storage rule to every signal, so the storage-specific path can be removed (§4.4).

### 4.2 Gate answers = rep-entered bindings (`orchestrate/gate.ts`, `ui/state.ts`)

- `GateAnswer` becomes `{ signalId: string; value: SignalValue }` — **drop `confirmed`** (Policy B makes the
  manual/assumption distinction tier-irrelevant).
- `applyGateAnswers` binds every answer as a single rep-entered method: **`method: 'manual'`** (trust 7, so
  it wins `mergeBindings` and an override takes effect), `confidence: 1`, `evidence: [{ source:
  'rep-gate-answer', primitiveKind: 'keyvalue' }]`, `note: 'rep-entered at the gate'`. (Method name kept as
  `'manual'` to avoid churn in the `TRUST`/`methodCap` tables; the verdict keys off the
  `rep-gate-answer` evidence source via `repEntered`, not the method, so no new derivation method is
  needed. `'assumption-default'` stays in the type system but is no longer emitted by the gate.)
- Blocking is unchanged: `toSizingInputs(merged).missing.length > 0 → blocked`.

### 4.3 The unified editable metrics table (`orchestrate/gate.ts` + `ui/steps/Step4Confirm.tsx`)

- New builder in `gate.ts` (replacing `buildGateData`'s role): `buildMetricsForm(sufficiency, profile)`
  returns `{ required: MetricRow[]; additional: MetricRow[] }` where
  `MetricRow = { signalId; label; valueKind: 'scalar'|'avgPeak'|'enum'; value: SignalValue | null;
  method: DerivationMethod | null; status; effectiveConfidence; repEntered; collectRequest; collectWhy }`.
  - `required` = coverage items with `criticality === 'required'` (in profile order).
  - `additional` = coverage items with `criticality === 'recommended'` (this set includes the
    `tcoCritical` cost-driver signals such as logical data size; `optional` signals are **excluded**).
    Ordered `tcoCritical`-first, then by label.
- `Step4Confirm.tsx` renders one editable table from `required`, and an expandable `<details class=
  "cf-additional-metrics">Additional Metrics</details>` from `additional`. The old read-only coverage
  table and the separate gate-inputs block are removed.
- A `MetricRow` component (generalizes today's `GateRow`) renders, per row: the label, the discovered
  value + a provenance badge (method · confidence, or "missing"), and an inline input pre-filled with the
  discovered value. Input kind by `valueKind`: scalar → one number; `avgPeak` → avg/peak % pair (existing
  util inputs); `enum` → a select/text (e.g. `dr.posture`, `mongo.edition`). Editing emits a `GateAnswer`;
  a **Revert** control (clears the input) removes the answer so the discovered binding stands again.
- Rep-entered/adjusted rows are marked distinctly (an "adjusted" badge), so a Directional verdict is
  self-explanatory — never a misleading "satisfied 1.00".
- `confirm()` unchanged in spirit: `applyGateAnswers(answers)` → block if a required signal is still
  missing; else `patch({ gateAnswers, confirmed: true })`.
- Validation: scalar/util inputs reject ≤ 0 / NaN / avg > peak (as the util inputs do today).

### 4.4 Remove the storage special-case (`ui/steps/Step4Confirm.tsx`)

The `isStorage` / `confirmed:false` branch and its bespoke hint are deleted — under Policy B a gate-entered
storage value is Directional via the general `repEntered` rule, identical to every other metric.

### 4.5 Additional-metrics → cost path (no new plumbing)

`applyGateAnswers` already merges answers for **any** signalId, and `tcoProfileFromState` reads the
**post-gate merged bindings** (the v0.5.1 wiring). So an adjusted Additional metric (logical size, DR
posture, …) flows into the cost-research profile automatically. Required edits flow to `SizingInputs` as
today. No tier change from Additional edits (§2 #4).

### 4.6 Narrative tuning on Generate (`ui/steps/Step5Generate.tsx`, optional shared component)

- Add a prose textarea + the Step-6 quick chips to Step 5 (a shared `NarrativeTuner` component used by
  both steps is preferred for DRY; inline is acceptable).
- In `generate()`, run the Step-5 tuning text through `prepareRefineInstruction` **always** (not just
  add-files): fail-closed name check, slug-anonymize, compose with replayed history. Pass `effective` as
  `proseInstruction` to `buildRunConfig`; on success, append a refinement-history entry (so it replays on
  later regenerates, exactly like a Step-6 refine). The add-files carried-instruction path folds into the
  same single prepare call.

### 4.7 Compressed/uncompressed storage + Oracle compression factor

The customer's "database size" is usually the **logical/uncompressed** figure, but the ADB storage cost
must reflect the **compressed on-disk** footprint Oracle would actually store.

- **One storage value + a compression toggle.** The required storage metric (`data.storageSizeGb`,
  re-cast as "storage size estimate") gains a **compression state** — `compressed | uncompressed`,
  **default uncompressed** — modeled as a companion enum signal `data.storageCompressionState`
  (`recommended`, default `uncompressed`). It is **not** its own metrics row; the storage row renders the
  value input plus an inline compressed/uncompressed toggle that drives this signal.
- **Discovery default.** When a storage figure is read or rep-entered without a clear compressed/on-disk
  cue (e.g. `db.stats().storageSize`, "on-disk", "compressed"), the engine treats it as **uncompressed**.
  An explicit on-disk/compressed cue — or the rep's toggle — marks it compressed. (Heuristic binding may
  set `data.storageCompressionState = 'compressed'` when it binds from a `storageSize`/on-disk alias.)
- **Engine.** New pure function `effectiveCompressedGb(rawGb, compressed, ratio)` in `engine/storage.ts`:
  `compressed ? rawGb : rawGb / ratio`. New constant `ENGINE_CONFIG.adb.compressionRatio = 3` (sourced
  comment: Oracle Advanced Compression 2–4× / OSON ~2.7–3×; conservative midpoint; tune in one place),
  pinned by the `config.test.ts` drift guard.
- **Where it's applied.** The *effective* compressed GB is computed wherever the storage size is consumed
  for cost/DR/research: `toSizingInputs` (engine path → `dataCompressedGb`) and `tcoProfileFromState`
  (research path) both read the raw value (`data.storageSizeGb`) + the compression state and apply
  `effectiveCompressedGb`. Every existing consumer (`scenario` storage cost, `buildTcoSection` cold-RTO,
  the research prompt) keeps receiving a single effective on-disk number — no consumer changes.
- **Transparency.** `DocModel.sizing` carries the raw figure, the compression state, the ratio, and the
  derived effective size, so the rep/deliverable can show e.g. "45.8 TB (uncompressed) → ~15.3 TB
  effective on Oracle (assumes 3× Advanced Compression)".
- **Tier.** The 3× factor is a documented modeling constant and does **not** demote the tier (decision
  #7). Per Policy B, only rep entry/adjustment of the storage **value** demotes; toggling the compression
  state or relying on the default is modeling metadata, not a value change.

## 5. File-by-file change list

**Production**
- `src/classify/sufficiency-types.ts` — add `repEntered: boolean` to `SignalCoverageItem`.
- `src/classify/sufficiency.ts` — `buildCoverage` sets `repEntered`; `computeVerdict` requires
  `!req.some(c => c.repEntered)` for engineering-grade; rationale names rep-entered signals.
- `src/orchestrate/gate.ts` — `GateAnswer` drops `confirmed`; `applyGateAnswers` binds rep entries as
  `'manual'` + `rep-gate-answer`; add `buildMetricsForm` (and retire/replace `buildGateData`).
- `src/ui/state.ts` — `GateAnswer` type (drop `confirmed`); no other state shape change.
- `src/ui/steps/Step4Confirm.tsx` — unified editable metrics table + Additional Metrics expander +
  `MetricRow` component + Revert; remove the read-only coverage table, the separate gate block, and the
  storage `isStorage` special-case.
- `src/ui/steps/Step5Generate.tsx` — narrative tuning input; always prepare + thread `proseInstruction`;
  log to refinement history.
- `src/ui/NarrativeTuner.tsx` (new, optional) — shared textarea + chips for Step 5 / Step 6.
- `src/ui/styles.css` — styles for the metrics table, the Additional Metrics `<details>`, the adjusted
  badge, the storage compression toggle, and (if shared) the tuner.
- `src/engine/config.ts` — add `adb.compressionRatio = 3` (sourced comment).
- `src/engine/storage.ts` (new) — pure `effectiveCompressedGb(rawGb, compressed, ratio)`.
- `src/engine/types.ts` — `SizingSection`/`DocModel.sizing` (in `render/types.ts`) carries raw storage GB,
  compression state, ratio, and effective compressed GB for display.
- `src/profile/mongodb.ts` — re-label `data.storageSizeGb` as "storage size estimate"; add the companion
  `data.storageCompressionState` enum signal (`recommended`, default `uncompressed`); add a `storageSize`/
  on-disk alias mapping that sets the state to `compressed` on discovery.
- `src/classify/triage.ts` — `toSizingInputs` computes `dataCompressedGb` via `effectiveCompressedGb` from
  the raw value + compression state; carries raw + state for display.
- `src/ui/pipeline.ts` — `tcoProfileFromState` applies `effectiveCompressedGb` (research path).
- `src/render/builders.ts` — thread raw/state/ratio/effective into `DocModel.sizing`; the renderer shows
  the "uncompressed → effective" line. `EcpuStorageRates`/`dataCompressedGb` consumers unchanged (still
  receive the effective number).
- `src/ui/steps/Step4Confirm.tsx` — the storage `MetricRow` renders the value input + an inline
  compressed/uncompressed toggle (emits a `data.storageCompressionState` gate answer); the companion
  signal is excluded from the standalone row list.

**Tests**
- `src/classify/sufficiency.test.ts` — re-baseline: a rep-entered (`rep-gate-answer`) required signal →
  Directional (previously a `manual` fill could be engineering-grade); all-source-read stays
  engineering-grade; missing → Blocked.
- `src/orchestrate/gate.test.ts` — `GateAnswer` without `confirmed`; an override answer wins the merge over
  a discovered binding and marks the signal `repEntered`.
- `src/ui/steps/Step4Confirm.test.tsx` — editable rows for discovered metrics; adjusting a discovered value
  → Directional; Revert restores the discovered value (engineering-grade returns); the Additional Metrics
  section is collapsible and its rows are editable; the storage special-case test is replaced by the
  general rule.
- `src/ui/steps/Step5Generate.test.tsx` — a Step-5 tuning prompt is fail-closed-checked, threaded as
  `proseInstruction`, and logged to history; a prompt naming an unmapped person blocks with the Step-3
  pointer.
- `src/engine/storage.test.ts` (new) — `effectiveCompressedGb`: compressed → raw; uncompressed → raw/3;
  guards on ≤ 0 / NaN. `src/engine/config.test.ts` — pin `adb.compressionRatio = 3`.
- Discovery default: a storage figure with no compressed cue binds `storageCompressionState = 'uncompressed'`
  and the effective GB = raw/3; a `storageSize`/on-disk cue (or rep toggle) → `compressed`, effective = raw.
- `Step4Confirm.test.tsx` — the storage row shows the toggle; toggling to compressed changes the effective
  size; the companion signal isn't a standalone row.
- DocModel/render: `sizing` exposes raw + state + effective; the deliverable shows the "uncompressed →
  effective" line for an uncompressed estimate.
- Goldens (`northwind-classify.golden.test.ts`, render goldens) — the Northwind storage figure (45,800 GB)
  is the **on-disk compressed** number, so the fixture must bind `storageCompressionState = 'compressed'`
  to keep the effective size at 45,800 (no factor) and the golden numbers unchanged. The Northwind case has
  no rep entries, so it stays engineering-grade.

**Docs**
- `docs/SIZING-METHODOLOGY.md` §5 — state the tightened bar: engineering-grade ⇔ every required signal
  read from an uploaded artifact, untouched; any rep fill/adjust → Directional. Note the Step-5 tuning
  prompt under the generation section, and document the storage compression state + the 3× Oracle
  compression factor (with its source) in §1/§7.

## 6. Risks & verification

- **Verdict re-baseline is the main risk.** Several existing tests assume a `manual` gate fill is
  engineering-grade; they must flip to Directional. Verify the Northwind goldens (no rep entries) stay
  engineering-grade and the full suite is green.
- **Override actually takes effect.** A `'manual'` rep answer must win `mergeBindings` over the discovered
  binding (trust 7 > all artifact methods) — assert in `gate.test`.
- **Revert restores source provenance.** Clearing an edited row removes the answer; the discovered binding
  re-wins and the tier returns to engineering-grade — assert.
- **Fail-closed narrative tuning.** The Step-5 prompt must never reach the LLM with an unmapped name —
  assert the block path.
- **Compression default changes the goldens unless handled.** The new default is *uncompressed*, but the
  Northwind 45,800 GB figure is on-disk compressed — the fixtures must bind `compressed` so the effective
  size (and every downstream golden number) is unchanged. Verify.
- **Single source for the effective size.** The engine path (`toSizingInputs`) and the research path
  (`tcoProfileFromState`) must apply `effectiveCompressedGb` consistently, so the cost line and the
  research prompt agree. Assert both yield the same effective GB for the same raw value + state.
- Build + full test suite green; `pnpm typecheck` / `pnpm lint` clean.

## 7. Out of scope

Model/pricing picker; cost-ticker provider pricing; per-entry measured-vs-estimated nuance; any change to
the engine math or the anonymization core.
