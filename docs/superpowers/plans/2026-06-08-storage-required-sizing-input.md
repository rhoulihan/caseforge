# Storage as a Required, Gated Sizing Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make on-disk compressed storage (`data.storageSizeGb`) a *required* sizing signal so the cost/DR/research paths can never use a silent hardcoded default — every value derives from the rep's files or their gate entry.

**Architecture:** Promote storage to `required` (so the §8.5 gate demands it and sufficiency blocks without it); thread the post-gate storage GB as a dedicated sibling field (NOT inside `SizingInputs`, keeping `consumedEcpu` pure and `NORTHWIND_SIZING` untouched) from `toSizingInputs` → `applyGateAnswers` → the orchestrator → the builders; delete the `?? 1000` and the cost-research-prompt fabrications; route a gate-entered storage figure through the `assumption-default` path so it flags **Directional**, while file-derived storage stays engineering-grade.

**Tech Stack:** TypeScript, Preact, Vitest. Commands: `pnpm exec vitest run <path>` (single file), `pnpm test` (full + coverage), `pnpm lint`, `pnpm typecheck`, `pnpm build`.

> **Design note / deviation from spec §4.1:** The spec offered "`dataCompressedGb` inside `SizingInputs`" as primary and a "sibling field" as the alternative. During planning, the in-`SizingInputs` option proved to couple the ECPU fixture (`NORTHWIND_SIZING`) and every `toEqual(NORTHWIND_SIZING)` assertion to a storage value. This plan uses the **sibling-field** variant (an internal type-placement detail the user deferred on) to keep the engine's ECPU type pure and the fixtures decoupled.

---

## File Structure

**Production (modified):**
- `src/profile/mongodb.ts` — `data.storageSizeGb` becomes `required` (`defaultable: true`, `tcoCritical: true`).
- `src/classify/triage.ts` — `toSizingInputs` returns `dataCompressedGb` alongside `inputs`.
- `src/orchestrate/gate.ts` — `ApplyResult` carries `dataCompressedGb`.
- `src/orchestrate/index.ts` — thread `applied.dataCompressedGb` into `assembleDocModel`; guard on it.
- `src/render/builders.ts` — drop `dataCompressedGb` from `EcpuStorageRates`; take it as a dedicated arg on `scenario`/`buildSizingScenarios`/`buildTcoSection`/`AssembleOptions`.
- `src/ui/pipeline.ts` — `buildRunConfig` rates become rate-only; `tcoProfileFromState` reads post-gate merged bindings; delete `?? 1000`/`?? 1`/`?? 8`/`?? 0`/hardcoded `'warm'`; remove `dataGbFromTriage`.
- `src/research/tco.ts` — `TcoProfile.drPosture` optional; posture-neutral prompt + validation when unbound.
- `src/ui/steps/Step4Confirm.tsx` — storage gate entry emits `confirmed: false` (flagged assumption).

**Tests / fixtures (modified):**
- `src/render/fixtures/northwind-docmodel.ts`, `src/classify/sufficiency.test.ts`, `src/classify/northwind-classify.golden.test.ts`, `src/render/builders.test.ts`, `src/ui/pipeline.test.ts`, `src/ui/steps/Step4Confirm.test.tsx`. New assertions added inline per task.

**Docs:** `docs/SIZING-METHODOLOGY.md`.

**Unchanged (verified):** `src/engine/types.ts`, `src/engine/fixtures/northwind-sizing.ts`, `src/engine/northwind-sizing.golden.test.ts`, `src/render/northwind.golden.test.ts` (none assert storage in `SizingInputs` or the required-signal count).

---

## Task 1: Promote storage to a required signal (+ sync fixtures)

**Files:**
- Modify: `src/profile/mongodb.ts` (the `data.storageSizeGb` SignalSpec, currently in the `recommended` array)
- Test: `src/classify/sufficiency.test.ts`
- Modify: `src/render/fixtures/northwind-docmodel.ts`, `src/classify/northwind-classify.golden.test.ts`, `src/ui/steps/Step4Confirm.test.tsx`

- [ ] **Step 1: Write the failing test** — storage missing must block, in `src/classify/sufficiency.test.ts`. Add after test `(2)`:

```ts
  it('(2b) all six topology/util required satisfied but storage missing -> blocked', () => {
    const r = buildSufficiencyReport(triageOf(allRequiredSatisfied()), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('blocked');
    expect(r.verdict.limitingSignals).toContain('data.storageSizeGb');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/classify/sufficiency.test.ts -t "storage missing"`
Expected: FAIL — currently storage is `recommended`, so the tier is `engineering-grade`, not `blocked`.

- [ ] **Step 3: Make storage required** in `src/profile/mongodb.ts`. Cut the `data.storageSizeGb` block out of the `recommended` array and add it to the END of the `required` array (after `util.dr`), with `criticality: 'required'`:

```ts
  {
    id: 'data.storageSizeGb',
    label: 'On-disk (compressed) storage size',
    unit: 'GB',
    valueKind: 'scalar',
    criticality: 'required',
    defaultable: true,
    tcoCritical: true,
    derivableBy: ['keyvalue', 'table-lookup', 'numeric-series', 'vision'],
    aliases: ['storage size', 'storagesize', 'disk usage', 'compressed data size'],
    // No engineSlot: it doesn't feed the ECPU compute — it feeds the ADB storage cost line, the cold-DR
    // RTO, and the cost-research prompt. It is required because it drives the dominant TCO figure; a
    // missing value must block (or be a flagged rep assumption), never a silent default.
    collectRequest: 'On-disk storage size after WiredTiger compression (`db.stats().storageSize`, or disk-usage metric).',
    collectWhy: 'The ADB storage line + migration volume — the dominant cost driver; sizing cannot be costed without it.',
  },
```

Leave `data.logicalSizeGb` in `recommended` (corroborator).

- [ ] **Step 4: Run the new test to verify it passes**

Run: `pnpm exec vitest run src/classify/sufficiency.test.ts -t "storage missing"`
Expected: PASS.

- [ ] **Step 5: Run the full suite to surface the fixture cascade**

Run: `pnpm test`
Expected: FAILS in `sufficiency.test.ts (1)`, `northwind-classify.golden.test.ts` (test 3), `Step4Confirm.test.tsx` (test 1), and `northwind-docmodel`-derived counts. Fix each in Steps 6–9.

- [ ] **Step 6: Fix `sufficiency.test.ts` REQUIRED list.** It now includes storage. Update line 16:

```ts
const REQUIRED = ['cluster.shardCount', 'node.hoVcpu', 'node.drVcpu', 'util.primary', 'util.hoSec', 'util.dr', 'data.storageSizeGb'];
```

Test `(1)` builds `whatToCollect` blocking asks for ALL required-missing signals; with storage required+missing it is a `blocking` ask, so the sorted set now matches the 7-element `REQUIRED`. No other change needed there.

- [ ] **Step 7: Fix the Northwind classify golden** `src/classify/northwind-classify.golden.test.ts`. Test 3 (the image-only `.msg` case) has no storage. Add a storage scalar panel to the image mock's `panels` array (after the shards panel, ~line 112):

```ts
                { kind: 'scalar', panelLabel: 'On-disk storage size (GB)', signalId: 'data.storageSizeGb', numericValue: 45800, strValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
```

(Tests 1 & 2 already bind storage via the `topology` keyvalue `'storage size': '300'`, so they stay green.)

- [ ] **Step 8: Fix `Step4Confirm.test.tsx`.** The shared `topology` keyvalue (line 10) lacks storage, so test 1's `full` bundle would now be BLOCKED. Add a storage pair:

```ts
const topology: KeyValuePrimitive = { kind: 'keyvalue', source: 'topology.txt', pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16', 'storage size': '45800' } };
```

(Test 2's `topologyOnly` is still BLOCKED on the missing util signals — unchanged assertion.)

- [ ] **Step 9: Fix the Northwind DocModel fixture** `src/render/fixtures/northwind-docmodel.ts`. Change the storage coverage row (line 91) from `'recommended'` to `'required'`:

```ts
    cov('data.storageSizeGb', 'On-disk storage size', 'required', 'keyvalue', 1),
```

Update the hand-authored `verdict` block (lines 96–103) counts for 7 required signals:

```ts
  verdict: {
    tier: 'engineering-grade',
    headline: 'Engineering-grade — all required signals satisfied',
    requiredTotal: 7,
    requiredSatisfied: 7,
    requiredPartial: 0,
    requiredMissing: 0,
    meanRequiredConfidence: 0.98,
    limitingSignals: [],
    rationale: '7/7 required signals satisfied from native telemetry + confirmed topology.',
  },
```

- [ ] **Step 10: Run the full suite to confirm green**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/profile/mongodb.ts src/classify/sufficiency.test.ts src/classify/northwind-classify.golden.test.ts src/ui/steps/Step4Confirm.test.tsx src/render/fixtures/northwind-docmodel.ts
git commit -m "fix(profile): make on-disk storage a required signal (no silent default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Thread the post-gate storage value through builders (out of `EcpuStorageRates`)

**Files:**
- Modify: `src/classify/triage.ts:167-186` (`toSizingInputs`)
- Modify: `src/orchestrate/gate.ts:37-43,66-96` (`ApplyResult`, `applyGateAnswers`)
- Modify: `src/render/builders.ts:28-33,37-64,78-106,176-236`
- Modify: `src/orchestrate/index.ts:122-126,141-154`
- Modify: `src/ui/pipeline.ts:70-96` (`buildRunConfig` rates)
- Test: `src/render/builders.test.ts`, `src/ui/pipeline.test.ts`, `src/orchestrate/index.test.ts`

- [ ] **Step 1: Write the failing regression test** in `src/orchestrate/index.test.ts` (add a new `describe`; reuse the file's existing imports/helpers — open it to match its `runPipeline` config-builder helper). The intent: storage drives a real ADB storage cost, and there is no hardcoded fallback.

```ts
  it('storage size threads from the gate into the ADB storage cost line (no hardcoded default)', async () => {
    // Build a config whose triage binds data.storageSizeGb = 2000 (see the file's existing helpers).
    const out = await runPipeline(configWithStorageGb(2000));
    expect(out.docModel).toBeDefined();
    expect(out.docModel!.sizing.dataCompressedGb).toBe(2000);
    // round(2000 * 0.1156) = 231 / month
    expect(out.docModel!.sizing.scenarios[0]!.monthlyStorageCost).toBe(231);
  });
```

> If `index.test.ts` has no helper that yields a `docModel` (it may only exercise the blocked/gate paths), instead add this assertion to `src/render/builders.test.ts` Step 3 below and skip this step — note that inline and move on.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/orchestrate/index.test.ts -t "storage size threads"`
Expected: FAIL to compile/run — `assembleDocModel` still reads storage from `rates`, and the test’s rate object no longer carries it.

- [ ] **Step 3: `toSizingInputs` returns `dataCompressedGb`** — `src/classify/triage.ts`. Change the signature and the success return (the missing-guard already covers storage now that it's required):

```ts
export function toSizingInputs(
  bindings: BindingResult[],
  profile: SourceProfile,
): { inputs?: SizingInputs; dataCompressedGb?: number; missing: string[] } {
  const by = new Map(bindings.map((b) => [b.signalId, b]));
  const required = profile.signalSchema.signals.filter((s) => s.criticality === 'required');
  const missing = required.filter((s) => by.get(s.id)?.value === undefined).map((s) => s.id);
  if (missing.length > 0) return { missing };

  const num = (id: string): number => by.get(id)!.value as number;
  const ap = (id: string): RoleUtil => by.get(id)!.value as RoleUtil;
  const inputs: SizingInputs = {
    shards: num('cluster.shardCount'),
    hoVcpu: num('node.hoVcpu'),
    drVcpu: num('node.drVcpu'),
    util: { primary: ap('util.primary'), hoSec: ap('util.hoSec'), dr: ap('util.dr') },
  };
  return { inputs, dataCompressedGb: num('data.storageSizeGb'), missing: [] };
}
```

- [ ] **Step 4: `ApplyResult` carries `dataCompressedGb`** — `src/orchestrate/gate.ts`. Add to the interface (after `inputs?`):

```ts
export interface ApplyResult {
  triage: TriageResult;
  sufficiency: SufficiencyReport;
  inputs?: SizingInputs;
  dataCompressedGb?: number;
  blocked: boolean;
  reasons: string[];
}
```

And the success branch of `applyGateAnswers` (replace lines 91–95):

```ts
  const { inputs, dataCompressedGb, missing } = toSizingInputs(merged, profile);
  if (missing.length > 0) {
    return { triage: newTriage, sufficiency, blocked: true, reasons: missing.map((id) => `${id} still missing`) };
  }
  return { triage: newTriage, sufficiency, inputs, dataCompressedGb, blocked: false, reasons: [] };
```

- [ ] **Step 5: Builders take storage as a dedicated arg** — `src/render/builders.ts`.

(a) `EcpuStorageRates` becomes rate-only (remove `dataCompressedGb`):

```ts
export interface EcpuStorageRates {
  ecpuPerHr: number;
  storagePerGbMo: number;
  hoursPerMonth?: number;
}
```

(b) `scenario` takes `dataCompressedGb` (replace its signature + the storage line):

```ts
function scenario(posture: 'conservative' | 'aggressive', n: number, inputs: SizingInputs, rates: EcpuStorageRates, dataCompressedGb: number): SizingScenario {
  const c = consumedEcpu(inputs, 'workload');
  const base = baseFor(c.peak, c.avg, n);
  const { x2, x3 } = ceilings(base);
  const hrs = rates.hoursPerMonth ?? DEFAULT_HRS_PER_MO;
  const monthlyEcpuCost = Math.round(base * rates.ecpuPerHr * hrs);
  const monthlyStorageCost = Math.round(dataCompressedGb * rates.storagePerGbMo);
```

(c) `buildSizingScenarios` (replace signature + both `scenario(...)` calls):

```ts
export function buildSizingScenarios(inputs: SizingInputs, rates: EcpuStorageRates, dataCompressedGb: number): SizingScenario[] {
  return [
    scenario('conservative', ENGINE_CONFIG.sizing.conservativeDivisor, inputs, rates, dataCompressedGb),
    scenario('aggressive', ENGINE_CONFIG.sizing.aggressiveDivisor, inputs, rates, dataCompressedGb),
  ];
}
```

(d) `buildTcoSection` takes `dataCompressedGb` instead of `rates` (it only used `rates.dataCompressedGb`):

```ts
export function buildTcoSection(tcoInputs: TcoInputs, dataCompressedGb: number): TcoSection {
  const fyWarm = fiveYear(tcoInputs, 'warm', 'central');
  const fyCold = fiveYear(tcoInputs, 'cold', 'central');
  const labels: Record<string, string> = {};
  for (const k of Object.keys(tcoInputs.onpremComponents)) labels[k] = ONPREM_LABELS[k] ?? k;
  const coldRto = coldRtoHours(dataCompressedGb / 1000);
```

(e) `AssembleOptions` — add `dataCompressedGb` (keep `rates`, now rate-only):

```ts
  rates: EcpuStorageRates;
  dataCompressedGb: number;
  tcoInputs: TcoInputs;
```

(f) `assembleDocModel` — update the two builder calls and the `sizing` field (replace lines 197, 213, and the `sizing:` line ~229):

```ts
  const tco = buildTcoSection(applyDiscount(o.tcoInputs, discountPct), o.dataCompressedGb);
```
```ts
  const scenarios = buildSizingScenarios(o.sizingInputs, scenarioRates, o.dataCompressedGb);
```
```ts
    sizing: { basis, consumed, scenarios, dataCompressedGb: o.dataCompressedGb },
```

- [ ] **Step 6: Orchestrator threads `applied.dataCompressedGb`** — `src/orchestrate/index.ts`. Tighten the gate guard (line 122) and the `assembleDocModel` call (line 141):

```ts
  if (applied.blocked || !applied.inputs || applied.dataCompressedGb === undefined) {
```
```ts
  const numericModel = assembleDocModel({
    companyName: config.companyName,
    targetPlatform: config.targetPlatform,
    preparedDate: config.preparedDate,
    documentStatus: 'preliminary',
    sizingInputs: applied.inputs,
    assumptions: config.assumptions,
    rates: config.rates,
    dataCompressedGb: applied.dataCompressedGb,
    tcoInputs: config.tcoInputs,
    discountPct: config.discountPct,
    sufficiency: applied.sufficiency,
    prose: PLACEHOLDER_PROSE,
    claims: config.claims,
  });
```

- [ ] **Step 7: `buildRunConfig` rates become rate-only** — `src/ui/pipeline.ts:75`. Storage now flows from the gate inside `runPipeline`:

```ts
  const rates: EcpuStorageRates = { ...ADB_RATES };
```

(Leave `dataGbFromTriage` and `tcoProfileFromState` for Task 3.)

- [ ] **Step 8: Update `builders.test.ts`** — `src/render/builders.ts` consumers. Replace the rates constant (line 13) and split out the storage value:

```ts
const rates = { ecpuPerHr: ENGINE_CONFIG.adb.ecpuPerHr, storagePerGbMo: ENGINE_CONFIG.adb.storagePerGbMo };
const DATA_GB = 45_800;
```

Then: `buildSizingScenarios(NORTHWIND_SIZING, rates)` → `buildSizingScenarios(NORTHWIND_SIZING, rates, DATA_GB)` (line 16); every `buildTcoSection(NORTHWIND, rates)` → `buildTcoSection(NORTHWIND, DATA_GB)` (lines 36, 58, 110); and add `dataCompressedGb: DATA_GB,` to every `assembleDocModel({ ... rates, ... })` options object (the `opts` at line 59, and the inline options at lines 137, 163, 182). All asserted numbers are unchanged because `DATA_GB` is still 45 800.

- [ ] **Step 9: Update `pipeline.test.ts`** — remove the now-invalid rates assertion. Delete line 52 (`expect(cfg.rates.dataCompressedGb).toBe(2000);`) and add in its place:

```ts
    expect((cfg.rates as Record<string, unknown>).dataCompressedGb).toBeUndefined(); // storage threads from the gate, not the rates
```

- [ ] **Step 10: Run the targeted suites, then full**

Run: `pnpm exec vitest run src/render/builders.test.ts src/orchestrate/index.test.ts src/ui/pipeline.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/classify/triage.ts src/orchestrate/gate.ts src/render/builders.ts src/orchestrate/index.ts src/ui/pipeline.ts src/render/builders.test.ts src/ui/pipeline.test.ts src/orchestrate/index.test.ts
git commit -m "feat(engine): thread post-gate storage size into cost/DR via the type system

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Clean up the cost-research prompt fabrications

**Files:**
- Modify: `src/ui/pipeline.ts:38-58` (`numericBinding`, `dataGbFromTriage`, `tcoProfileFromState`)
- Modify: `src/research/tco.ts:21-29,63-78,240-252`
- Test: `src/ui/pipeline.test.ts`, `src/research/tco.test.ts`

- [ ] **Step 1: Write the failing test** — `tcoProfileFromState` must use post-gate bindings and carry no fabricated topology. In `src/ui/pipeline.test.ts`, replace the `tcoProfileFromState` describe (lines 38–43). First extend the shared `triage` fixture (lines 9–17) so it is a complete, gate-satisfiable set:

```ts
const triage = {
  profileId: 'mongodb',
  inventory: [],
  bindings: [
    { signalId: 'cluster.shardCount', value: 3, method: 'keyvalue', confidence: 1, evidence: [] },
    { signalId: 'node.hoVcpu', value: 32, method: 'keyvalue', confidence: 1, evidence: [] },
    { signalId: 'node.drVcpu', value: 16, method: 'keyvalue', confidence: 1, evidence: [] },
    { signalId: 'util.primary', value: { avgPct: 0.18, peakPct: 0.45 }, method: 'numeric-series', confidence: 0.95, evidence: [] },
    { signalId: 'util.hoSec', value: { avgPct: 0.12, peakPct: 0.35 }, method: 'numeric-series', confidence: 0.95, evidence: [] },
    { signalId: 'util.dr', value: { avgPct: 0.08, peakPct: 0.2 }, method: 'numeric-series', confidence: 0.95, evidence: [] },
    { signalId: 'data.storageSizeGb', value: 2000, method: 'numeric-series', confidence: 1, evidence: [] },
  ],
} as unknown as TriageResult;
```

```ts
describe('tcoProfileFromState', () => {
  it('builds a TcoProfile from the post-gate bound signals (no fabricated topology)', () => {
    const p = tcoProfileFromState(stateWith());
    expect(p).toMatchObject({ dbType: 'mongodb', shards: 3, hoVcpu: 32, drVcpu: 16, dataCompressedGb: 2000 });
    expect(p.drPosture).toBeUndefined(); // dr.posture not bound -> omitted, not fabricated 'warm'
  });
});
```

Also delete the `dataGbFromTriage` describe block (lines 31–36) and remove `dataGbFromTriage` from the import on line 2.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/ui/pipeline.test.ts -t "tcoProfileFromState"`
Expected: FAIL — current `tcoProfileFromState` returns `drPosture: 'warm'` and (with no `node.drVcpu` previously) leaned on `?? 0`.

- [ ] **Step 3: Rewrite `tcoProfileFromState` + remove `dataGbFromTriage`** — `src/ui/pipeline.ts`. Replace lines 38–58 with a post-gate reader. Add the import for `applyGateAnswers`:

```ts
import { applyGateAnswers } from '../orchestrate/gate';
```

```ts
function numericBinding(triage: TriageResult | null, signalId: string): number | undefined {
  const b = triage?.bindings.find((x) => x.signalId === signalId);
  return b && typeof b.value === 'number' ? b.value : undefined;
}

function enumBinding(triage: TriageResult | null, signalId: string): string | undefined {
  const b = triage?.bindings.find((x) => x.signalId === signalId);
  return b && typeof b.value === 'string' ? b.value : undefined;
}

/** A TcoProfile for researchTcoCosts, built from the POST-GATE merged bindings (rep gate answers
 *  included). Every topology/storage value is rep/file-derived — there is NO fabricated fallback. */
export function tcoProfileFromState(state: WizardState): TcoProfile {
  if (!state.triage || !state.anonBundle) throw new Error('cost research needs a classified bundle');
  const merged = applyGateAnswers(state.triage, state.gateAnswers, state.anonBundle.files, MONGODB_PROFILE);
  if (!merged.inputs || merged.dataCompressedGb === undefined) {
    throw new Error('cost research needs the gate satisfied (topology + storage)');
  }
  const tri = merged.triage;
  const posture = enumBinding(tri, 'dr.posture');
  return {
    dbType: 'mongodb',
    shards: merged.inputs.shards,
    hoVcpu: merged.inputs.hoVcpu,
    drVcpu: merged.inputs.drVcpu,
    dataCompressedGb: merged.dataCompressedGb,
    ...(posture === 'none' || posture === 'cold' || posture === 'warm' ? { drPosture: posture } : {}),
  };
}
```

(`dataGbFromTriage` is deleted. `applyGateAnswers` needs `state.anonBundle.files` and `MONGODB_PROFILE`, both already imported in this file.)

- [ ] **Step 4: Make `drPosture` optional in research** — `src/research/tco.ts`. In `TcoProfile` (line 28) change to `drPosture?: DrPostureInput;`. In `validateTcoProfile` (lines 77) guard the check:

```ts
  if (p.drPosture !== undefined && !DR_POSTURES.includes(p.drPosture)) throw new TcoResearchValidationError(`invalid drPosture: ${String(p.drPosture)}`);
```

In `buildResearchPrompt` (line 244) make the posture clause conditional:

```ts
    `Workload topology: ${profile.shards} shard(s), ${profile.hoVcpu} primary vCPU, ${profile.drVcpu} DR vCPU, ${profile.dataCompressedGb} GB compressed data${profile.drPosture ? `, DR posture "${profile.drPosture}"` : ', evaluate both warm-standby and cold (backup-based) DR'}.`,
```

- [ ] **Step 5: Update `research/tco.test.ts`** — open it; any `TcoProfile` literal that relies on `drPosture: 'warm'` still works (it's allowed), but add one case proving omission is valid:

```ts
  it('accepts a profile with no drPosture (prompt asks for both postures)', () => {
    expect(() => validateTcoProfile({ dbType: 'mongodb', shards: 3, hoVcpu: 32, drVcpu: 16, dataCompressedGb: 2000 })).not.toThrow();
  });
```

(Adjust the import of `validateTcoProfile` if not already imported.)

- [ ] **Step 6: Run targeted, then full**

Run: `pnpm exec vitest run src/ui/pipeline.test.ts src/research/tco.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/pipeline.ts src/research/tco.ts src/ui/pipeline.test.ts src/research/tco.test.ts
git commit -m "fix(research): source the cost-research profile from post-gate bindings, drop fabricated defaults

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Gate UI — a typed storage figure is a flagged assumption

**Files:**
- Modify: `src/ui/steps/Step4Confirm.tsx:20-61` (`GateRow`)
- Test: `src/ui/steps/Step4Confirm.test.tsx`

- [ ] **Step 1: Write the failing test** — in `src/ui/steps/Step4Confirm.test.tsx`. Add a bundle whose storage is missing (so it becomes a gate row), enter it, and assert the recorded answer is unconfirmed. First extend `Readout` to expose gate answers:

```tsx
function Readout() {
  const { state } = useWizard();
  return (
    <>
      <span data-testid="confirmed">{String(state.confirmed)}</span>
      <span data-testid="answers">{JSON.stringify(state.gateAnswers)}</span>
    </>
  );
}
```

Add a bundle constant (note: `topology` now includes storage; build a storage-less variant) and the test:

```tsx
const noStorageTopology: KeyValuePrimitive = { kind: 'keyvalue', source: 'topology.txt', pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16' } };
const utilNoStorage: EvidenceBundle = { primitives: [noStorageTopology, utilTable], files };
```

```tsx
  it('records a typed storage figure as a flagged assumption (confirmed:false), then proceeds', async () => {
    setup(utilNoStorage);
    await screen.findByText('BLOCKED'); // storage missing -> blocked until entered
    const storageInput = await screen.findByLabelText(/On-disk .*storage size.* value/i);
    fireEvent.input(storageInput, { target: { value: '45800' } });
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    const answers = JSON.parse(screen.getByTestId('answers').textContent!);
    const storage = answers.find((a: { signalId: string }) => a.signalId === 'data.storageSizeGb');
    expect(storage).toMatchObject({ value: 45800, confirmed: false }); // a typed storage figure is an assumption
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/ui/steps/Step4Confirm.test.tsx -t "flagged assumption"`
Expected: FAIL — `GateRow` currently emits `confirmed: true` for every signal.

- [ ] **Step 3: Route the storage entry through the assumption path** — `src/ui/steps/Step4Confirm.tsx`. Add a constant and make `emit`’s `confirmed` storage-aware (replace lines 26–28):

```tsx
  // On-disk storage is the one signal we treat as a flagged ASSUMPTION when typed at the gate (not a
  // measurement): a value not read from an uploaded artifact must demote the case to a directional
  // estimate, never engineering-grade. File-derived storage is bound upstream and never reaches here.
  const isStorage = item.signalId === 'data.storageSizeGb';
  const emit = (v: SignalValue | null): void =>
    onAnswer(v === null ? null : { signalId: item.signalId, value: v, confirmed: !isStorage });
```

And make the hint accurate for storage (replace the `cf-hint` span at line 57):

```tsx
        <span class="cf-hint">{isStorage ? 'Enter your best on-disk size — it will be flagged as an estimate (directional).' : 'Enter the measured value to confirm it.'}</span>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/ui/steps/Step4Confirm.test.tsx`
Expected: PASS (all three tests).

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/steps/Step4Confirm.tsx src/ui/steps/Step4Confirm.test.tsx
git commit -m "feat(ui): a gate-typed storage figure is a flagged assumption (directional, not engineering-grade)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Documentation

**Files:**
- Modify: `docs/SIZING-METHODOLOGY.md` (§5 Confidence & sufficiency, §6 Data sources)

- [ ] **Step 1: Update §5** — add a sentence that storage is now a required signal whose absence blocks, and that a rep-typed storage figure is a flagged assumption (directional). In the "Engineering-grade" bullet area, note: *"On-disk compressed storage (`data.storageSizeGb`) is a required signal: the cost case is blocked until it is provided, and a value typed at the gate (rather than read from an artifact) is recorded as a flagged assumption — directional, never engineering-grade."*

- [ ] **Step 2: Update §6** — under "Customer workload telemetry", change the parenthetical to include storage as required: *"topology (shards, vCPU per node, DR cores), utilization (average / peak / P95), and on-disk compressed data size"*. Remove any implication that storage is optional/recommended.

- [ ] **Step 3: Commit**

```bash
git add docs/SIZING-METHODOLOGY.md
git commit -m "docs: storage is now a required signal; gate-typed storage is a flagged assumption

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Final verification

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 3: Full test + coverage**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 5: Prove the silent default is gone**

Run: `grep -rnE "1000|\?\? *[0-9]|dataGbFromTriage" src/ui/pipeline.ts`
Expected: no `?? 1000`, no `?? 1/8/0`, no `dataGbFromTriage` — the only remaining literals (if any) are unrelated. Confirm `git grep -n "fallback = 1000"` returns nothing.

- [ ] **Step 6: Open a PR**

```bash
git push -u origin fix/storage-required-sizing-input
gh pr create --title "fix: make storage a required sizing input (remove the silent 1000 GB default)" --body "$(cat <<'EOF'
## Summary
On-disk compressed storage (`data.storageSizeGb`) is now a **required** signal. The silent 1000 GB fallback that fed the ADB storage cost line, the cold-DR RTO, and the cost-research prompt is removed; the value is threaded post-gate through the type system so cost math cannot run without it. A storage figure typed at the gate is a flagged assumption (directional); file-derived storage stays engineering-grade. The cost-research prompt's fabricated topology defaults (`?? 1/8/0`, hardcoded `'warm'`) are also removed.

Spec: `docs/superpowers/specs/2026-06-08-storage-required-sizing-input-design.md`
Plan: `docs/superpowers/plans/2026-06-08-storage-required-sizing-input.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:** §1 problem → removed in Tasks 2/3 (no `?? 1000`, no research fabrications) + Task 6 Step 5 proof. §2 decisions → storage canonical=`storageSizeGb` (Task 1), required+defaultable:true (Task 1), gate-typed=flagged assumption (Task 4), fix-all-defaults (Task 3). §4.1 type change → Task 2 (sibling variant, deviation noted in header). §4.2 data flow → Tasks 1–3. §4.3 gate/sufficiency → Tasks 1 & 4. §4.4 research cleanup → Task 3. §5 file list → covered. §6 risks → Task 1 fixture sync + Task 4 grading test + Task 6 proof. §7 out-of-scope → untouched. ✅

**Placeholder scan:** Step 1 of Task 2 carries an explicit fallback instruction ("if `index.test.ts` has no docModel helper, assert in builders.test instead") — this is a real branch with a concrete alternative, not a TODO. No "TBD"/"add error handling"/"write tests for the above" remain. ✅

**Type consistency:** `dataCompressedGb` is a `number` everywhere — returned by `toSizingInputs` (`dataCompressedGb?`), carried on `ApplyResult` (`dataCompressedGb?`), required on `AssembleOptions` (`dataCompressedGb: number`), and supplied to `buildSizingScenarios(inputs, rates, dataCompressedGb)` / `buildTcoSection(tcoInputs, dataCompressedGb)`. `EcpuStorageRates` no longer declares it (Task 2 Step 5a). `tcoProfileFromState` returns `drPosture?` matching `TcoProfile.drPosture?` (Task 3). The Step-4 answer uses `confirmed: !isStorage`, consumed by `applyGateAnswers`’ existing `a.confirmed ? 'manual' : 'assumption-default'`. ✅
