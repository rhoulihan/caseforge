# Editable Metrics, Narrative Tuning, and Storage Compression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents must READ the current file before editing — several files changed across recent releases.

**Goal:** Let the rep adjust *any* discovered metric (not just fill missing ones), with any rep fill/adjust dropping the estimate to **Directional** (Policy B); add a narrative-tuning prompt on the Generate step; and let the rep mark a storage estimate compressed/uncompressed (default uncompressed) with a tunable 3× Oracle compression factor converting uncompressed → effective on-disk.

**Architecture:** Three features over the Step-4/Step-5 wizard + the classify/engine seam. (A) The verdict keys off a new `repEntered` flag on coverage (set from the `rep-gate-answer` evidence source); engineering-grade requires no required signal is rep-entered. (B) Step 4 renders one editable metrics table (required + an Additional Metrics expander) replacing the read-only coverage table and the separate gate inputs. (C) A companion `data.storageCompressionState` signal + `effectiveCompressedGb()` (centralized in `toSizingInputs`) convert an uncompressed figure via `ENGINE_CONFIG.adb.compressionRatio = 3`. (D) Step 5 gets a prose textarea reusing Step 6's fail-closed `prepareRefineInstruction` path.

**Tech Stack:** TypeScript, Preact, Vitest. Commands: `pnpm exec vitest run <path>`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

**Spec:** `docs/superpowers/specs/2026-06-12-editable-metrics-and-narrative-tuning-design.md`

> **Refinement vs spec §4.7 (recorded):** the effective compressed size is computed **once** in `toSizingInputs`. The research path (`tcoProfileFromState`) already consumes `merged.dataCompressedGb` (which comes from `toSizingInputs`), so it gets the effective value for free — applying the factor again there would double-divide. Single source; do **not** also divide in `tcoProfileFromState`.

---

## File Structure

- `src/classify/sufficiency-types.ts` — `SignalCoverageItem` gains `repEntered: boolean`.
- `src/classify/sufficiency.ts` — `buildCoverage` sets `repEntered`; `computeVerdict` demotes on any rep-entered required signal.
- `src/orchestrate/gate.ts` — `GateAnswer` drops `confirmed`; `applyGateAnswers` binds rep entries uniformly; new `buildMetricsForm`; carry `storageBasis`.
- `src/ui/state.ts` — `GateAnswer` type.
- `src/ui/steps/Step4Confirm.tsx` — unified editable metrics table + `MetricRow` + Additional Metrics + revert + storage compression toggle.
- `src/engine/config.ts` — `adb.compressionRatio = 3`. `src/engine/config.test.ts` — pin it.
- `src/engine/storage.ts` (new) + `src/engine/storage.test.ts` (new) — `effectiveCompressedGb`.
- `src/classify/triage.ts` — `toSizingInputs` applies the factor + returns `storageBasis`.
- `src/render/types.ts` — `SizingSection` gains storage basis fields.
- `src/render/builders.ts` — thread the storage basis into `DocModel.sizing`; renderer shows the "uncompressed → effective" line.
- `src/profile/mongodb.ts` — relabel `data.storageSizeGb`; add `data.storageCompressionState`.
- `src/ui/steps/Step5Generate.tsx` (+ optional `src/ui/NarrativeTuner.tsx`) — narrative tuning.
- `docs/SIZING-METHODOLOGY.md` — tightened bar + compression.

---

## Phase A — Policy B verdict + gate-answer model

### Task A1: `repEntered` coverage flag + verdict demotion

**Files:** Modify `src/classify/sufficiency-types.ts`, `src/classify/sufficiency.ts`; Test `src/classify/sufficiency.test.ts`.

- [ ] **Step 1: Failing test** — in `sufficiency.test.ts`, add (the file has an `mk(signalId, value, confidence, method, source='src')` helper; pass `source='rep-gate-answer'`):

```ts
  it('(B) a rep-entered required signal (rep-gate-answer) is never engineering-grade', () => {
    const reps = allRequiredSatisfied().map((b) =>
      b.signalId === 'node.hoVcpu' ? mk('node.hoVcpu', 32, 1, 'manual', 'rep-gate-answer') : b,
    );
    const r = buildSufficiencyReport(triageOf([...reps, ...storageSatisfied()]), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('directional-estimate');
    expect(r.verdict.limitingSignals).toContain('node.hoVcpu');
  });
  it('(B2) all required source-read (no rep entry) stays engineering-grade', () => {
    const r = buildSufficiencyReport(triageOf([...allRequiredSatisfied(), ...storageSatisfied()]), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('engineering-grade');
  });
```

- [ ] **Step 2: Run — fails** (`manual` currently yields engineering-grade).

Run: `pnpm exec vitest run src/classify/sufficiency.test.ts -t "rep-entered"`
Expected: FAIL (tier is engineering-grade).

- [ ] **Step 3: Add `repEntered` to the coverage type** — `sufficiency-types.ts`, in `SignalCoverageItem` after `evidence`:

```ts
  repEntered: boolean; // value came from a rep gate answer (rep-gate-answer evidence) — demotes the tier
```

- [ ] **Step 4: Set it in `buildCoverage`** — `sufficiency.ts`, in the returned object (where `evidence: b?.evidence ?? []` is set), add:

```ts
    repEntered: !!b && b.evidence.some((e) => e.source === 'rep-gate-answer'),
```

- [ ] **Step 5: Demote in `computeVerdict`** — `sufficiency.ts`. Replace the `hasAssumed` computation and its use with a `repEntered` check:

```ts
  const repEntered = req.filter((c) => c.repEntered);
```
and in the tier decision change the engineering-grade clause from `&& !hasAssumed` to `&& repEntered.length === 0`. Add rep-entered signals to the rationale, e.g. after the existing rationale line:
```ts
  if (repEntered.length) rationale += ` Rep-entered/adjusted: ${repEntered.map((c) => labelOf(c.signalId)).join(', ')} → directional.`;
```
Ensure `limitingSignals` includes rep-entered signals when directional (extend the `limiting` set to also include `repEntered` ids).

- [ ] **Step 6: Run the new tests + the file**

Run: `pnpm exec vitest run src/classify/sufficiency.test.ts`
Expected: the two new tests PASS; fix any existing test that assumed a `manual` fill is engineering-grade (re-baseline to directional). Test (5) "manual rep-confirmed → engineering-grade" must flip to directional — update its expectation and rename.

- [ ] **Step 7: Commit**

```bash
git add src/classify/sufficiency-types.ts src/classify/sufficiency.ts src/classify/sufficiency.test.ts
git commit -m "feat(sufficiency): Policy B — a rep-entered required signal forces Directional"
```

### Task A2: gate answers bind uniformly as rep entries (drop `confirmed`)

**Files:** Modify `src/orchestrate/gate.ts`, `src/ui/state.ts`, `src/ui/steps/Step4Confirm.tsx` (minimal type fix); Test `src/orchestrate/gate.test.ts`.

- [ ] **Step 1: Failing test** — `gate.test.ts`: an override answer wins the merge and marks the signal rep-entered.

```ts
  it('a gate answer overrides a discovered binding and marks it rep-entered', () => {
    const tri = triageOf([mk('node.hoVcpu', 16, 0.9, 'vision')]); // discovered 16
    const applied = applyGateAnswers(tri, [{ signalId: 'node.hoVcpu', value: 32 }], [], MONGODB_PROFILE);
    const cov = applied.sufficiency.coverage.find((c) => c.signalId === 'node.hoVcpu')!;
    expect(cov.value).toBe(32);            // rep override won the merge
    expect(cov.repEntered).toBe(true);
  });
```
(Match the file's existing `mk`/`triageOf` helpers; if absent, build a minimal `TriageResult`.)

- [ ] **Step 2: Run — fails** (`GateAnswer` still requires `confirmed`; types/merge differ).

- [ ] **Step 3: `GateAnswer` drops `confirmed`** — `gate.ts`:

```ts
export interface GateAnswer {
  signalId: string;
  value: SignalValue; // a rep-entered value (a fill or an override); always demotes the tier (Policy B)
}
```

- [ ] **Step 4: Bind rep entries uniformly** — `gate.ts` `applyGateAnswers`, the `newBindings` map:

```ts
  const newBindings: BindingResult[] = answers.map((a) => ({
    signalId: a.signalId,
    value: a.value,
    confidence: 1,
    method: 'manual', // trust 7 → wins mergeBindings over any artifact-read value
    evidence: [{ source: 'rep-gate-answer', primitiveKind: 'keyvalue' }],
    note: 'rep-entered at the gate',
  }));
```

- [ ] **Step 5: `state.ts` `GateAnswer`** — mirror Step 3 (drop `confirmed`).

- [ ] **Step 6: Compile fix in `Step4Confirm.tsx`** — change `GateRow`'s `emit` to `onAnswer(v === null ? null : { signalId: item.signalId, value: v })` and delete the `isStorage`/`confirmed` special-case + its hint branch (the full UI is rebuilt in Phase B; this is the minimal compile fix).

- [ ] **Step 7: Run gate tests + the suite; re-baseline storage tests**

Run: `pnpm exec vitest run src/orchestrate/gate.test.ts src/classify/sufficiency.test.ts && pnpm typecheck`
Expected: PASS. The storage `confirmed:false` test in `Step4Confirm.test.tsx` and any `assumption-default` gate test re-baseline (gate entries are now uniformly rep-entered → directional). Update them.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrate/gate.ts src/ui/state.ts src/ui/steps/Step4Confirm.tsx src/orchestrate/gate.test.ts src/classify/sufficiency.test.ts src/ui/steps/Step4Confirm.test.tsx
git commit -m "feat(gate): every gate answer is a rep-entered override (drop confirmed flag)"
```

---

## Phase B — Unified editable metrics table

### Task B1: `buildMetricsForm`

**Files:** Modify `src/orchestrate/gate.ts`; Test `src/orchestrate/gate.test.ts`.

- [ ] **Step 1: Failing test**

```ts
  it('buildMetricsForm splits required vs additional (recommended), excludes optional', () => {
    const suff = buildSufficiencyReport(triageOf([]), [], MONGODB_PROFILE);
    const form = buildMetricsForm(suff, MONGODB_PROFILE);
    expect(form.required.map((r) => r.signalId)).toContain('cluster.shardCount');
    expect(form.required.map((r) => r.signalId)).toContain('data.storageSizeGb');
    expect(form.additional.every((r) => r.criticality === 'recommended')).toBe(true);
    expect(form.additional.map((r) => r.signalId)).not.toContain('data.collectionProfile'); // optional excluded
    // the compression-state companion is NOT a standalone row:
    expect([...form.required, ...form.additional].map((r) => r.signalId)).not.toContain('data.storageCompressionState');
  });
```

- [ ] **Step 2: Run — fails** (`buildMetricsForm` undefined).

- [ ] **Step 3: Implement** — `gate.ts`, add the type + function (and you may retire `buildGateData` once Step 4 stops using it; keep it until then to avoid breaking the current UI mid-phase):

```ts
export interface MetricRow {
  signalId: string;
  label: string;
  valueKind: SignalValueKind; // 'scalar' | 'avgPeak' | 'enum'
  criticality: Criticality;
  value: SignalValue | null;
  method: DerivationMethod | null;
  status: SignalCoverageItem['status'];
  effectiveConfidence: number;
  repEntered: boolean;
  collectRequest: string;
  collectWhy: string;
}
export interface MetricsForm { required: MetricRow[]; additional: MetricRow[] }

export function buildMetricsForm(sufficiency: SufficiencyReport, profile: SourceProfile): MetricsForm {
  const specById = new Map(profile.signalSchema.signals.map((s) => [s.id, s]));
  const row = (c: SignalCoverageItem): MetricRow => {
    const spec = specById.get(c.signalId)!;
    return { signalId: c.signalId, label: c.label, valueKind: spec.valueKind, criticality: c.criticality,
      value: c.value, method: c.method, status: c.status, effectiveConfidence: c.effectiveConfidence,
      repEntered: c.repEntered, collectRequest: spec.collectRequest, collectWhy: spec.collectWhy };
  };
  const COMPANION = 'data.storageCompressionState';
  const required = sufficiency.coverage.filter((c) => c.criticality === 'required').map(row);
  const additional = sufficiency.coverage
    .filter((c) => c.criticality === 'recommended' && c.signalId !== COMPANION)
    .map(row)
    .sort((a, b) => Number(!!specById.get(b.signalId)?.tcoCritical) - Number(!!specById.get(a.signalId)?.tcoCritical) || a.label.localeCompare(b.label));
  return { required, additional };
}
```
Add the needed imports (`SignalValueKind`, `Criticality` from `../profile/types`; `SignalCoverageItem`, `SufficiencyReport` from `../classify/sufficiency-types`).

- [ ] **Step 4: Run — passes.** `pnpm exec vitest run src/orchestrate/gate.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/orchestrate/gate.ts src/orchestrate/gate.test.ts
git commit -m "feat(gate): buildMetricsForm — required + additional editable rows"
```

### Task B2: Step 4 unified editable metrics table

**Files:** Modify `src/ui/steps/Step4Confirm.tsx`, `src/ui/styles.css`; Test `src/ui/steps/Step4Confirm.test.tsx`.

> This replaces the read-only coverage table AND the separate gate block with one editable table built from `buildMetricsForm(report, profile)`. The storage compression toggle (Phase C, Task C4) is added to the storage row later — leave a clear seam.

- [ ] **Step 1: Failing test** — adjusting a discovered metric demotes to Directional; revert restores; Additional Metrics is collapsible.

```tsx
  it('adjusting a discovered metric drops the verdict to Directional, and revert restores it', async () => {
    setup(full); // a bundle where all required signals are discovered from artifacts (engineering-grade)
    await screen.findByText('ENGINEERING-GRADE');
    const input = screen.getByTestId('metric-input-cluster.shardCount');
    fireEvent.input(input, { target: { value: '5' } });
    await screen.findByText('DIRECTIONAL ESTIMATE');
    fireEvent.input(input, { target: { value: '' } }); // revert
    await screen.findByText('ENGINEERING-GRADE');
  });
  it('shows an Additional Metrics section that is collapsible', async () => {
    setup(full);
    expect(await screen.findByText(/Additional Metrics/i)).toBeTruthy();
  });
```
(`setup`/`full` exist in the file. The verdict in the table must recompute live as answers change — see Step 3.)

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Rebuild the render body.** Replace the read-only coverage `<table>` and the `gate.items` block with:
  - Build the form: `const form = report ? buildMetricsForm(report, MONGODB_PROFILE) : null;` (import `buildMetricsForm`).
  - Recompute a **live verdict** as the rep edits: whenever `answers` change, run `applyGateAnswers(state.triage, Object.values(answers), state.anonBundle.files, MONGODB_PROFILE)` and use `applied.sufficiency.verdict` for the displayed tier badge (so adjusting a metric flips the badge immediately). Keep the initial `report` from triage for the row baseline.
  - Render `form.required` as `<MetricRow>` rows; render `form.additional` inside `<details class="cf-additional-metrics"><summary>Additional Metrics</summary>…</details>`.
  - `MetricRow` (generalize the current `GateRow`): shows label, the discovered value + provenance badge (or "missing"), an inline input by `valueKind` — scalar → one number (`data-testid={`metric-input-${signalId}`}`); `avgPeak` → avg/peak %; `enum` → `<select>`/text. The input is **pre-filled with the discovered value**. On input → `setAnswer(signalId, value)`; clearing → `setAnswer(signalId, null)` (revert). A row whose answer differs from the discovered value (or that's repEntered) shows an "adjusted" badge. Reuse the existing util avg/peak validation; reject scalar ≤ 0 / NaN.
  - `confirm()` unchanged: `applyGateAnswers` → block if a required signal is still missing; else `patch({ gateAnswers, confirmed: true })`.

- [ ] **Step 4: Styles** — add `.cf-additional-metrics` (a `<details>` with spacing) and a `.cf-adjusted` badge to `styles.css`. ASCII quotes only.

- [ ] **Step 5: Run the file + typecheck**

Run: `pnpm exec vitest run src/ui/steps/Step4Confirm.test.tsx && pnpm typecheck`
Expected: PASS (including the existing tests, re-baselined where a gate fill now yields Directional).

- [ ] **Step 6: Commit**

```bash
git add src/ui/steps/Step4Confirm.tsx src/ui/styles.css src/ui/steps/Step4Confirm.test.tsx
git commit -m "feat(ui): Step 4 unified editable metrics table + Additional Metrics + revert"
```

---

## Phase C — Compressed/uncompressed storage + 3× factor

### Task C1: `effectiveCompressedGb` + config constant

**Files:** Create `src/engine/storage.ts`, `src/engine/storage.test.ts`; Modify `src/engine/config.ts`, `src/engine/config.test.ts`.

- [ ] **Step 1: Failing test** — `src/engine/storage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { effectiveCompressedGb } from './storage';
import { ENGINE_CONFIG } from './config';

describe('effectiveCompressedGb', () => {
  it('returns the raw value when already compressed', () => {
    expect(effectiveCompressedGb(45_800, true)).toBe(45_800);
  });
  it('divides an uncompressed value by the 3x ratio', () => {
    expect(effectiveCompressedGb(45_000, false)).toBe(15_000);
    expect(effectiveCompressedGb(45_000, false, 3)).toBe(15_000);
  });
  it('rejects non-positive / NaN raw sizes', () => {
    expect(() => effectiveCompressedGb(0, false)).toThrow();
    expect(() => effectiveCompressedGb(Number.NaN, true)).toThrow();
  });
  it('defaults to the config ratio', () => {
    expect(ENGINE_CONFIG.adb.compressionRatio).toBe(3);
  });
});
```

- [ ] **Step 2: Run — fails** (module + constant missing).

- [ ] **Step 3: Add the constant** — `src/engine/config.ts`, in the `adb` object add `compressionRatio: 3,` and document it in the `AdbRates` interface + the SOURCES comment:

```ts
  /** Assumed Oracle on-disk compression of an UNCOMPRESSED storage estimate (effective = uncompressed /
   * ratio). 3x = conservative midpoint of Advanced Row Compression (2-4x) and OSON (~2.7-3x vs BSON).
   * Source: Oracle Advanced Compression FAQ; Oracle JSON-vs-MongoDB (OSON). */
  compressionRatio: number;
```

- [ ] **Step 4: Implement** — `src/engine/storage.ts`:

```ts
// On-disk storage estimate handling. A customer's "database size" is usually the LOGICAL/uncompressed
// figure; the ADB storage cost needs the COMPRESSED on-disk footprint Oracle would store. An uncompressed
// estimate is divided by the assumed Oracle compression ratio (ENGINE_CONFIG.adb.compressionRatio).
import { ENGINE_CONFIG } from './config';

/** Effective on-disk (compressed) GB for the ADB storage cost / DR RTO / research prompt. */
export function effectiveCompressedGb(rawGb: number, compressed: boolean, ratio: number = ENGINE_CONFIG.adb.compressionRatio): number {
  if (!(rawGb > 0)) throw new RangeError('effectiveCompressedGb: rawGb must be > 0');
  if (!(ratio > 0)) throw new RangeError('effectiveCompressedGb: ratio must be > 0');
  return compressed ? rawGb : rawGb / ratio;
}
```

- [ ] **Step 5: Pin the constant** — `src/engine/config.test.ts`: add `expect(ENGINE_CONFIG.adb.compressionRatio).toBe(3);` to the drift-guard assertions.

- [ ] **Step 6: Run — passes.** `pnpm exec vitest run src/engine/storage.test.ts src/engine/config.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/engine/storage.ts src/engine/storage.test.ts src/engine/config.ts src/engine/config.test.ts
git commit -m "feat(engine): effectiveCompressedGb + adb.compressionRatio=3 (Oracle compression)"
```

### Task C2: companion compression-state signal in the profile

**Files:** Modify `src/profile/mongodb.ts`; Test `src/profile/mongodb.test.ts`.

- [ ] **Step 1: Failing test** — `mongodb.test.ts`:

```ts
  it('has a storage compression-state companion signal (recommended, enum, with compressed aliases)', () => {
    const s = MONGODB_PROFILE.signalSchema.signals.find((x) => x.id === 'data.storageCompressionState')!;
    expect(s).toBeTruthy();
    expect(s.criticality).toBe('recommended');
    expect(s.valueKind).toBe('enum');
  });
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement** — `mongodb.ts`: relabel `data.storageSizeGb` to "Storage size estimate (on-disk)" and update its `collectWhy` to note it may be compressed or uncompressed. Add the companion to the `recommended` array:

```ts
  {
    id: 'data.storageCompressionState',
    label: 'Storage figure is compressed or uncompressed',
    valueKind: 'enum',
    criticality: 'recommended',
    defaultable: true,
    derivableBy: ['llm-text', 'keyvalue', 'vision'],
    aliases: ['compressed', 'on-disk', 'on disk', 'uncompressed', 'logical size'],
    collectRequest: 'Is the storage figure on-disk (compressed) or logical (uncompressed)?',
    collectWhy: 'Determines whether the Oracle compression factor is applied to the storage estimate.',
  },
```
(Discovery binding for `'compressed'` vs `'uncompressed'` is heuristic/llm-text; the rep can always toggle. Keep this signal out of the `required` set so it never blocks.)

- [ ] **Step 4: Run — passes.** `pnpm exec vitest run src/profile/mongodb.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/profile/mongodb.ts src/profile/mongodb.test.ts
git commit -m "feat(profile): companion data.storageCompressionState signal (default uncompressed)"
```

### Task C3: apply the factor in `toSizingInputs` + thread the basis to the DocModel

**Files:** Modify `src/classify/triage.ts`, `src/orchestrate/gate.ts`, `src/orchestrate/index.ts`, `src/render/builders.ts`, `src/render/types.ts`, fixtures; Tests as noted.

- [ ] **Step 1: Failing test** — `src/classify/triage.test.ts` (or where `toSizingInputs` is tested): an uncompressed storage figure yields effective = raw/3 and a basis; compressed → raw.

```ts
  it('toSizingInputs converts an uncompressed storage figure to effective on-disk via the 3x factor', () => {
    const bindings = [
      mk('cluster.shardCount', 3), mk('node.hoVcpu', 32), mk('node.drVcpu', 16),
      ap('util.primary', 0.18, 0.45), ap('util.hoSec', 0.12, 0.35), ap('util.dr', 0.08, 0.2),
      mk('data.storageSizeGb', 45_000),
      // no storageCompressionState bound → default uncompressed
    ];
    const out = toSizingInputs(bindings, MONGODB_PROFILE);
    expect(out.dataCompressedGb).toBe(15_000);         // 45000 / 3
    expect(out.storageBasis).toEqual({ rawGb: 45_000, compressed: false, ratio: 3 });
  });
```
(Adapt `mk`/`ap` to the test file's binding helpers.)

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: `toSizingInputs`** — `triage.ts`. Import `effectiveCompressedGb` and `ENGINE_CONFIG`. After the missing-guard, read the raw storage + state and compute the effective value + basis:

```ts
  const rawStorageGb = num('data.storageSizeGb');
  const compressed = (by.get('data.storageCompressionState')?.value) === 'compressed'; // default uncompressed
  const ratio = ENGINE_CONFIG.adb.compressionRatio;
  const dataCompressedGb = effectiveCompressedGb(rawStorageGb, compressed, ratio);
  // ... existing inputs object ...
  return { inputs, dataCompressedGb, storageBasis: { rawGb: rawStorageGb, compressed, ratio }, missing: [] };
```
Extend the return type to `{ inputs?; dataCompressedGb?; storageBasis?: { rawGb: number; compressed: boolean; ratio: number }; missing: string[] }`.

- [ ] **Step 4: Thread `storageBasis`** — `gate.ts` `ApplyResult` adds `storageBasis?: { rawGb: number; compressed: boolean; ratio: number }`; `applyGateAnswers` destructures and returns it on the success branch. `orchestrate/index.ts` passes `storageBasis: applied.storageBasis` into `assembleDocModel`. (`tcoProfileFromState` is UNCHANGED — it already reads `merged.dataCompressedGb`, which is now effective; do NOT divide again.)

- [ ] **Step 5: DocModel** — `render/types.ts` `SizingSection`: replace/augment `dataCompressedGb: number` with the basis:

```ts
  dataCompressedGb: number;            // effective on-disk (what the cost uses)
  storageRawGb: number;                // the figure the rep provided
  storageCompressed: boolean;          // was that figure already compressed?
  storageCompressionRatio: number;     // ratio assumed when uncompressed
```
`builders.ts` `AssembleOptions` gains `storageBasis: { rawGb; compressed; ratio }`; `assembleDocModel` sets `sizing.dataCompressedGb = o.dataCompressedGb` (unchanged, effective) and the three basis fields from `o.storageBasis`. The renderer (`render/sizingBrief.ts` / `prose.ts` line that prints data size) shows, when `!storageCompressed`, "X GB (uncompressed) → ~Y GB effective on Oracle (assumes Nx compression)". When compressed, show the figure plainly.

- [ ] **Step 6: Fixtures mark Northwind compressed** — in `src/render/fixtures/northwind-docmodel.ts` set `storageCompressed: true` (so effective stays 45,800; `storageRawGb: 45_800`, ratio 3); in `src/classify/northwind-classify.golden.test.ts` bind `data.storageCompressionState = 'compressed'` (so `toSizingInputs` returns `dataCompressedGb = 45_800`, unchanged). In `src/render/builders.test.ts`, pass `storageBasis: { rawGb: 45_800, compressed: true, ratio: 3 }` to `assembleDocModel`.

- [ ] **Step 7: Run targeted + full**

Run: `pnpm exec vitest run src/classify src/render src/orchestrate && pnpm typecheck`
Expected: PASS; the Northwind goldens are unchanged (compressed → no factor).

- [ ] **Step 8: Commit**

```bash
git add src/classify/triage.ts src/orchestrate/gate.ts src/orchestrate/index.ts src/render/types.ts src/render/builders.ts src/render/fixtures/northwind-docmodel.ts src/classify/northwind-classify.golden.test.ts src/render/builders.test.ts src/classify/triage.test.ts
git commit -m "feat(engine): apply Oracle compression factor to an uncompressed storage estimate"
```

### Task C4: storage compression toggle on the metrics row

**Files:** Modify `src/ui/steps/Step4Confirm.tsx`; Test `src/ui/steps/Step4Confirm.test.tsx`.

- [ ] **Step 1: Failing test**

```tsx
  it('the storage row has a compressed/uncompressed toggle that emits a compression-state answer', async () => {
    setup(full);
    await screen.findByText(/ENGINEERING-GRADE|DIRECTIONAL/);
    const toggle = screen.getByTestId('storage-compression-toggle');
    fireEvent.click(toggle); // flip to uncompressed (or compressed)
    const answers = JSON.parse(screen.getByTestId('answers').textContent!);
    expect(answers.some((a: { signalId: string }) => a.signalId === 'data.storageCompressionState')).toBe(true);
  });
```
(Extend the test `Readout` to expose `state.gateAnswers` if not already.)

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement** — in `Step4Confirm.tsx`, the `MetricRow` for `signalId === 'data.storageSizeGb'` renders, next to the value input, a compressed/uncompressed control (`data-testid="storage-compression-toggle"`) whose change emits `setAnswer('data.storageCompressionState', value === 'compressed' ? 'compressed' : 'uncompressed')`. Default reflects the discovered state (uncompressed unless the companion signal is bound compressed). The `data.storageCompressionState` signal is not a standalone row (already excluded in `buildMetricsForm`).

- [ ] **Step 4: Run — passes.** `pnpm exec vitest run src/ui/steps/Step4Confirm.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/ui/steps/Step4Confirm.tsx src/ui/steps/Step4Confirm.test.tsx
git commit -m "feat(ui): compressed/uncompressed toggle on the storage metric row"
```

---

## Phase D — Narrative tuning on Generate

### Task D1: narrative tuning prompt on Step 5

**Files:** Modify `src/ui/steps/Step5Generate.tsx` (optionally create `src/ui/NarrativeTuner.tsx`); Test `src/ui/steps/Step5Generate.test.tsx`.

- [ ] **Step 1: Failing test** — the Step-5 tuning prompt is threaded as `proseInstruction` (fail-closed) and a naming an unmapped person blocks.

```tsx
  it('threads the Step-5 narrative prompt through prepareRefineInstruction into the run', async () => {
    // Render Step5 with a generated-capable state + a stubbed launcher.anonymize + runPipeline.
    // Type a tuning note, click Generate, assert buildRunConfig received a proseInstruction (spy)
    // and that an unmapped name in the note blocks with the Step-3 pointer.
  });
```
(Model the test on the existing `Step5Generate.test.tsx` harness — match its mocks for `launcher`, `runPipeline`, and `getApiKey`.)

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement** — `Step5Generate.tsx`:
  - Add `const [tune, setTune] = useState('');` and a textarea (+ the Step-6 `CHIPS`) above the Generate button. (Optional: extract a `NarrativeTuner` component shared with Step 6.)
  - In `generate()`, ALWAYS prepare the instruction (not only add-files). Compose the carried add-files note (if any) and the Step-5 tuning note into one `prepareRefineInstruction` call (the tuning note is the "new" instruction). On `'blocked' in prepared` → set the same Step-3-pointer error and return. Pass `prepared.effective` as `proseInstruction`. On success, append a refinement-history entry with the tuning note (so it replays on later regenerates), mirroring the add-files logging.

- [ ] **Step 4: Run — passes + full suite + typecheck.**

Run: `pnpm exec vitest run src/ui/steps/Step5Generate.test.tsx && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/ui/steps/Step5Generate.tsx src/ui/steps/Step5Generate.test.tsx
git commit -m "feat(ui): narrative tuning prompt on Generate (fail-closed, logged, replayed)"
```

---

## Phase E — Docs + final verification

### Task E1: methodology docs

- [ ] **Step 1:** Update `docs/SIZING-METHODOLOGY.md` §5 — engineering-grade now requires every required signal read from an uploaded artifact, untouched; any rep fill/adjust → Directional. Add the storage compression state + the 3× factor (with its source) to §1/§7, and note the Step-5 narrative-tuning prompt.
- [ ] **Step 2: Commit** `git add docs/SIZING-METHODOLOGY.md && git commit -m "docs: tightened sufficiency bar + storage compression factor + Step-5 tuning"`

### Task E2: final verification

- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm lint` — clean.
- [ ] `pnpm test` — all pass; confirm the Northwind goldens are unchanged and the engineering-grade↔directional re-baselines are intentional.
- [ ] `pnpm build` — succeeds.
- [ ] Then use **superpowers:finishing-a-development-branch** to open the PR.

---

## Self-Review

**Spec coverage:** §4.1 verdict → A1; §4.2 gate answers → A2; §4.3 unified table → B1/B2; §4.4 storage special-case removal → A2 Step 6 / B2; §4.5 additional→cost (no new plumbing) → covered (merged bindings already feed research); §4.6 narrative tuning → D1; §4.7 compression → C1–C4 (with the single-source refinement noted). Docs → E1. ✅

**Placeholder scan:** The Step-5 test (D1 Step 1) and the B2 render rebuild are described structurally with the critical code (emit, verdict-recompute, prepare wiring) rather than full line-complete components — deliberate for large UI rewrites the subagent edits against current files; every *logic* step has exact code. No "TBD"/"add error handling"/empty test bodies in the logic tasks.

**Type consistency:** `repEntered: boolean` (sufficiency-types → buildCoverage → computeVerdict → MetricRow). `GateAnswer = { signalId, value }` (gate.ts + state.ts). `storageBasis = { rawGb, compressed, ratio }` (toSizingInputs → ApplyResult → orchestrate → AssembleOptions → DocModel.sizing fields `storageRawGb`/`storageCompressed`/`storageCompressionRatio`). `effectiveCompressedGb(rawGb, compressed, ratio?)` consistent across C1/C3. `ENGINE_CONFIG.adb.compressionRatio` consistent. ✅
