# Orchestrator — builders + prose generation + gate + budget + headless runPipeline (plan 09)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Wire the proven pieces (ingest → classify → size → render) into a **headless, stateless** `runPipeline(config) → PipelineOutput` (design spec §8), adding: deterministic **engine builders** (assemble a full `DocModel` from inputs), the LLM **prose-generation** step (fills the required `DocModel` prose), the **assumptions-gate** data-model + apply-answers, and a **token/cost budget**. Determinism boundary holds: every authoritative number is engine-computed and engine-rendered; the LLM writes narrative prose only.

**Architecture:** `src/engine/builders.ts` (pure `buildSizingScenarios`, `buildTcoSection`), `src/render/builders.ts` (`buildCostChartData`/`buildFiveYearChartData`, `assembleDocModel`), `src/orchestrate/` (`prose.ts`, `gate.ts`, `budget.ts`, `index.ts` = `runPipeline`). Reuses, unchanged: `src/provider`, `src/classify/{triage,sufficiency}`, `src/engine/{sizing,tco,dr}`, `src/render/*`, `src/profile/mongodb`. **Stateless** — resumability/persistence/UI/anonymization/launcher-endpoints/web-search-cost-research are Plan 10.

**Tech Stack:** TypeScript strict / Vitest. The LLM is exercised behind the provider mock-transport (`src/provider` recorder pattern) — fully offline & deterministic. Reproduces the Northwind goldens through the assembled `DocModel`.

**Decisions (open questions resolved):** claims are an **input** to `assembleDocModel` (not auto-derived); the **analyze** step is folded into `generateProse` (no separate LLM call); `generateProse` does **not** web-search; **stateless** (no `RunState` persistence); prose-validation = all required fields **non-empty** (no hard number-reject — see determinism note); model is a string the provider resolves; budget returned in `PipelineOutput.budgetLog` (not persisted).

**Determinism note (prose & numbers):** The renderer's numeric sections (stat cards, tables, charts) are read from the engine-computed `DocModel` and are the **authoritative** figures. `generateProse` is fed the exact figures + topology facts and writes narrative that may reference them; we validate prose fields are non-empty but do **not** regex-ban numbers (that would reject the real deliverable's prose and force vague text). A prose figure can never override a rendered one.

---

### Task 1 — engine builders (`src/engine/builders.ts` + test)
```ts
interface EcpuStorageRates { ecpuPerHr: number; storagePerGbMo: number; dataCompressedGb: number; hoursPerMonth?: number }
function buildSizingScenarios(inputs: SizingInputs, rates: EcpuStorageRates): SizingScenario[] // conservative(÷2)+aggressive(÷3), level 'central'
function buildTcoSection(tcoInputs: TcoInputs, rates: EcpuStorageRates): TcoSection
```
- `buildSizingScenarios`: `consumedEcpu(inputs,'workload')`; per posture `base=baseFor(peak,avg,n)`, `ceilings(base)`; `monthlyEcpuCost = Math.round(base*ecpuPerHr*hoursPerMonth(=730))`, `monthlyStorageCost = Math.round(dataCompressedGb*storagePerGbMo)`, annuals `×12`, totals = parts (the **Math.round** matches the render fixture exactly).
- `buildTcoSection`: `onprem` (components + a default label map + `range(l=>onpremTotal)`), `adbWarm/ColdAnnual = range(l=>adbTotal(...))`, `savingWarm/Cold = annualSaving(...)`, `fiveYear` (cumsum of `fiveYear(...).B`/`.A` computed **once** + `net5`/`paybackYear` + `migrationServices`/`transitionYearCost=A[0]`), `dr` (warm: `'< 10 min'`/`'0 (switchover) / ≤ 1 min (failover)'`; cold: `~${coldRtoHours(dataCompressedGb/1000)} hrs`/`'~1 min'`, both `'manual cross-region'`).
- Tests (exact, drift guard): conservative `base 22, 44, 66, monthlyEcpuCost 1296, monthlyStorageCost 5294`; aggressive `base 18, 36, 54, monthlyEcpuCost 1060`; ratio `2.5`; `onprem.total.central 449500`, `adbWarmAnnual.central 213649`, `adbColdAnnual.central 107746`, `savingWarm {235851,52}`, `net5(warm) 712478`, `net5(cold) 1136090`, `paybackYearWarm 2`, `fiveYear.warmCum[4] === transitionYearCost + 213649*4`; scenario consistency (total=parts, annual=monthly×12).

### Task 2 — DocModel assembly (`src/render/builders.ts` + test)
```ts
function buildCostChartData(companyName, tco): CostChartData      // 3 bars; segments <=3/bar (validated); savePct READ from tco.savingWarm/Cold.pct
function buildFiveYearChartData(tco): FiveYearChartData           // reuses tco.fiveYear cumulative arrays
interface AssembleOptions { companyName; targetPlatform; preparedDate; documentStatus; sizingInputs; assumptions: string[];
  rates: EcpuStorageRates; tcoInputs: TcoInputs; sufficiency: SufficiencyReport;
  prose: {businessCase;sizingBrief;technicalReview}; claims: ClaimInput[] }
function assembleDocModel(o: AssembleOptions): DocModel
```
- `assembleDocModel`: `sizing` from `buildSizingScenarios` + basis (from `sizingInputs` + `assumptions`) + `consumedEcpu` + `dataCompressedGb`; `tco` from `buildTcoSection`; `charts` from the two chart builders; passes `sufficiency`/`prose`/`claims` through. All prose fields required (TS strict).
- Tests: `assembleDocModel(NORTHWIND opts)` — `sizing.scenarios` `[base 22, base 18]`; **`assembled.tco.adbWarmAnnual.central === 213649`, `savingWarm.pct === 52`, `fiveYear.net5Warm === 712478`, payback 2** (drift guard vs the render goldens); `charts.cost.bars.length===3`, `bars[1].savePct===52`, `bars[2].savePct===76`, each bar's segments sum to its total; `charts.fiveYear.paybackYear===2`; all `prose.*` fields non-empty; chart specs pass `withinFrame`/`noCollisions`/`!hasNonFinite` via `buildCostChart`/`buildFiveYearChart`.

### Task 3 — prose generation (`src/orchestrate/prose.ts` + test)
```ts
interface ProseEnsemble { businessCase: BusinessCaseProse; sizingBrief: SizingBriefProse; technicalReview: TechnicalReviewProse }
async function generateProse(docModel: Omit<DocModel,'prose'|'claims'>, llm: LLM, model: string): Promise<{ prose: ProseEnsemble; usage: Usage }>
```
- One `llm.complete` call with a `jsonSchema` (`doc_prose_ensemble`, nested objects matching the three prose interfaces, every field `required`). System prompt: "write narrative; the authoritative numbers are already computed — use the figures provided, don't invent others." User context: **topology facts** (`basis.shards`/`hoVcpu`/`drVcpu`) + the exact engine figures (on-prem/ADB warm/cold, saving %, net5, payback, scenario bases) + the sufficiency verdict + the assumptions list. Parse `result.text` as JSON; **validate every required field is a non-empty string** (throw `ProseValidationError` otherwise); return `{prose, usage: result.usage}`.
- Tests (mock transport returning literal Northwind prose JSON): returns the ensemble; `usage` carried; a missing/empty field → `ProseValidationError`; the built request body contains the topology facts and the figures (context check) and the schema's `required` lists all 7+4+4 fields; deterministic across runs.

### Task 4 — assumptions gate (`src/orchestrate/gate.ts` + test)
```ts
interface GateItem { signalId; label; currentStatus; effectiveConfidence; collectRequest; collectWhy; defaultable }
interface GateAnswer { signalId; value: SignalValue; confirmed: boolean } // confirmed=rep attests a measurement; else an assumption
function buildGateData(sufficiency, profile): { items: GateItem[]; verdict: 'satisfied'|'open' }
function applyGateAnswers(triage: TriageResult, answers: GateAnswer[], files: FileReport[], profile): { triage: TriageResult; sufficiency: SufficiencyReport; inputs?: SizingInputs; blocked: boolean; reasons: string[] }
```
- `buildGateData`: items = required coverage rows that are `missing` or `partial` (eff < engFloor).
- `applyGateAnswers`: each answer → a `BindingResult` (`confirmed` → `method:'manual'` conf 1.0; else `method:'assumption-default'` conf 1.0 — **capped to 0.5 by sufficiency**), merged into `triage.bindings` (re-`mergeBindings` per signal), **re-run `buildSufficiencyReport`** (so the tier recomputes — an assumption-default required signal can never be engineering-grade), then `toSizingInputs`.
- Tests: all-satisfied sufficiency → `items.length 0`, verdict 'satisfied'; a report with N missing required → N items; a **confirmed** answer for a missing required → `toSizingInputs` succeeds and tier can be engineering-grade; an **assumption** answer (confirmed:false) for the same → tier downgraded to `directional-estimate` (not engineering-grade); still-missing → `blocked` with reasons.

### Task 5 — cost/token budget (`src/orchestrate/budget.ts` + test)
```ts
interface BudgetContext { model; rates:{inputPer1k;outputPer1k}; limit?:{tokens?;dollars?}; checkpoints: BudgetCheckpoint[] }
function newBudget(...): BudgetContext
function budgetGuard(b, stage, estInput, estOutput): { proceed: boolean; warning?: string }
function recordUsage(b, stage, usage: Usage): void   // appends a checkpoint with running cumulatives
function recordSkipped(b, stage, reason): void        // explicit 'skipped' checkpoint
function totals(b): { tokens; cost }
```
- Tests: cost calc `(in*inputPer1k + out*outputPer1k)/1000`; `recordUsage` accumulates cumulative tokens+cost monotonically; `budgetGuard` returns `proceed:false`+warning when the projected total would exceed a token or dollar limit, else `proceed:true`; `recordSkipped` appends a checkpoint; multi-stage cumulative is correct.

### Task 6 — headless orchestrator (`src/orchestrate/index.ts` + test)
```ts
interface RunConfig { bundle; profile; companyName; targetPlatform; tcoInputs; rates; assumptions; claims;
  llm?; model?; budgetLimit?; gateAnswers?: GateAnswer[] }
interface PipelineOutput { docModel?: DocModel; rendered: RenderedDoc[]; usage: Usage; budgetLog: BudgetCheckpoint[]; gate: { items: GateItem[]; blocked: boolean; reasons: string[] } }
async function runPipeline(config: RunConfig): Promise<PipelineOutput>
```
- Stages (stateless): triage → buildSufficiencyReport → buildGateData → applyGateAnswers(gateAnswers) → (if blocked: return with gate.blocked + reasons, no docModel) → buildSizingScenarios/buildTcoSection → generateProse (budget-guarded; `recordUsage`) → assembleDocModel → render the 3 docs. Accumulate provider usage (triage vision/prose + generate) in the budget.
- Tests (mock LLM returning Northwind prose): full Northwind run → `docModel.sizing.scenarios[0].base===22`, `docModel.tco.adbWarmAnnual.central===213649`, `prose.businessCase.execSummary` non-empty, `rendered.length===3` each with non-empty `html` and a `.html` filename, `usage` > 0, `budgetLog.length>=1`; **gate-blocking** path (bundle missing a required signal, no gateAnswers) → `gate.blocked`, `gate.items.length>0`, `docModel===undefined`, pipeline stops before generate; **budget-limit** path (tiny `budgetLimit`) → `budgetGuard` blocks generate, a warning checkpoint, no docModel. (Assert the DocModel contract + that 3 docs rendered — NOT specific HTML `$` strings; the renderer goldens already cover HTML.)

## Self-Review
- Realizes spec §8 as a stateless, offline-testable orchestrator; determinism boundary structural (engine computes/renders authoritative numbers; LLM writes prose only, fed the exact figures).
- All critique fixes encoded: Math.round cost (pinned to goldens), gate manual-vs-assumption + tier recompute (reusing `buildSufficiencyReport`), claims as input, savePct read, budget guard/record/skip + monotonicity, prose context with topology + figures, stateless (not "resumable"), Task-6 asserts the contract not HTML.
- Plan 10 (interactive refine + SPA UI + launcher `/anonymize`-`/deanonymize` endpoints + web-search cost research + persistence + packaging) consumes `runPipeline` unchanged.
- Adversarial review before merge.
