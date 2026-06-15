# Engine-Derived Oracle Cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the entire Oracle side of the TCO (ADB primary + warm DR + cold DR) from the engine sizing × Oracle list rates, so adjusting the Step-4 sizing moves the business-case cost; shrink research to on-prem + migration.

**Architecture:** A new pure engine function `deriveOracleCost(inputs, dataCompressedGb, rates)` returns the three Oracle `Range`s from the provisioned ECPU + storage. `assembleDocModel` substitutes them into `tcoInputs` once, before `buildTcoSection` — so every downstream figure (savings, 5-year, payback, charts, claims) follows the sizing. `engine/tco.ts` is unchanged (it still reads `inputs.adbPrimary` etc., which now hold derived values). Research drops the three Oracle fields. Goldens recompute from the engine.

**Tech Stack:** TypeScript, Preact, Vitest. Commands: `pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run <path>`, `pnpm test`.

**Spec:** `docs/superpowers/specs/2026-06-15-engine-derived-oracle-cost-design.md`

**Branch:** continue on `feat/editable-metrics-narrative-tuning` (open PR #34) so the editable-metrics feature ships coherent.

## Cost model (reference for all tasks)

```
computeAnnual(n)  = baseFor(peak, avg, n) × ecpuPerHr × hoursPerMonth × 12   // peak/avg from consumedEcpu(inputs,'workload')
dbStorageAnnual   = dataCompressedGb × storagePerGbMo × 12                    // ADB database storage rate
backupStoreAnnual = dataCompressedGb × backupStoragePerGbMo × 12             // object-storage rate (cold backups)

adbPrimary = { low: computeAnnual(3)+dbStorageAnnual, central: computeAnnual(2)+dbStorageAnnual, high: computeAnnual(1)+dbStorageAnnual }
warmDrAdd  = { low: computeAnnual(3)+2·dbStorageAnnual, central: computeAnnual(2)+2·dbStorageAnnual, high: computeAnnual(1)+2·dbStorageAnnual }
coldDrAdd  = { low: 2·backupStoreAnnual, central: 2·backupStoreAnnual, high: 2·backupStoreAnnual }   // posture-invariant
```
(`n` = 3 aggressive / 2 conservative / 1 peak; multiples & backup rate from `ENGINE_CONFIG.adb`.)

## File structure

- **Create** `src/engine/adbCost.ts` — `deriveOracleCost`. Single responsibility: sizing → Oracle cost ranges.
- **Create** `src/engine/adbCost.test.ts` — unit tests for the formulas.
- **Modify** `src/engine/config.ts` — add `backupStoragePerGbMo`, `warmStandbyStorageMult`, `coldBackupStorageMult` to `AdbRates` + `ENGINE_CONFIG.adb` + the SOURCES comment.
- **Modify** `src/render/builders.ts` — substitute derived Oracle ranges in `assembleDocModel`.
- **Modify** `src/render/fixtures/northwind-docmodel.ts` — drive the tco section + A2/A3/A4 claim literals from the derived ranges.
- **Modify** `src/research/tco.ts` — drop the three Oracle ranges from schema/prompt/validation/claims.
- **Modify** `src/ui/pipeline.ts` — `DEFAULT_TCO_INPUTS` Oracle fields → zero placeholders.
- **Modify** `src/ui/steps/Step4Confirm.tsx` — seed `answers` from `state.gateAnswers`; reuse cached triage.
- **Modify** `docs/SIZING-METHODOLOGY.md` — §2 + §7.
- **Re-baseline** `src/render/builders.test.ts`, `src/orchestrate/index.test.ts`, `src/ui/pipeline.test.ts` (or wherever pipeline goldens live), renderer snapshots, `src/research/tco.test.ts`.

---

### Task 1: Config knobs (object-storage backup rate + DR multiples)

**Files:**
- Modify: `src/engine/config.ts`

- [ ] **Step 1: Extend the `AdbRates` interface.** In `src/engine/config.ts`, add three fields after `compressionRatio` (keep the doc comments):

```typescript
  /** OCI Object Storage (Standard) list rate, USD per GB-month — used for cold-DR backup copies (cheaper
   * than database storage, which is why cold DR << warm). Source: OCI Object Storage pricing. */
  backupStoragePerGbMo: number;
  /** Autonomous Data Guard cross-region peer is billed the base CPUs + this multiple of the primary's
   * DATABASE storage. 2× per Oracle ADG cross-region billing. */
  warmStandbyStorageMult: number;
  /** Cold (backup-based) cross-region DR keeps this multiple of the data as object-storage backup copies.
   * 2× per Oracle ADB Serverless cross-region backup billing. */
  coldBackupStorageMult: number;
```

- [ ] **Step 2: Set the values** in `ENGINE_CONFIG.adb` (the object literal currently `{ ecpuPerHr: 0.0807, storagePerGbMo: 0.1156, hoursPerMonth: 730, compressionRatio: 3 }`):

```typescript
  adb: { ecpuPerHr: 0.0807, storagePerGbMo: 0.1156, hoursPerMonth: 730, compressionRatio: 3,
         backupStoragePerGbMo: 0.0255, warmStandbyStorageMult: 2, coldBackupStorageMult: 2 },
```

- [ ] **Step 3: Add SOURCES lines** in the `ENGINE_CONFIG` doc block (the `SOURCES:` list ~line 62):

```
 *  - adb.backupStoragePerGbMo = 0.0255 .... OCI Object Storage (Standard) list pricing (cold-DR backups).
 *  - adb.warmStandbyStorageMult = 2 ....... Oracle ADG cross-region: peer billed base CPUs + 2× DB storage.
 *  - adb.coldBackupStorageMult = 2 ........ Oracle ADB cross-region backup: 2× replicated backup storage.
```

- [ ] **Step 4: Verify it compiles.** Run: `pnpm typecheck`
Expected: PASS (no consumers of the new fields yet; existing config tests, if any, still pass since fields are additive — if a config snapshot test exists it will flag the three new keys; update it to include them).

- [ ] **Step 5: Run the engine config-related tests.** Run: `pnpm exec vitest run src/engine`
Expected: PASS (a drift-guard test that snapshots `ENGINE_CONFIG` keys will need the three new keys added — update it).

- [ ] **Step 6: Commit.**

```bash
git add src/engine/config.ts
git commit -m "feat(config): add object-storage backup rate + ADG/backup DR multiples

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `deriveOracleCost` engine function

**Files:**
- Create: `src/engine/adbCost.ts`
- Create: `src/engine/adbCost.test.ts`

- [ ] **Step 1: Write the failing test** in `src/engine/adbCost.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { deriveOracleCost } from './adbCost';
import { ENGINE_CONFIG } from './config';
import { NORTHWIND_SIZING } from './fixtures/northwind-sizing';
import type { SizingInputs } from './types';

const RATES = { ecpuPerHr: ENGINE_CONFIG.adb.ecpuPerHr, storagePerGbMo: ENGINE_CONFIG.adb.storagePerGbMo, hoursPerMonth: ENGINE_CONFIG.adb.hoursPerMonth };

describe('deriveOracleCost', () => {
  it('derives adbPrimary = base compute + db storage at each posture (central = Peak÷2)', () => {
    const r = deriveOracleCost(NORTHWIND_SIZING, 45_800, RATES);
    // base@2 = ceil(max(43.2/2, 17.28)) = 22; compute = 22*0.0807*730*12; storage = 45800*0.1156*12
    const compute2 = 22 * RATES.ecpuPerHr * RATES.hoursPerMonth * 12;
    const dbStore = 45_800 * RATES.storagePerGbMo * 12;
    expect(r.adbPrimary.central).toBe(Math.round(compute2 + dbStore));
    expect(r.adbPrimary.low).toBeLessThan(r.adbPrimary.central);   // aggressive (Peak÷3) cheaper
    expect(r.adbPrimary.high).toBeGreaterThan(r.adbPrimary.central); // peak-provisioned dearer
  });

  it('warm add = base compute + 2× db storage; cold add = 2× object-storage backup, posture-invariant', () => {
    const r = deriveOracleCost(NORTHWIND_SIZING, 45_800, RATES);
    const compute2 = 22 * RATES.ecpuPerHr * RATES.hoursPerMonth * 12;
    const dbStore = 45_800 * RATES.storagePerGbMo * 12;
    const backup = 45_800 * ENGINE_CONFIG.adb.backupStoragePerGbMo * 12;
    expect(r.warmDrAdd.central).toBe(Math.round(compute2 + 2 * dbStore));
    expect(r.coldDrAdd.central).toBe(Math.round(2 * backup));
    expect(r.coldDrAdd.low).toBe(r.coldDrAdd.central); // storage-only → posture-invariant
    expect(r.coldDrAdd.high).toBe(r.coldDrAdd.central);
    expect(r.coldDrAdd.central).toBeLessThan(r.warmDrAdd.central); // cold cheaper than warm
  });

  it('responds to sizing: more storage raises every line; more vCPU raises compute-bearing lines', () => {
    const base = deriveOracleCost(NORTHWIND_SIZING, 45_800, RATES);
    const moreStorage = deriveOracleCost(NORTHWIND_SIZING, 91_600, RATES);
    expect(moreStorage.adbPrimary.central).toBeGreaterThan(base.adbPrimary.central);
    expect(moreStorage.coldDrAdd.central).toBeGreaterThan(base.coldDrAdd.central);
    const biggerNodes: SizingInputs = { ...NORTHWIND_SIZING, hoVcpu: 64 };
    const moreCpu = deriveOracleCost(biggerNodes, 45_800, RATES);
    expect(moreCpu.adbPrimary.central).toBeGreaterThan(base.adbPrimary.central);
    expect(moreCpu.coldDrAdd.central).toBe(base.coldDrAdd.central); // cold has no compute term
  });

  it('throws on non-positive storage (mirrors effectiveCompressedGb)', () => {
    expect(() => deriveOracleCost(NORTHWIND_SIZING, 0, RATES)).toThrow(RangeError);
    expect(() => deriveOracleCost(NORTHWIND_SIZING, -5, RATES)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `pnpm exec vitest run src/engine/adbCost.test.ts`
Expected: FAIL — `deriveOracleCost` not found / module missing.

- [ ] **Step 3: Implement** `src/engine/adbCost.ts`:

```typescript
// Derive the Oracle (proposed) side of the TCO from the engine sizing × Oracle list rates — the
// single place the ADB primary + warm/cold DR costs are computed. Keeps the determinism boundary: the
// engine computes the quantity (provisioned ECPU + storage GB); the rates are Oracle list pricing.
// Replaces the former researched/DEFAULT lump sums so adjusting the sizing moves the business case.

import type { SizingInputs, Range } from './types';
import type { EngineConfig } from './config';
import { ENGINE_CONFIG } from './config';
import { consumedEcpu, baseFor } from './sizing';

export interface OracleRates {
  ecpuPerHr: number;
  storagePerGbMo: number;
  hoursPerMonth?: number;
}

export interface OracleCost {
  adbPrimary: Range;
  coldDrAdd: Range;
  warmDrAdd: Range;
}

/** Provisioned ADB primary + DR add-on annual costs (USD/yr) derived from the workload sizing.
 *  low/central/high = aggressive (Peak÷3) / conservative (Peak÷2) / peak-provisioned (Peak÷1). */
export function deriveOracleCost(
  inputs: SizingInputs,
  dataCompressedGb: number,
  rates: OracleRates,
  cfg: EngineConfig = ENGINE_CONFIG,
): OracleCost {
  if (!Number.isFinite(dataCompressedGb) || dataCompressedGb <= 0) {
    throw new RangeError(`dataCompressedGb must be a positive number (got ${dataCompressedGb})`);
  }
  const hrs = rates.hoursPerMonth ?? cfg.adb.hoursPerMonth;
  const { peak, avg } = consumedEcpu(inputs, 'workload');
  const computeAnnual = (n: number): number => baseFor(peak, avg, n) * rates.ecpuPerHr * hrs * 12;
  const dbStorageAnnual = dataCompressedGb * rates.storagePerGbMo * 12;
  const backupStoreAnnual = dataCompressedGb * cfg.adb.backupStoragePerGbMo * 12;
  // Postures: aggressive (÷3) cheaper, conservative (÷2) recommended/central, peak (÷1) dearest.
  const { aggressiveDivisor: lo, conservativeDivisor: mid } = cfg.sizing;
  const primary = (n: number): number => Math.round(computeAnnual(n) + dbStorageAnnual);
  const warm = (n: number): number => Math.round(computeAnnual(n) + cfg.adb.warmStandbyStorageMult * dbStorageAnnual);
  const cold = Math.round(cfg.adb.coldBackupStorageMult * backupStoreAnnual); // storage-only → posture-invariant
  return {
    adbPrimary: { low: primary(lo), central: primary(mid), high: primary(1) },
    warmDrAdd: { low: warm(lo), central: warm(mid), high: warm(1) },
    coldDrAdd: { low: cold, central: cold, high: cold },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes.** Run: `pnpm exec vitest run src/engine/adbCost.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + lint.** Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/engine/adbCost.ts src/engine/adbCost.test.ts
git commit -m "feat(engine): deriveOracleCost — ADB primary + DR from sizing × list rates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire derived cost into `assembleDocModel` + the missing-regression test + goldens

**Files:**
- Modify: `src/render/builders.ts`
- Modify: `src/render/fixtures/northwind-docmodel.ts`
- Re-baseline: `src/render/builders.test.ts`, `src/orchestrate/index.test.ts`, pipeline golden test, renderer snapshots

- [ ] **Step 1: Write the regression test** (the gap that let this ship) in `src/render/builders.test.ts` — add to the existing `describe`:

```typescript
import { applyGateAnswers } from '../orchestrate/gate';
// ... within the test file:
it('an overridden sizing signal moves the business-case cost (engine-derived Oracle cost)', () => {
  const baseTriage = { profileId: 'mongodb', inventory: [], bindings: [
    { signalId: 'cluster.shardCount', value: 3, confidence: 1, method: 'keyvalue' as const, evidence: [] },
    { signalId: 'node.hoVcpu', value: 32, confidence: 1, method: 'keyvalue' as const, evidence: [] },
    { signalId: 'node.drVcpu', value: 16, confidence: 1, method: 'keyvalue' as const, evidence: [] },
    { signalId: 'util.primary', value: { avgPct: 0.18, peakPct: 0.45 }, confidence: 1, method: 'numeric-series' as const, evidence: [] },
    { signalId: 'util.hoSec', value: { avgPct: 0.12, peakPct: 0.35 }, confidence: 1, method: 'numeric-series' as const, evidence: [] },
    { signalId: 'util.dr', value: { avgPct: 0.08, peakPct: 0.2 }, confidence: 1, method: 'numeric-series' as const, evidence: [] },
    { signalId: 'data.storageSizeGb', value: 45_800, confidence: 1, method: 'keyvalue' as const, evidence: [] },
    { signalId: 'data.storageCompressionState', value: 'compressed', confidence: 1, method: 'keyvalue' as const, evidence: [] },
  ] };
  const assemble = (answers: Parameters<typeof applyGateAnswers>[1]) => {
    const a = applyGateAnswers(baseTriage, answers, [], MONGODB_PROFILE);
    return assembleDocModel({ /* same opts the existing builders.test uses */ ...BASE_OPTS,
      sizingInputs: a.inputs!, dataCompressedGb: a.dataCompressedGb!, storageBasis: a.storageBasis!, sufficiency: a.sufficiency });
  };
  const base = assemble([]);
  const doubled = assemble([{ signalId: 'node.hoVcpu', value: 64 }]);
  expect(doubled.tco.adbWarmAnnual.central).toBeGreaterThan(base.tco.adbWarmAnnual.central);
  expect(doubled.tco.fiveYear.net5Warm).not.toBe(base.tco.fiveYear.net5Warm);
  const moreStorage = assemble([{ signalId: 'data.storageSizeGb', value: 91_600 }]);
  expect(moreStorage.tco.adbColdAnnual.central).toBeGreaterThan(base.tco.adbColdAnnual.central);
});
```
(The implementer adapts `BASE_OPTS`/`MONGODB_PROFILE` import to whatever the existing `builders.test.ts` already sets up for `assembleDocModel`; reuse its existing rates/tcoInputs/prose constants.)

- [ ] **Step 2: Run it — confirm it FAILS** against the current (decoupled) code. Run: `pnpm exec vitest run src/render/builders.test.ts -t "moves the business-case cost"`
Expected: FAIL — `doubled.tco.adbWarmAnnual.central` equals base (cost ignores sizing today).

- [ ] **Step 3: Implement the substitution** in `src/render/builders.ts` `assembleDocModel`. Add the import and replace the `tco` line:

```typescript
import { deriveOracleCost } from '../engine/adbCost';
// ...
export function assembleDocModel(o: AssembleOptions): DocModel {
  const discountPct = o.discountPct ?? 0;
  // The proposed Oracle cost is ENGINE-DERIVED from the sizing × list rates (not researched) — so the
  // business case tracks any sizing adjustment. Research now supplies only on-prem + migration.
  const oracle = deriveOracleCost(o.sizingInputs, o.dataCompressedGb, o.rates);
  const effTco = { ...o.tcoInputs, adbPrimary: oracle.adbPrimary, coldDrAdd: oracle.coldDrAdd, warmDrAdd: oracle.warmDrAdd };
  const tco = buildTcoSection(applyDiscount(effTco, discountPct), o.dataCompressedGb);
  // ...rest unchanged (listAdbAnnual should also use effTco):
  const listAdbAnnual = discountPct > 0 ? { warm: adbTotal(effTco, 'warm', 'central'), cold: adbTotal(effTco, 'cold', 'central') } : undefined;
  // ...
}
```
(Ensure the later `listAdbAnnual` and any other `o.tcoInputs` reads in this function use `effTco` for the Oracle ranges.)

- [ ] **Step 4: Run the regression test — now PASSES.** Run: `pnpm exec vitest run src/render/builders.test.ts -t "moves the business-case cost"`
Expected: PASS.

- [ ] **Step 5: Update the Northwind fixture** `src/render/fixtures/northwind-docmodel.ts` so its tco section + claim literals use the derived Oracle ranges (matching what `assembleDocModel` now produces). At the top, after `DATA_COMPRESSED_GB`:

```typescript
import { deriveOracleCost } from '../../engine/adbCost';
const ORACLE = deriveOracleCost(NORTHWIND_SIZING, DATA_COMPRESSED_GB, { ecpuPerHr: ECPU_PER_HR, storagePerGbMo: STORAGE_PER_GB_MO, hoursPerMonth: HRS_PER_MO });
const NORTHWIND_EFF = { ...NORTHWIND, adbPrimary: ORACLE.adbPrimary, coldDrAdd: ORACLE.coldDrAdd, warmDrAdd: ORACLE.warmDrAdd };
```
Then replace every `fiveYear(NORTHWIND, …)`, `adbTotal(NORTHWIND,…)`, `net5(NORTHWIND,…)`, `annualSaving(NORTHWIND,…)`, `paybackYear(NORTHWIND,…)`, `onpremTotal(NORTHWIND,…)` call to use `NORTHWIND_EFF`. (on-prem is unchanged between the two, but use `NORTHWIND_EFF` uniformly.) Update the hardcoded claim literal values that quote Oracle cost — `A2` ('Oracle ADB + warm DR cost'), `A3` ('Lower annual cost' %), `A4` ('Five-year net saving') — to the recomputed numbers (see Step 6 to obtain them).

- [ ] **Step 6: Regenerate the goldens.** Run the renderer/builders/pipeline suites; for each failing golden, read the printed actual value, sanity-check it against the spec's Northwind table (adbPrimary ≈ $79k, cold total ≈ $107k, warm total ≈ $222k), and update the expected literal:

```bash
pnpm exec vitest run src/render
pnpm exec vitest run src/orchestrate
```
Update snapshots intentionally where the change is purely the Oracle cost:
```bash
pnpm exec vitest run src/render -u   # only after verifying the diffs are the expected cost deltas
```
Expected after updates: PASS. (Do NOT blanket `-u` without reading the diffs — confirm each changed number is an Oracle-cost figure, not an accidental sizing/structure change.)

- [ ] **Step 7: Full suite + typecheck + lint.** Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS (some pre-existing tests outside the cost path unaffected). If `index.test.ts` / pipeline goldens reference Oracle cost numbers, re-baseline them the same way.

- [ ] **Step 8: Commit.**

```bash
git add src/render/builders.ts src/render/fixtures/northwind-docmodel.ts src/render/builders.test.ts src/render/**/__snapshots__ src/orchestrate
git commit -m "feat(render): business-case Oracle cost derived from sizing; recompute goldens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Shrink research to on-prem + migration

**Files:**
- Modify: `src/research/tco.ts`
- Modify: `src/ui/pipeline.ts` (`DEFAULT_TCO_INPUTS`)
- Re-baseline: `src/research/tco.test.ts`

- [ ] **Step 1: Update the research tests first** in `src/research/tco.test.ts` to encode the reduced contract:
  - The schema/`normalizeAndValidate` should accept a payload WITHOUT `adbPrimary`/`coldDrAdd`/`warmDrAdd` and still validate.
  - `sourcesToClaims` should NOT emit `research:adbPrimary` / `research:coldDrAdd` / `research:warmDrAdd`.
  - Add: a payload that omits the three Oracle ranges validates and returns `inputs.migrationPs` + `inputs.onpremComponents` populated.
  - Keep/adjust any test that fed the three Oracle ranges so it no longer requires them.

```typescript
it('validates a payload without the (now engine-derived) Oracle ranges', () => {
  const { inputs } = normalizeAndValidate({ onpremComponents: ONPREM_FIXTURE, migrationPs: { low: 75000, central: 150000, high: 300000 }, sources: [{ component: 'migrationPs', source: 'x', url: 'https://x', asOfDate: '2026-01-01', sourceQuality: 'published' }] });
  expect(inputs.migrationPs.central).toBe(150000);
  expect(inputs.onpremComponents.license).toBeDefined();
});
it('sourcesToClaims omits the engine-derived Oracle components', () => {
  const claims = sourcesToClaims(SAMPLE_RESULT);
  expect(claims.map((c) => c.id)).not.toContain('research:adbPrimary');
  expect(claims.map((c) => c.id)).not.toContain('research:warmDrAdd');
});
```

- [ ] **Step 2: Run — confirm failures.** Run: `pnpm exec vitest run src/research/tco.test.ts`
Expected: FAIL (schema still requires the three ranges; claims still include them).

- [ ] **Step 3: Edit `src/research/tco.ts`:**
  - `CLOUD_COMPONENTS = ['migrationPs'] as const;` (drop the three Oracle components).
  - `TCO_RESEARCH_SCHEMA.schema.required = ['onpremComponents', 'migrationPs', 'sources']`; remove `adbPrimary`/`coldDrAdd`/`warmDrAdd` from `properties`.
  - `normalizeAndValidate`: build `inputs` with `adbPrimary/coldDrAdd/warmDrAdd` set to a zero `Range` (`{ low: 0, central: 0, high: 0 }`) placeholder — clearly commented "engine-derived in assembleDocModel; not researched" — and parse only `migrationPs` + `onpremComponents`.
  - `buildResearchPrompt`: replace the ADB/DR bullet with on-prem + migration only. Keep the topology line (it informs the on-prem context). New bullet text:
    `'- adbPrimary, warm/cold DR are NOT researched — Oracle cost is computed from the sizing. Research only the on-premises build-up + one-time migration services.'`
    and keep `'- onpremComponents: license, hardware, storage, facility, labor, backup (annual USD/yr).'` and `'- migrationPs (one-time USD).'`
  - `COMPONENT_META`: remove the `adbPrimary`/`coldDrAdd`/`warmDrAdd` entries.
  - `sourcesToClaims`: iterate `ALL_COMPONENTS` (now = onprem + migrationPs) — the three Oracle claims drop out automatically once they're removed from `CLOUD_COMPONENTS`/`COMPONENT_META`. `centralOf` loses its `adbPrimary`/`coldDrAdd`/`warmDrAdd` cases (or keep them harmless; they won't be reached).

- [ ] **Step 4: Update `DEFAULT_TCO_INPUTS`** in `src/ui/pipeline.ts` — Oracle fields become zero placeholders (overridden at assembly), keep on-prem + migration:

```typescript
export const DEFAULT_TCO_INPUTS: TcoInputs = {
  onpremComponents: { /* unchanged generic fallback */ },
  // Oracle cost is ENGINE-DERIVED from the sizing in assembleDocModel — these are inert placeholders.
  adbPrimary: { low: 0, central: 0, high: 0 },
  coldDrAdd: { low: 0, central: 0, high: 0 },
  warmDrAdd: { low: 0, central: 0, high: 0 },
  migrationPs: { low: 75_000, central: 150_000, high: 300_000 },
};
```

- [ ] **Step 5: Run research + pipeline tests.** Run: `pnpm exec vitest run src/research src/ui/pipeline.test.ts`
Expected: PASS (research no longer requires/Claims the Oracle ranges; pipeline goldens already use derived cost from Task 3).

- [ ] **Step 6: Full suite + typecheck + lint.** Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/research/tco.ts src/research/tco.test.ts src/ui/pipeline.ts
git commit -m "feat(research): research on-prem + migration only; Oracle cost is engine-derived

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Fix the Step-4 back-nav wipe (re-seed answers, reuse cached triage)

**Files:**
- Modify: `src/ui/steps/Step4Confirm.tsx`
- Test: `src/ui/steps/Step4Confirm.test.tsx` (existing)

- [ ] **Step 1: Write the failing test** in `src/ui/steps/Step4Confirm.test.tsx`:

```typescript
it('re-seeds prior adjustments on remount and a re-confirm preserves them (no wipe on back-nav)', async () => {
  // Mount with a triage already in state AND a prior gate answer (rep adjusted hoVcpu earlier, then navigated away).
  const state = makeStateWithTriage({ gateAnswers: [{ signalId: 'node.hoVcpu', value: 64 }], confirmed: true });
  const { getByText, getByTestId } = renderStep4(state);
  // The prior adjustment should be reflected (input prefilled to 64, verdict directional) without re-running triage.
  await waitFor(() => expect(getByTestId('metric-input-node.hoVcpu')).toHaveProperty('value', '64'));
  // Re-confirm without touching anything: gateAnswers must still contain the hoVcpu override.
  getByText(/Confirm/).click();
  expect(lastPatch().gateAnswers).toEqual([{ signalId: 'node.hoVcpu', value: 64 }]);
});
```
(Adapt to the existing test harness helpers in `Step4Confirm.test.tsx`; if none seed a pre-existing triage, add a small helper that sets `state.triage` + `state.gateAnswers` and stubs the triage call so it is NOT invoked when `state.triage` exists.)

- [ ] **Step 2: Run — confirm it FAILS** (today `answers` starts empty, input shows discovered value not 64, re-confirm patches `[]`). Run: `pnpm exec vitest run src/ui/steps/Step4Confirm.test.tsx -t "back-nav"`
Expected: FAIL.

- [ ] **Step 3: Fix `Step4Confirm.tsx`:**
  - Seed `answers` from `state.gateAnswers` on mount instead of `{}`:
    ```typescript
    const [answers, setAnswers] = useState<Record<string, GateAnswer>>(
      () => Object.fromEntries((state.gateAnswers ?? []).map((a) => [a.signalId, a])),
    );
    ```
  - In the triage `useEffect`, REUSE the cached triage when present — don't re-run the LLM classify on a back-nav:
    ```typescript
    useEffect(() => {
      const bundle = state.anonBundle; const cfg = state.config;
      if (!bundle || !cfg) return;
      if (state.triage) { setReport(buildSufficiencyReport(state.triage, bundle.files, MONGODB_PROFILE)); return; }
      // ...existing triage(...) path unchanged...
    }, [state.anonBundle, state.config, state.triage, getApiKey, patch, capture]);
    ```
  - The `MetricRowView` prefill reads `row.value` (the discovered baseline). To show the rep's prior override, pass the seeded answer's value as the initial input. Add to the row render: `initialAnswer={answers[r.signalId]?.value ?? null}` and in `MetricRowView`, initialize `val`/`avg`/`peak` from `initialAnswer ?? discovered` (so a seeded override displays). Keep revert semantics against `discovered`.

- [ ] **Step 4: Run the test — PASSES.** Run: `pnpm exec vitest run src/ui/steps/Step4Confirm.test.tsx`
Expected: PASS (existing Step-4 tests still green — the empty-`state.gateAnswers` default keeps the fresh-mount behavior identical).

- [ ] **Step 5: Typecheck + lint + curly-quote sweep.** Run: `pnpm typecheck && pnpm lint && grep -rnP "[\x{201C}\x{201D}\x{2018}\x{2019}]" src/ui/steps/Step4Confirm.tsx || echo "clean"`
Expected: PASS + "clean".

- [ ] **Step 6: Commit.**

```bash
git add src/ui/steps/Step4Confirm.tsx src/ui/steps/Step4Confirm.test.tsx
git commit -m "fix(step4): re-seed edits from gateAnswers on back-nav; reuse cached triage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Methodology doc

**Files:**
- Modify: `docs/SIZING-METHODOLOGY.md`

- [ ] **Step 1: Rewrite §2 (ADB annual cost).** Replace the `adb = adbPrimary + DRadd` block to state the Oracle cost is engine-derived:

```
**ADB annual cost** is now ENGINE-DERIVED from the provisioned sizing × Oracle list rates (not researched):

  adbPrimary  = base ECPU × ecpuPerHr × 730 × 12  +  on-disk GB × storagePerGbMo × 12
  + warm DR   = a cross-region Data Guard standby: base CPUs + 2× database storage
  + cold DR   = cross-region backup copies in object storage (2× data × object-storage rate), no standby compute

base ECPU = the provisioned base for the posture (low = Peak÷3, central = Peak÷2, high = Peak÷1). Research now
supplies only the on-premises build-up + one-time migration; the proposed Oracle cost follows the sizing.
```

- [ ] **Step 2: Add the §7 config rows** for `backupStoragePerGbMo` (0.0255, OCI Object Storage), `warmStandbyStorageMult` (2), `coldBackupStorageMult` (2), each with its source.

- [ ] **Step 3: Curly-quote sweep + commit.** Run: `grep -rnP "[\x{201C}\x{201D}\x{2018}\x{2019}]" docs/SIZING-METHODOLOGY.md || echo clean`

```bash
git add docs/SIZING-METHODOLOGY.md
git commit -m "docs: methodology §2/§7 — engine-derived Oracle cost + new config rates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:** Cost model → Tasks 1-2; assembly substitution → Task 3; research reduction → Task 4; back-nav bug → Task 5; methodology → Task 6; regression test (sizing moves cost) → Task 3 Step 1; new config rates → Task 1; goldens → Task 3/4. Stale-`tco` (spec §8 secondary): the Oracle cost no longer comes from `tco`, so the headline is no longer stale-able; the on-prem path is researched and unchanged — no separate task, verified by review (note in Task 4).

**Type consistency:** `deriveOracleCost(inputs, dataCompressedGb, rates, cfg?)` → `{ adbPrimary, coldDrAdd, warmDrAdd }: Range` used identically in Task 2 (def), Task 3 (assembleDocModel + fixture). `OracleRates` is structurally a subset of `EcpuStorageRates` (`ecpuPerHr`, `storagePerGbMo`, `hoursPerMonth?`) so `o.rates` passes directly. Config field names (`backupStoragePerGbMo`, `warmStandbyStorageMult`, `coldBackupStorageMult`) match across Tasks 1, 2, 6.

**Placeholder scan:** none — every code step shows the code; golden values are regenerated by command (not hand-faked) with a sanity range from the spec table.
