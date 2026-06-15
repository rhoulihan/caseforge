# Engine-Derived Oracle Cost — Design Spec

**Date:** 2026-06-15
**Status:** Awaiting review
**Branch (proposed):** `fix/engine-derived-oracle-cost`

## Problem

A rep can now adjust the discovered sizing in Step 4 (vCPU, shards, util, storage), but the
**business-case Oracle cost does not move**. Confirmed by a runtime probe and three user reports:

- Doubling vCPU (provisioned base 22→44 ECPU) → business-case ADB annual, savings %, 5-year net **unchanged**.
- Tripling shards (base 22→65) → **unchanged**.
- Halving / changing storage GB → headline price **unchanged** (only the Sizing Brief's storage line moved).

**Root cause:** the business-case Oracle cost is a researched-or-`DEFAULT` lump sum. `adbTotal = adbPrimary + DRadd`
(`src/engine/tco.ts:9`) reads `tcoInputs.adbPrimary` / `coldDrAdd` / `warmDrAdd` — none derived from the
engine-computed ECPU or storage. The Sizing Brief computes an ECPU-derived cost line (`builders.ts:41`),
but the Business Case ignores it. This is the documented design (`SIZING-METHODOLOGY.md §2`), **not a
regression** from the editable-metrics branch — that branch *exposed* it by letting the rep adjust the sizing.

This violates the spirit of the determinism boundary (the engine should compute every authoritative number
from the rep's sizing × researched/list rates) and the no-silent-defaults invariant (the headline Oracle cost
is a default lump, not derived from the rep's inputs).

## Decision

Derive the **entire Oracle side** of the TCO (ADB primary + warm DR + cold DR) from the engine sizing ×
Oracle list rates. Research is reduced to the **on-prem build-up + one-time migration** — the figures that
genuinely need market research. The customer's *current* cost is researched; the *proposed* Oracle cost is
engine-computed. (User chose "Derive ADB primary + DR adds".)

## Cost Model (grounded in Oracle billing docs)

Let, from the same `consumedEcpu(inputs, 'workload')` the Sizing Brief uses (peak, avg):

```
computeAnnual(n) = baseFor(peak, avg, n) × ecpuPerHr × hoursPerMonth × 12     // n = provisioning divisor
storageAnnual    = dataCompressedGb × storagePerGbMo × 12
```

Three provisioning postures form each `Range` (low/central/high) — all real, defensible strategies, with
`central` = the conservative base (Peak÷2) the Sizing Brief already leads with:

| level | divisor n | meaning |
|-------|-----------|---------|
| low | `aggressiveDivisor` (3) | run lean, lean on autoscale |
| central | `conservativeDivisor` (2) | recommended provisioning |
| high | 1 | provision for peak, no autoscale reliance |

```
adbPrimary[level] = computeAnnual(n[level]) + storageAnnual
warmDrAdd[level]  = computeAnnual(n[level]) + warmStandbyStorageMult × storageAnnual   // ADG peer: base CPUs + 2× storage
coldDrAdd[level]  = coldBackupStorageMult × storageAnnual                              // cross-region backup: 2× storage, NO compute
```

**Grounding (Oracle docs):**
- Autonomous Data Guard cross-region standby is billed *"the additional cost of the base CPUs and twice the
  storage of the Primary database … auto-scaled CPUs of the Primary are not billed additionally on the peer."*
  → warm add = base compute + 2× storage. ([ADG cross-region billing](https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/adg-about-cross-region--cross-tenancy.html))
- Cross-region backup replication is billed *"for twice (2×) the … replicated backup storage size"*, no standby
  compute. → cold add = 2× storage. ([ADB Serverless billing](https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-features-billing.html))
- Compute/storage rates are the **existing** Oracle list rates already in config (`ecpuPerHr 0.0807`,
  `storagePerGbMo 0.1156`). **No new researched rate is introduced.**

Resulting totals (via the unchanged `adbTotal`): warm = 2×compute + 3×storage; cold = compute + 3×storage.
Every term is a function of the rep's sizing → adjusting vCPU/shards moves `computeAnnual`; adjusting storage
(or the compression toggle) moves `storageAnnual` in all three lines.

**Northwind sanity (45.8 TB on-disk, base 22 ECPU central):** adbPrimary ≈ $79k, adbCold ≈ $206k,
adbWarm ≈ $222k/yr (vs today's researched ≈ $214k fixture — same order, validates the model).

## New config knobs (documented + sourced — not silent defaults)

`ENGINE_CONFIG.adb` gains:
- `warmStandbyStorageMult = 2` — ADG peer storage multiple. Source: Oracle ADG cross-region billing.
- `coldBackupStorageMult = 2` — cross-region backup replication storage multiple. Source: ADB Serverless billing.
- (warm standby compute multiple is fixed at 1 = base CPUs per the doc; expressed in the formula, not a knob.)

## Architecture / Files

1. **`src/engine/adbCost.ts` (new)** — pure function:
   ```
   deriveOracleCost(inputs: SizingInputs, dataCompressedGb: number, rates: EcpuStorageRates,
                    cfg = ENGINE_CONFIG): { adbPrimary: Range; coldDrAdd: Range; warmDrAdd: Range }
   ```
   Uses `consumedEcpu(inputs,'workload')` + `baseFor` (engine/sizing.ts). Reuses `rates.ecpuPerHr`/
   `storagePerGbMo`/`hoursPerMonth`. Throws on non-positive storage (mirrors `effectiveCompressedGb`).
   Unit-tested in isolation.

2. **`src/render/builders.ts` `assembleDocModel`** — single substitution point. Before `buildTcoSection`:
   ```
   const oracle = deriveOracleCost(o.sizingInputs, o.dataCompressedGb, o.rates);
   const effTco = { ...o.tcoInputs, ...oracle };
   const tco = buildTcoSection(applyDiscount(effTco, discountPct), o.dataCompressedGb);
   ```
   `applyDiscount` continues to scale the (now engine-derived) Oracle ranges, so the customer discount still
   flows. `src/engine/tco.ts` is **unchanged** (still reads `inputs.adbPrimary` etc., which now hold derived values).

3. **`src/research/tco.ts`** — research no longer covers the Oracle side:
   - `CLOUD_COMPONENTS` → `['migrationPs']` only (drop `adbPrimary`/`coldDrAdd`/`warmDrAdd`).
   - `TCO_RESEARCH_SCHEMA`: remove the three Oracle ranges; require `onpremComponents`, `migrationPs`, `sources`.
   - `normalizeAndValidate`: stop parsing the three Oracle ranges; return a partial that fills only on-prem + migration.
   - `buildResearchPrompt`: ask only for the on-prem build-up + migration PS (topology line stays — it informs
     the on-prem sizing context).
   - `sourcesToClaims` / `COMPONENT_META`: drop the three Oracle claims (the ADB cost becomes a *synthesized*
     engine claim via `buildSizingClaims`, not a researched one).
   - `TcoResearchResult.inputs` now carries placeholder zeros for the Oracle ranges (overridden at assembly);
     documented inline. (Type `TcoInputs` is unchanged to bound blast radius.)

4. **`src/ui/pipeline.ts` `DEFAULT_TCO_INPUTS`** — Oracle ranges become `{low:0,central:0,high:0}` placeholders
   (clearly commented "engine-derived in assembleDocModel; overridden"). On-prem + migration keep their generic
   fallback values. `tcoProfileFromState` is unaffected (research still gets the topology for the on-prem context).

5. **Goldens** — recompute everywhere the Oracle cost appears, driven by the engine:
   - `src/render/fixtures/northwind-docmodel.ts`: derive the Oracle ranges via `deriveOracleCost(NORTHWIND_SIZING,
     DATA_COMPRESSED_GB, …)` instead of the hardcoded `NORTHWIND` TcoInputs Oracle fields; update the literal
     claim values (A2/A3/A4) and any cost prose to match.
   - `builders.test.ts`, `pipeline.test.ts`, `index.test.ts`, renderer snapshots: re-baseline to the derived numbers.
   - `research/tco.test.ts`: update for the reduced schema (no Oracle ranges).

6. **`docs/SIZING-METHODOLOGY.md`** — rewrite §2 (ADB annual cost is now engine-derived from provisioned ECPU +
   storage × list rates + the ADG/backup multiples), note research = on-prem + migration only, add the two new
   config rows to §7.

## Secondary bug fixes (found while tracing; folded in)

7. **Step-4 back-nav wipes adjustments** (`src/ui/steps/Step4Confirm.tsx`). `answers` is `useState({})` and is
   not re-seeded from `state.gateAnswers`; on remount (back-nav) it starts empty, triage re-runs (a second LLM
   classify cost), and a re-confirm snapshots `[]` → **prior adjustments silently wiped**. Fix: seed `answers`
   from `state.gateAnswers` on mount; skip the triage re-run when `state.triage` already exists (reuse it).

8. **Stale `tco` after an edit** (`src/ui/steps/Step5Generate.tsx`). Less critical now that the Oracle cost is
   engine-derived (the headline ADB no longer comes from `tco`), but research still feeds on-prem/migration. No
   action required for the Oracle side; verify generate uses the current sizing (it does, via `applied.inputs`).
   Keep a lightweight guard only if review finds a real stale-on-prem path.

## Invariants preserved

- **Determinism boundary** — the engine computes the Oracle cost from sizing × list rates; the LLM only
  researches on-prem + migration prose/figures. Strengthened, not weakened.
- **No silent defaults** — every cost factor is file/rep-derived (sizing) or a documented, sourced config rate.
- **Fail-closed anonymization** — untouched (no new LLM surface).
- **Northwind determinism** — goldens move once (a documented Oracle-cost-methodology update), recomputed by
  the engine so they cannot drift.

## Out of scope / follow-ups

- Letting research *refine* the Oracle ECPU/storage **rates** (kept as config list rates for now).
- Object-storage (archive) tier for cold backups (`storagePerGbMo` used for both for now).
- Sizing the warm standby smaller than primary (fixed at base CPUs per Oracle billing).

## Test strategy (TDD)

- `adbCost.test.ts`: formula correctness at each posture; storage/compute response; non-positive storage throws;
  warm = primary-compute + 2×storage; cold = 2×storage; discount scaling via assembleDocModel.
- A regression test asserting **an overridden sizing signal moves the business-case cost** (the gap that let
  this ship): override `node.hoVcpu`/`data.storageSizeGb` via a gate answer → `docModel.tco.adbWarmAnnual`
  /`savingWarm`/`fiveYear.net5Warm` change vs baseline.
- Step-4 back-nav: a test that re-mounting seeds `answers` from `state.gateAnswers` and a re-confirm preserves them.
- Re-baselined goldens.
