# Editable discovered metrics + Step-5 narrative tuning

_Design spec · 2026-06-12 · status: approved, pre-implementation_

Two related rep-facing improvements to the Step-4 (Confirm) and Step-5 (Generate) wizard steps:

1. **Adjustable discovered metrics.** Today the rep can only supply *missing* required signals at the
   gate; values CaseForge already discovered are read-only. The rep must be able to **adjust any
   discovered metric** — and adjusting (or filling) any metric makes the estimate **Directional**.
2. **Narrative tuning on Generate.** The rep can provide a narrative-tuning prompt on Step 5 so the
   *first* generation reflects it — no Generate-then-Refine round trip required.

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
  badge, and (if shared) the tuner.

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
- Goldens (`northwind-classify.golden.test.ts`, render goldens) — unchanged values; the Northwind case has
  no rep entries, so it stays engineering-grade.

**Docs**
- `docs/SIZING-METHODOLOGY.md` §5 — state the tightened bar: engineering-grade ⇔ every required signal
  read from an uploaded artifact, untouched; any rep fill/adjust → Directional. Note the Step-5 tuning
  prompt under the generation section.

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
- Build + full test suite green; `pnpm typecheck` / `pnpm lint` clean.

## 7. Out of scope

Model/pricing picker; cost-ticker provider pricing; per-entry measured-vs-estimated nuance; any change to
the engine math or the anonymization core.
