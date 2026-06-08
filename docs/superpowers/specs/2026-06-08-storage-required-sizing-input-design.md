# Storage as a required, gated sizing input

_Design spec · 2026-06-08 · status: approved, pre-implementation_

## 1. Problem

CaseForge silently substitutes a hardcoded **1000 GB** for the customer's on-disk data size
whenever the uploaded artifacts don't yield a storage figure. The substitution lives in
`src/ui/pipeline.ts:44`:

```ts
export function dataGbFromTriage(triage: TriageResult | null, fallback = 1000): number {
  return numericBinding(triage, 'data.storageSizeGb')
      ?? numericBinding(triage, 'data.logicalSizeGb')
      ?? fallback;            // ← silent 1 TB default
}
```

That defaulted value flows into three rendered, customer-facing places:

1. **ADB storage cost line** — `render/builders.ts:43` (`monthlyStorageCost = round(dataCompressedGb × storagePerGbMo)`), the **dominant TCO driver** (~79 % of the reference bill per the profile's own `collectWhy`).
2. **Cold-DR RTO** — `render/builders.ts:83` (`coldRtoHours(dataCompressedGb / 1000)`), rendered verbatim as e.g. `~2 hrs`.
3. **Cost-research LLM prompt** — `research/tco.ts:244` (`${dataCompressedGb} GB compressed data`), biasing even "researched" cost ranges.

**Root cause.** Both storage signals (`data.storageSizeGb`, `data.logicalSizeGb`) are classified
`criticality: 'recommended'` (`profile/mongodb.ts:103,116`), not `required`. The §8.5 gate only renders
rows and blocks for **required** signals (`orchestrate/gate.ts:49`, `classify/triage.ts:173-175`), so a
case reaches engineering-grade and generates with **zero** storage evidence, and the UI layer then fills
the hole with 1000 GB. The golden fixture uses **45,800 GB (~45.8 TB)** — 46× the fallback — confirming
1000 GB is an uncalibrated placeholder, not a representative estimate.

A provenance audit (5 parallel traces + adversarial verification) confirmed this is the **single**
load-bearing silent default on the cost path. The authoritative **compute** path (shards, hoVcpu, drVcpu,
util.\*) is already fail-closed — `toSizingInputs` returns `{ missing }` and the orchestrator blocks rather
than inventing a value. Secondary fabrications exist only in the cost-**research** prompt
(`tcoProfileFromState`: `shards ?? 1`, `hoVcpu ?? 8`, `drVcpu ?? 0`, hardcoded `drPosture: 'warm'`).

**Compounding wiring bug.** `buildRunConfig`/`tcoProfileFromState` read storage **and** topology from
`state.triage` (**pre-gate**), while a rep's gate entries live in `state.gateAnswers` (merged only *inside*
`runPipeline` via `applyGateAnswers`). So even a rep who enters storage at the gate today would be ignored
by the pre-gate read and still fall back to 1000. Any fix must thread the **post-gate** value.

## 2. Decisions (locked)

| # | Question | Decision |
|---|----------|----------|
| 1 | Canonical required storage measure | **On-disk compressed** (`data.storageSizeGb`, `db.stats().storageSize`). `logicalSizeGb` stays a recommended corroborator. |
| 2 | Behavior when files contain no storage | **Require entry, allow a flagged estimate** — `required` + `defaultable:true`. Gate demands a value; an unmeasured one flags the report **Directional** (never engineering-grade). No silent default. |
| 3 | Scope | **Fix all silent defaults now** — storage *plus* the research-prompt fabrications, threaded from post-gate values. |

## 3. Goals / non-goals

**Goals.** Every value feeding sizing/cost/DR is either file-derived or rep-entered — never a hidden
constant. Make the silent storage default *unrepresentable* in the type system. Close the post-gate wiring
gap so rep entries actually reach the cost/research paths.

**Non-goals (flagged, not doing).** `DEFAULT_TCO_INPUTS` (already UI-labelled "not researched" — surfaced,
not silent); a `logicalSizeGb → compressed` auto-derivation; the `tokenBudget` prefill; benign identity
defaults (`discountPct ?? 0`, `targetPlatform`, `assumptions: []`, `paybackYear ?? 2`).

## 4. Design (Approach B — type-enforced)

### 4.1 Type change (the heart of B)

- Add `dataCompressedGb: number` to **`SizingInputs`** (`engine/types.ts`). Storage becomes a first-class,
  non-optional member of the gated sizing facts — literally "a required sizing item." `consumedEcpu`
  ignores the field (acceptable: `SizingInputs` is "the customer's gated sizing facts," not strictly the
  ECPU vector).
- Remove `dataCompressedGb` from **`EcpuStorageRates`** (`render/builders.ts`), which becomes pure Oracle
  rate constants: `{ ecpuPerHr, storagePerGbMo, hoursPerMonth? }`.

*Net effect:* you cannot construct `SizingInputs` without storage, and you cannot reach
`buildTcoSection` / `scenario` / `coldRtoHours` except through a gated storage value. The discount logic
stops scaling the data size (correct — a volume isn't discounted).

### 4.2 Data flow

1. `profile/mongodb.ts` — `data.storageSizeGb` → `criticality: 'required'`, `defaultable: true`,
   `tcoCritical: true` (unchanged). No `engineSlot` (it doesn't feed ECPU).
2. `classify/triage.ts` `toSizingInputs` — already blocks when *any* `required` signal is unbound, so
   storage is covered for free. After the existing missing-guard, set
   `dataCompressedGb: num('data.storageSizeGb')` on the returned `SizingInputs`.
3. `orchestrate/gate.ts` / `orchestrate/index.ts` — already pass `applied.inputs` into `assembleDocModel`;
   storage rides along with **no new orchestrator plumbing**.
4. `render/builders.ts` — read `inputs.dataCompressedGb` in `scenario` (storage cost), `buildTcoSection`
   (`coldRtoHours`), and `DocModel.sizing.dataCompressedGb`. Signatures: `buildTcoSection(tcoInputs,
   dataCompressedGb)` (it only ever used `rates.dataCompressedGb`); `scenario`/`buildSizingScenarios` keep
   a rate-only `EcpuStorageRates` and read the size from `inputs`.
5. **Post-gate wiring fix** (`ui/pipeline.ts`): `buildRunConfig` no longer sets storage on `rates`
   (constants only); delete `dataGbFromTriage`'s `?? 1000`. `tcoProfileFromState` reads **merged post-gate
   bindings** (`applyGateAnswers(state.triage, state.gateAnswers, files, profile)`), so rep gate entries
   reach the research prompt.

### 4.3 Gate / sufficiency behavior

- `buildGateData` renders a storage row automatically once it's `required` (reuses the scalar `GateRow`
  number input). A typed value → `manual` measurement (cap 1.0); an unmeasured estimate → flagged, demotes
  the verdict to **Directional**. Missing → sufficiency tier **blocked**, no report. Add a `> 0` validation
  on the entered value.
- `data.logicalSizeGb` stays `recommended` and does **not** auto-satisfy the storage requirement (per
  decision 1: the rep confirms/enters the on-disk figure even if files held only logical size).

### 4.4 Research-prompt cleanup

`ui/pipeline.ts` `tcoProfileFromState` + `research/tco.ts`:
- Remove `shards ?? 1`, `hoVcpu ?? 8`, `drVcpu ?? 0`; source from post-gate merged bindings (guaranteed
  present once the gate passes — generation is blocked otherwise).
- Replace hardcoded `drPosture: 'warm'` with the bound `dr.posture`. If unbound, make the research prompt
  posture-neutral (it already requests both warm and cold cost adds) rather than fabricating `'warm'` —
  make `TcoProfile.drPosture` optional and adjust `buildResearchPrompt` / `validateTcoProfile` accordingly.

## 5. File-by-file change list

**Production**
- `src/engine/types.ts` — add `dataCompressedGb: number` to `SizingInputs`.
- `src/profile/mongodb.ts` — `data.storageSizeGb` → `required`, `defaultable:true`.
- `src/classify/triage.ts` — `toSizingInputs` populates `dataCompressedGb` (block already covers it).
- `src/render/builders.ts` — drop `dataCompressedGb` from `EcpuStorageRates`; read it from `SizingInputs`;
  update `scenario` / `buildSizingScenarios` / `buildTcoSection` / `AssembleOptions` / `assembleDocModel`.
- `src/orchestrate/index.ts` — type-only follow-through (`RunConfig.rates` now rate-only); ensure storage
  flows via `applied.inputs`.
- `src/ui/pipeline.ts` — `buildRunConfig` rates = constants only; delete `?? 1000`; `tcoProfileFromState`
  uses post-gate merged bindings; remove `?? 1/8/0`; derive `drPosture` from binding.
- `src/research/tco.ts` — `drPosture` optional; posture-neutral prompt when unbound.
- `src/classify/sufficiency.ts` — verify the `missingTco` soft-note branch (storage leaves it once
  required; logical stays). Likely no logic change.

**Tests & fixtures**
- `src/classify/northwind-classify.golden.test.ts` — **add** a `data.storageSizeGb` binding (~45,800 GB) so
  the flagship golden stays engineering-grade instead of newly blocked.
- `src/render/fixtures/northwind-docmodel.ts` — storage coverage `recommended`→`required`; move
  `dataCompressedGb` from `rates` into `sizingInputs`.
- `src/classify/sufficiency.test.ts` — re-baseline tiers (storage now required).
- `src/ui/steps/Step4Confirm.test.tsx` — the "engineering-grade with zero storage" case now blocks / needs
  a storage answer.
- `src/render/builders.test.ts`, engine sizing golden — new signatures + storage in `SizingInputs`.
- **New regression test** — storage unbound ⇒ pipeline **blocks**; assert no `1000`/hardcoded GB reaches any
  rendered number.

**Docs**
- `docs/SIZING-METHODOLOGY.md` §5/§6 and the profile doc — storage is now required; cost case blocks
  without it.

## 6. Risks & verification

- **Golden churn is the main risk.** The Northwind classify golden currently binds *no* storage; it must
  gain a binding in the same change or it flips to blocked. Verify all goldens green after the fixture
  updates.
- **Directional-tier correctness:** a rep-entered estimate (assumption-default, cap 0.5) must demote the
  verdict to Directional and never engineering-grade — assert in a test.
- **No silent default remains:** the new regression test must prove the unbound-storage path blocks rather
  than rendering any number.
- Build + full test suite green; `pnpm` lint/typecheck clean.

## 7. Out of scope

`DEFAULT_TCO_INPUTS`, logical→compressed auto-derivation, `tokenBudget` prefill, and benign identity
defaults — see §3 non-goals.
