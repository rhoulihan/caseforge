# Doc Renderer — 3 outputs + claims→evidence checklist (plan 08)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Render the three deliverables (design spec §10) — **internal technical review**, **customer-facing proposal/brief**, **high-level business case** — plus a **claims→evidence checklist**, as self-contained HTML with embedded house-style SVGs and print CSS. Each renderer is a **pure function `DocModel → {filename, html}`**. The renderer NEVER does math and NEVER calls the LLM.

**Architecture & determinism boundary:** `src/render/` consumes a `DocModel` — a pure-data structure whose **numbers are already computed by the engine** (the Northwind fixture, and later the Plan 09 orchestrator, assemble it with `consumedEcpu`/`baseFor`/`ceilings`/`tco`), whose **prose is required input** (filled by the orchestrator's analyze/generate later), and whose **charts reuse the existing `src/charts` types** (`CostChartData`, `FiveYearChartData`). The renderer **reads verbatim**; tests assert the fixture's internal consistency (totals == parts, cumulative == cumsum) so a future recomputation regression is caught. Claims confidence is **derived from the `SufficiencyReport` coverage** (sizing claims) or carries an **explicit research source + declared confidence** (cost/dossier claims) — never a bare hardcoded value.

**Tech Stack:** TypeScript strict / Vitest, pure functions, zero deps (string concatenation + `escapeHtml`; reuse `src/charts` for SVG; print via `window.print()`/`@page`). Matches `src/engine`/`src/classify` house style.

**Decisions (synthesis open questions resolved):** per-doc prose interfaces are **required** (no renderer fallback — TS enforces); claims generator is a **separate pure module** (`claims.ts`) from its renderer (`claimsChecklist.ts`); the Northwind fixture assembles deterministic numbers **programmatically via existing engine functions** (no staleness) with **literal prose**; sensitivity tables are **auto-generated from `DocModel.sizing.scenarios`**; charts are **inline SVG strings**; the claims checklist is a **separate HTML file**. New engine *builder* helpers (for arbitrary inputs) are deferred to Plan 09; Plan 08's fixture uses the existing engine primitives directly.

---

## DocModel (`src/render/types.ts`)
```ts
import type { CostChartData, FiveYearChartData } from '../charts/costChart'; // + fiveYearChart
import type { Range, RoleUtil } from '../engine/types';
import type { Consumed } from '../engine/sizing';
import type { SufficiencyReport, SignalCoverageItem } from '../classify/sufficiency-types';

interface SizingScenario { level: 'low'|'central'|'high'; posture: 'conservative'|'aggressive';
  base: number; ceiling2x: number; ceiling3x: number;
  monthlyEcpuCost: number; annualEcpuCost: number; monthlyStorageCost: number; annualStorageCost: number;
  totalMonthly: number; totalAnnual: number; }            // all engine-computed; renderer reads
interface SizingSection { basis: { shards; hoVcpu; drVcpu; util: {primary;hoSec;dr}: RoleUtil; assumptions: string[] };
  consumed: Consumed; scenarios: SizingScenario[]; dataCompressedGb: number; }
interface DrOption { posture: 'warm'|'cold'; addedAnnual: Range; totalAnnual: Range; rtoText: string; rpoText: string; failover: string; }
interface TcoSection { onprem: { components: Record<string,Range>; labels: Record<string,string>; total: Range };
  adbWarmAnnual: Range; adbColdAnnual: Range; savingWarm: {amount:number;pct:number}; savingCold: {amount:number;pct:number};
  fiveYear: { years: string[]; statusQuoCum: number[]; warmCum: number[]; coldCum?: number[];
    net5Warm: number; net5Cold: number; paybackYearWarm: number|null; migrationServices: Range; transitionYearCost: number };
  dr: DrOption[]; }
// Required per-doc prose — TS fails if the orchestrator omits a field.
interface BusinessCaseProse { execSummary; fullyLoadedComparison; migrationPath; drContext; keyAssumptions; pullQuote; nextSteps: string }
interface SizingBriefProse { workloadContext; provisioningApproach; sufficiencyStatement; followUps: string }
interface TechnicalReviewProse { technicalNotes; riskAndMitigation; dataModelDecision; performanceValidation: string }
interface DocModel { profileId; companyName; targetPlatform; preparedDate; documentStatus: 'preliminary'|'draft'|'final';
  sizing: SizingSection; tco: TcoSection; charts: { cost: CostChartData; fiveYear: FiveYearChartData };
  sufficiency: SufficiencyReport;
  prose: { businessCase: BusinessCaseProse; sizingBrief: SizingBriefProse; technicalReview: TechnicalReviewProse };
  claims: ClaimInput[]; }            // see claims.ts
```

## Claims (`src/classify/confidence.ts` + `src/render/claims.ts`)
- `src/classify/confidence.ts` (shared, pure): `claimConfidenceFromSignals(signals: SignalCoverageItem[], isDerived: boolean): 'high'|'medium'|'low'` — `min(effectiveConfidence) >= 0.85 → high; >= 0.60 → medium; else low`; a *derived* claim downgrades one tier (unless already low). Threshold documented + fully tested.
- `ClaimInput` (on the DocModel): `{ id; section: 'A'|..'F'; claim; value; unit; dependsOnSignals?: string[]; declaredSource?: {label;confidence}; derived?: boolean }`.
- `src/render/claims.ts` `buildChecklist(docModel): ClaimsChecklistRow[]` (pure): for each `ClaimInput`, if `dependsOnSignals` → look those up in `sufficiency.coverage`, take their `EvidenceRef`s + `claimConfidenceFromSignals` (so sizing claims trace to real coverage, never fabricated); else use the `declaredSource` (cost/dossier claims carry explicit provenance + confidence). Emits `{id, section, claim, value, unit, sources, confidence, derivation}` + a summary (`byConfidence`, `lowestConfidence`).

## File structure
- `src/engine/dr.ts` (+test) — `coldRtoHours(dataTb): number = ceil(1 + dataTb/5)` (the only new engine math; the formula must not be hardcoded in the renderer).
- `src/classify/confidence.ts` (+test) — `claimConfidenceFromSignals`.
- `src/render/types.ts` — the `DocModel` above (required per-doc prose).
- `src/render/shared.ts` (+test) — `escapeHtml`, `escapeProse`, `fmtUsd` (450000→`$450K`, 1_140_000→`$1.14M`), `fmtPct`, `buildHeader/Footer/list/table/row`.
- `src/render/layout.css.ts` — house-style CSS string (Oracle palette, Segoe UI, `@page` letter+margins, stat grid, fig/cap, two-col cards, pull-quote, confidence badges).
- `src/render/businessCase.ts`, `sizingBrief.ts`, `technicalReview.ts`, `claimsChecklist.ts` (+ each test).
- `src/render/index.ts` (+ `smoke.test.ts`) — `renderBusinessCase/SizingBrief/TechnicalReview/ClaimsChecklist`.
- `src/render/fixtures/northwind-docmodel.ts` — Northwind `DocModel`: numbers from existing engine fns (`consumedEcpu(NORTHWIND_SIZING,'workload')`, `baseFor`, `ceilings`, the `tco` fns + Northwind TCO inputs), prose literal.
- `src/render/northwind.golden.test.ts`.

---

### Task 1 — `coldRtoHours` (`src/engine/dr.ts` + test)
Tests: `coldRtoHours(45.8) === Math.ceil(1 + 45.8/5)` (≈ 11); `coldRtoHours(0) === 1`; rejects negative.

### Task 2 — `claimConfidenceFromSignals` (`src/classify/confidence.ts` + test)
Tests: `[{eff:0.9},{eff:0.95}]` non-derived → `high`; `[0.7,0.65]` → `medium`; `[0.5]` → `low`; derived `[0.9,0.95]` → `medium`; derived `[0.5]` → `low`; empty → `low`. (Use `SignalCoverageItem`-shaped objects.)

### Task 3 — `DocModel` types (`src/render/types.ts`)
Type-only; reuses `CostChartData`/`FiveYearChartData`/`Range`/`Consumed`/`SufficiencyReport`. Acceptance: per-doc prose required; compiles strict.

### Task 4 — shared builders + CSS (`shared.ts`, `layout.css.ts` + test)
Tests: `escapeHtml('<script>')` → `&lt;script&gt;`; `escapeProse` escapes + passes through plain text; `fmtUsd(450000)`→`$450K`, `fmtUsd(1_140_000)`→`$1.14M`, `fmtUsd(214000)`→`$214K`; `fmtPct(52)`→`52%`; `buildHeader` includes company+date+status; layout CSS string contains `@page` and `@media print`.

### Task 5 — Northwind fixture (`fixtures/northwind-docmodel.ts`)
Assemble the DocModel **via existing engine fns** so numbers are engine-derived. Test (in golden, Task 11): `consumed.ratio === 2.5`; conservative central `base === 22`, `ceiling2x === 44`, `ceiling3x === 66`; aggressive `base === 18` (36/54); `tco.savingWarm.pct` ≈ 52; payback year 2; **internal consistency**: every `scenario.totalMonthly === monthlyEcpuCost + monthlyStorageCost`, `totalAnnual === annualEcpuCost + annualStorageCost`; `fiveYear` cumulative arrays equal the running sum of their yearly deltas (proves the fixture/engine produced consistent data the renderer only reads).

### Task 6 — business-case renderer (`businessCase.ts` + test)
Pure `DocModel → {filename:'business-case-<slug>.html', html}`. Sections: header + exec summary, 4 stat cards (on-prem total, ADB warm, saving %, payback) **read from DocModel**, cost chart (inline SVG via `renderCostChart(docModel.charts.cost)`), migration prose, five-year chart, two DR posture cards (RTO/RPO text from DocModel), key-assumptions list, pull-quote, next-steps, footer.
Tests: determinism (same DocModel → identical html); structure (one `<h1>`, 4 `.stat`, 2 `<svg>`, 2 DR cards, pull-quote, footer); **data** (stat cards contain `$450K`/`$214K`/`52%`/`Yr 2` read verbatim — not recomputed); **XSS** (prose `<script>` escaped); **chart invariants** (`buildCostChart(docModel.charts.cost)` passes `withinFrame`/`noCollisions`/`!hasNonFinite`); the savings %/payback shown equal `docModel.tco.savingWarm.pct`/`paybackYearWarm` (read, not derived).

### Task 7 — sizing-brief renderer (`sizingBrief.ts` + test)
Sections: environment table (topology/vCPU/RAM/data), workload table (util avg/peak/ratio), methodology prose, **scenarios table auto-generated from `sizing.scenarios`** (level×posture × base/2x/3x/$mo/$yr), follow-ups from `sufficiency.whatToCollect`.
Tests: determinism; scenarios table has a row per scenario with base/ceilings/costs read verbatim; the follow-up list equals the whatToCollect items; util ratio shown == `sizing.consumed.ratio`.

### Task 8 — technical-review renderer (`technicalReview.ts` + test)
Sections: rationale prose, **SufficiencyReport embedding** (inventory table, coverage table [signal/criticality/status/effConfidence/method], verdict [tier+headline+counts+limitingSignals], whatToCollect), sensitivity table (auto from scenarios low/central/high), risk/data-model/performance prose.
Tests: determinism; inventory row count == `sufficiency.inventory.length`; coverage row count == `sufficiency.coverage.length`; verdict tier label == `sufficiency.verdict.tier`; whatToCollect rows present; prose escaped.

### Task 9 — claims generator (`src/render/claims.ts` + test)
`buildChecklist(docModel)` pure. Tests: a **sizing** claim (e.g. peak ECPU) derives confidence from `sufficiency.coverage` (assert it reflects the coverage's effectiveConfidence tier, not a constant); a **cost** claim (MongoDB EA) carries its `declaredSource` (dossier) + `medium`; summary `byConfidence` counts equal the row tallies; `lowestConfidence` lists the low/medium cost drivers.

### Task 10 — claims-checklist renderer + index (`claimsChecklist.ts`, `index.ts` + tests)
`claimsChecklist.ts` renders `buildChecklist` rows as a table (id|claim|value|unit|source|confidence badge|derivation) + summary callout tying tier to "collect X to upgrade". `index.ts` exports the 4 renderers. Tests: checklist groups by section A–F; confidence badge classes present; determinism. `smoke.test.ts`: all 4 renderers run on the Northwind fixture, each yields valid HTML (`<!DOCTYPE`, `<style>`, embedded `<svg>` where expected) and is deterministic across runs.

### Task 11 — Northwind golden (`northwind.golden.test.ts`)
Render all 4 docs from the fixture; assert the fixture's internal consistency (Task 5 list), that each doc contains its headline numbers, and that re-rendering is byte-identical. Ties the renderer output to the engine goldens (22→44/66, 18→36/54; warm ≈52%).

## Self-Review
- Realizes spec §10/§11; renderer is pure (reads), engine computes, prose is required input — the determinism boundary is structural and test-enforced (consistency asserts catch recomputation).
- All critique fixes encoded: required prose, claims confidence from coverage (+ explicit research provenance, no fabrication), `escapeProse` XSS guard, SVG house-style invariant assertions, DR RTO via `coldRtoHours` (not hardcoded), structural+data assertions (no brittle whole-HTML snapshots), chart-type reuse.
- New engine builders for arbitrary inputs deferred to Plan 09 (orchestrator); the fixture proves the contract with existing engine math.
- Adversarial review before merge.
