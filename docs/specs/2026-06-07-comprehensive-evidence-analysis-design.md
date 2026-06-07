---
Status: Proposed — awaiting approval (2026-06-07). Author: Rick Houlihan + Claude.
Produced by a hardened design workflow: 3 code maps → 3 independent proposals → 3 adversarial reviews → synthesis.
Tier→vCPU table source: docs/ATLAS-SOURCE-PROFILE.md §4 (AWS, illustrative; M80=32 anchors to the hand sizing).
---

Now I have everything I need. Here is the final approval-ready architecture specification.

---

# CaseForge Image + Qualitative Signal Extraction — Final Architecture Specification

## 1. Problem and Requirement Recap

Every file a rep submits must be fully analyzed: quantitative signals (shard count, vCPU, CPU utilization, etc.) and qualitative context (concerns, objections, timeline, positioning) must both flow through to the sizing engine and all four deliverables.

The motivating failure: a single `.msg` containing embedded monitoring dashboard screenshots and a form screenshot came back BLOCKED (5/6 required signals missing) and dropped all qualitative context. Three root causes are confirmed and localized:

- `readChartImage` (llm.ts:95) hard-drops any panel whose `valueKind !== 'avgPeak'`, making scalars (shardCount, vCPU, tier) unreachable from images. It also returns a single binding per image, so a 3x3 dashboard collapses to one panel.
- `classifyProse` is enum-only with no qualContext output channel.
- No qualContext type, field, or flow path exists anywhere in the pipeline.

Four locked decisions and three required fixes are treated as settled (D1 role-mapping auto-heuristic + warning + gate override; D2 hard per-image acknowledge; D3 classify budget accounting; F1 image-derived context re-slugged; F2 sourced tier table, unknown = gate-ask; F3 golden non-drift).

---

## 2. Architecture and Chosen Approach

**Minimal surgical extension of the existing single-LLM-call seam in both directions.** Replace `readChartImage` with `readArtifactImage` (multi-panel discriminated-union schema) and `classifyProse` with `classifyText` (scalars + enums + qualContext). Thread a new `QualContext` type from `TriageResult` through `RunConfig` into `buildProseContext`. Enforce all invariants at the seam boundaries.

This is preferred over a unified "analyze()" abstraction (UNIFIED proposal) because:
- The async Slugger pattern in UNIFIED had a confirmed fatal bug (`.map()` producing `Promise[]` not strings).
- The two escalation paths have distinct calling conventions (image vs text/table) and distinct validation logic; merging them into one function adds indirection without reducing duplication.

This is preferred over the ROBUST proposal's Slugger-on-classifyText design because the adversarial review confirmed that text primitives in the anonBundle are already slugged by the Go launcher before triage — applying the Slugger to classifyText output would double-replace and corrupt slug tokens.

**Key structural decisions made here:**

- Slugger is injected ONLY into `readArtifactImage`, never into `classifyText`.
- `triage()` return type changes to `{ result: TriageResult; usage: Usage }` — all callers updated atomically.
- `node.atlasTier` is a new recommended signal; triage post-processing synthesizes BOTH `node.hoVcpu` AND `node.drVcpu` from it when the corresponding role-labeled panels emit the same tier string, but only after removing any conflicting vision binding for those slots from the candidate pool.
- `imageAcknowledgedIds` is persisted in `serialize.ts` with `?? []` backward-compat fallback.
- The pre-generate `budgetGuard` estimate is `3000 + (qualContextItemCount * 50)` to avoid the code-order inversion that dynamic `buildProseContext` pre-computation would require.

---

## 3. Comprehensive Per-Modality Analysis

| Modality | Current path | New path |
|---|---|---|
| KeyValue | `bindKeyValue` (heuristics) | Unchanged. `node.atlasTier` alias list adds 'instance size', 'cluster tier', 'atlas tier' (NOT tier codes — see §4 review finding). |
| Table (numeric series) | `bindNumericSeries` | Unchanged. Engineering-grade path for util signals. |
| Table (wide/tall) | `bindTableScalars` / `bindKeyValueTable` | Unchanged. |
| Text/Table primitive | `classifyProse` → enum-only, no qualContext | `classifyText` → scalars + enums + qualContext. Already-slugged input means no re-slug needed. |
| Image primitive | `readChartImage` → single avgPeak binding, drops scalars/enums | `readArtifactImage` → array of typed panel bindings + qualContext. Image-derived strings re-slugged via injected Slugger. |

All modalities now have a path to qualitative context. Scalars (shardCount, vCPU, tier label) can be extracted from form screenshots. Multi-panel dashboards produce multiple bindings per image call.

---

## 4. Quantitative Extraction

### 4a. ARTIFACT_SCHEMA (replaces CHART_SCHEMA)

Location: `/mnt/c/Users/rickh/GitHub/caseforge/src/classify/llm-schemas.ts` (new file).

```
name: 'artifact_reading'
schema:
  type: object
  additionalProperties: false
  required: [panels, qualContext]
  properties:
    panels:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [kind, panelLabel, signalId, confidence]
        properties:
          kind: { type: string, enum: [avgPeak, scalar, enum] }
          panelLabel: { type: string }
          signalId: { type: string }
          numericValue: { type: number }    ← explicit typed field, not value:{}
          strValue: { type: string }        ← explicit typed field, not value:{}
          avgPct: { type: number }
          peakPct: { type: number }
          confidence: { type: number }
    qualContext:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [text, category]
        properties:
          text: { type: string, minLength: 1 }
          category: { type: string, enum: [concern, objection, timeline, positioning] }
```

Note on `numericValue`/`strValue`: splitting the polymorphic value into two explicit typed fields sidesteps the `value: {}` empty-schema issue (adversarial review finding, confirmed). The parser reads `numericValue` for scalar kind and `strValue` for enum kind.

### 4b. TEXT_SCHEMA (replaces PROSE_SCHEMA in classify/llm.ts)

```
name: 'text_signals'
schema:
  type: object
  additionalProperties: false
  required: [bindings, qualContext]
  properties:
    bindings:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [signalId, numericValue, strValue, confidence, valueKind]
        properties:
          signalId: { type: string }
          numericValue: { type: number }
          strValue: { type: string }
          confidence: { type: number }
          valueKind: { type: string, enum: [scalar, avgPeak, enum] }
    qualContext: (same as ARTIFACT_SCHEMA.qualContext)
```

For avgPeak bindings from text, the LLM emits `numericValue` as the average and a second binding entry for the peak, or the system prompt asks for avg+peak as two separate scalar entries. Simpler: extend the schema with `avgPct`/`peakPct` alongside `numericValue`/`strValue` — the parser handles whichever fields are populated based on `valueKind`.

Revised binding item:
```
required: [signalId, confidence, valueKind]
optional: numericValue, strValue, avgPct, peakPct
```

### 4c. readArtifactImage System Prompt

```
You are reading a customer artifact image (monitoring dashboard, intake form, cluster configuration screenshot). Your task:

1. For EVERY visible panel or data field, emit one entry in 'panels'. Each panel must have a distinct panelLabel (use the exact label text you see).

2. For CPU/utilization time-series panels: kind='avgPeak'. Read avgPct (average utilization) and peakPct (peak utilization) as 0-1 fractions from the Y-axis range visible in that panel. Example: if the panel shows 18% average / 45% peak, emit avgPct=0.18, peakPct=0.45.

3. For numeric count or size fields (e.g. 'Number of shards: 3', 'vCPU: 32'): kind='scalar', set numericValue.

4. For categorical labels (e.g. 'Tier: M80', 'Edition: Enterprise Advanced'): kind='enum', set strValue.

5. Available signalIds (ONLY use these — never invent one):
   [list all schema.signals where derivableBy.includes('vision'), formatted as: signalId (label) — valueKind]
   This includes BOTH avgPeak AND scalar AND enum signals.

6. In 'qualContext', capture any customer concern, objection, deadline, or positioning statement visible in text surrounding the data — NOT from the metric values themselves.

Report ONLY what you can actually read in the image. If a panel is too dark or unclear to read, omit it rather than guessing. Do NOT compute — only READ.
```

### 4d. classifyText System Prompt

```
Extract sizing signals AND qualitative context from the text below.

Sizing signals to extract:
- Scalar signals (emit numericValue): [scalarId: label, ...]
- Enum signals (emit strValue): [enumId: label, ...]
- AvgPeak signals (emit avgPct + peakPct as 0-1 fractions): [avgPeakId: label, ...]

For qualContext, extract customer concerns, objections, deadlines, and positioning statements verbatim or near-verbatim. Categorize each as: concern (customer worry/risk), objection (resistance to migration), timeline (deadline or urgency), or positioning (why they are evaluating this change).

Only extract what the text clearly states — never compute, infer, or invent numbers. If a number is approximate in the text, include it at proportionally lower confidence.
```

### 4e. Multi-Panel Handling

One LLM call per image. The response is an array of panel entries. `readArtifactImage` iterates the full `panels` array and emits one `BindingResult` per valid entry. Validation per entry:
- `avgPeak`: require `avgPct` and `peakPct` both finite, both in [0,1], `avgPct <= peakPct`. Drop if violated.
- `scalar`: require `numericValue` finite; require it within `SIGNAL_SANITY_RANGE[signalId]` if defined. Drop if violated.
- `enum`: require `strValue` non-empty string. Pass through as-is (controlled vocabulary for tier codes; free text for edition).
- Unknown `signalId` (not in `schema.signals`): silently drop.
- Inverted avgPeak (avg > peak, confirmed pre-existing gap): drop. New test covers this.

### 4f. D1 Role Mapping

New file: `/mnt/c/Users/rickh/GitHub/caseforge/src/classify/role-assign.ts`

```
export type RoleToken = 'primary' | 'secondary' | 'dr';
export interface PanelRoleInput { panelLabel: string; peakPct?: number }
export interface RoleAssignment {
  roles: Record<string, RoleToken>;  // panelLabel -> role
  heuristicLabels: string[];         // labels where positional/load fallback was used
}

export function assignRoles(panels: PanelRoleInput[]): RoleAssignment
```

Algorithm:
1. For each label, call `roleTokenOf(label)` from heuristics.ts. If it returns a token, assign it.
2. Collect unlabeled panels (no roleToken match).
3. Unlabeled fallback: sort by `peakPct` descending (highest = primary, next = secondary, remaining = dr). If `peakPct` unavailable, positional order (index 0 = primary, 1 = secondary, 2+ = dr).
4. Duplicate token collision (two panels both claimed primary): prefer the one with higher `peakPct`; the other becomes secondary.
5. `heuristicLabels` lists every label assigned by fallback.

**Scope guard**: `assignRoles` is ONLY called for panels whose `signalId` starts with `'util.'`. Non-util panels (`disk.iops`, `workload.opsPerSec`) use the LLM-reported `signalId` verbatim without role remapping. This prevents IOPS panels from being mis-mapped to util slots.

**readArtifactImage integration**: After parsing all panels, separate util.* panels and call `assignRoles(utilPanels)`. For each util panel, replace the LLM-emitted `signalId` with the role-assigned util signal (`util.primary`, `util.hoSec`, `util.dr`). For non-util panels, the LLM's `signalId` is used directly (after validation against the schema).

**D1 warning**: when `heuristicLabels` is non-empty, the `BindingResult` for those panels gets `note: 'Role assigned by load/positional heuristic — verify node topology in Step 4'`. The `TriageResult` gains `roleWarning?: string` (set to a summary when any heuristic was used). Step4Confirm.tsx displays a yellow banner and a 'Correct roles' expandable when `tri.roleWarning` is set. The gate item for the affected util signal appears in the upgrade ask section because heuristic-assigned panels have confidence 0.7, which is below `engFloor` (0.8). The rep can enter confirmed values via the existing `GateRow` UI, which emits `method: 'manual'` bindings that displace the heuristic-vision binding by trust rank (7 vs 3).

### 4g. F2 Atlas Tier → vCPU Table

Source: `/mnt/c/Users/rickh/GitHub/caseforge/docs/ATLAS-SOURCE-PROFILE.md §4` (read above — table confirmed).

Added to `ENGINE_CONFIG` in `/mnt/c/Users/rickh/GitHub/caseforge/src/engine/config.ts`:

```
atlasTierVcpu: {
  M10: 2,    // burstable
  M20: 2,    // burstable
  M30: 2,
  M40: 4,
  M50: 8,
  M60: 16,
  M80: 32,   // F2 anchor — matches NORTHWIND_SIZING.hoVcpu = 32
  M140: 48,
  M200: 64,
  M300: 96,
  // M10/M20 are burstable; M30+ production. Low-CPU variants (e.g. M30_LOW_CPU) not in table -> undefined -> gate-ask.
}
```

New file: `/mnt/c/Users/rickh/GitHub/caseforge/src/classify/tier-lookup.ts`

Exports:
- `tierToVcpu(tier: string, config: EngineConfig = ENGINE_CONFIG): number | undefined` — trims, uppercases, exact lookup. Returns `undefined` for unknown tiers. Never throws, never guesses.
- `KNOWN_TIERS: readonly string[]` — for use in vision prompts.

**Node.atlasTier signal** added to mongodb.ts recommended array:
- `id: 'node.atlasTier'`
- `valueKind: 'enum'`
- `criticality: 'recommended'`
- `defaultable: true`
- `derivableBy: ['vision', 'llm-text', 'keyvalue']`
- `aliases: ['instance size', 'cluster tier', 'atlas tier', 'instancesize', 'tier']` (no tier code strings — review finding confirmed these cause false positives via substring match in `matchSignalByAlias`)
- No `engineSlot` — the vCPU derivation is performed in triage post-processing, not via the engineSlot path

**Tier-lookup post-processing in triage.ts** (runs after all candidates are accumulated, before mergeBindings):
```
for each candidate where signalId === 'node.atlasTier':
  const vcpu = tierToVcpu(String(candidate.value), ENGINE_CONFIG)
  if vcpu !== undefined:
    // Remove any vision-method candidate for node.hoVcpu from the pool (D review finding: prevent
    // hallucinated LLM scalar from surviving in candidates alongside the authoritative table-lookup)
    filter out candidates where signalId === 'node.hoVcpu' && method === 'vision'
    push BindingResult{ signalId: 'node.hoVcpu', value: vcpu, confidence: 1.0,
                        method: 'table-lookup', evidence: [...candidate.evidence],
                        note: 'derived from node.atlasTier via ENGINE_CONFIG.atlasTierVcpu' }
    // Also synthesize node.drVcpu if not already bound by keyvalue/numeric-series/table-lookup
    // AND if the tier panel was DR-role-labeled (role token 'dr') OR if node.drVcpu has no candidate yet
    // For the motivating .msg case (symmetric cluster), same tier applies to both regions:
    if no candidate exists for node.drVcpu with method in [keyvalue, numeric-series, table-lookup]:
      filter out candidates where signalId === 'node.drVcpu' && method === 'vision'
      push BindingResult{ signalId: 'node.drVcpu', value: vcpu, confidence: 1.0,
                          method: 'table-lookup', evidence: [...candidate.evidence],
                          note: 'assumed same tier as home region — verify at gate if DR region differs' }
```

The drVcpu synthesis is what makes the motivating .msg scenario reach directional-estimate rather than remaining BLOCKED on `node.drVcpu`. The note on the binding surfaces in the gate as an assumption-upgrade ask when the rep reviews (critical review finding §correctness item 1, confirmed addressed).

**Unknown tier behavior**: `tierToVcpu` returns `undefined` → no binding pushed for `node.hoVcpu` → signal stays missing → sufficiency emits it as blocking → gate presents `collectRequest: 'Atlas tier [X] is not in the lookup table. Please enter the vCPU count manually.'`

---

## 5. Qualitative Extraction

### 5a. QualContext Type

New file: `/mnt/c/Users/rickh/GitHub/caseforge/src/classify/qual-context.ts`

```typescript
export type QualContextCategory = 'concern' | 'objection' | 'timeline' | 'positioning';

export interface QualContextItem {
  text: string;
  source: string;   // ALWAYS injected by the caller (readArtifactImage: img.source; classifyText: p.source)
  category: QualContextCategory;
}

export interface QualContext {
  items: QualContextItem[];
}

export function emptyQualContext(): QualContext { return { items: [] }; }

// Concatenates — no dedup needed (different source documents legitimately produce duplicate concerns)
export function mergeQualContexts(a?: QualContext, b?: QualContext): QualContext {
  return { items: [...(a?.items ?? []), ...(b?.items ?? [])] };
}
```

`source` is NOT part of the LLM schema — it is injected from the primitive after parsing. The LLM cannot know filenames (adversarial review finding §correctness item 2, confirmed).

### 5b. Flow

```
readArtifactImage / classifyText
  -> QualContextItem[] (slugged for image path; already-slugged for text path)
  -> triage.ts accumulator: qualItems: QualContextItem[]
  -> TriageResult.qualContext?: QualContext          (optional for backward compat)
  -> applyGateAnswers spreads triage (qualContext preserved automatically via {...triage, bindings: merged})
  -> RunConfig.qualContext?: QualContext
  -> buildProseContext(d, qualContext?) appends CUSTOMER CONTEXT section
  -> generateProse LLM input (slugged throughout)
  -> prose output contains slugged tokens
  -> Go launcher de-anonymize at render (existing flow — no change)
```

### 5c. buildProseContext CUSTOMER CONTEXT section

Added after the ASSUMPTIONS block:

```
if (qualContext && qualContext.items.length > 0):
  cap items to max 20, truncate each text to 200 characters (token-inflation guard — review finding §invariants minor item 2)
  append:
    ''
    'CUSTOMER CONTEXT (weave into the narrative — address each concern and timeline explicitly):'
    for concern items:    '- CONCERN: <item.text> [from <item.source>]'
    for objection items:  '- OBJECTION: <item.text> [from <item.source>]'
    for timeline items:   '- TIMELINE: <item.text> [from <item.source>]'
    for positioning items:'- POSITIONING: <item.text> [from <item.source>]'
```

### 5d. generateProse System Prompt Addition

Appended after the existing base system string:

```
Per-deliverable instructions for weaving customer context:
- businessCase.execSummary: if concerns are present, open with the customer's primary concern. businessCase.nextSteps: reference any stated deadline or urgency.
- technicalReview.riskAndMitigation: address each stated objection as a named risk with a mitigation. technicalReview.technicalNotes: note any timeline constraints.
- sizingBrief.workloadContext: incorporate any positioning context that explains why the customer is evaluating this move. sizingBrief.followUps: address any remaining objections.
- If no CUSTOMER CONTEXT is provided, write normally without fabricating concerns.
- The authoritative figures block takes absolute precedence — never replace an engine-computed number with a customer-stated estimate.
```

### 5e. De-anonymization

qualContext items are stored and transmitted slugged (e.g. `CF_ORG_01 is concerned about migration cost`). The generation LLM receives slugged text, produces slugged prose. The existing Go launcher de-anonymize call at render time replaces all slugs with real names. No change needed to renderers.

---

## 6. LLM Instruction Design (Complete Sketches)

See §4c and §4d above for the full extraction prompt sketches.

**Prose generation**: the existing system string is preserved. The per-deliverable weaving instructions are appended as a second paragraph (§5d). `buildProseContext` is the sole vehicle for all numeric + qualitative context — no parallel channels.

**Schema enforcement**: both ARTIFACT_SCHEMA and TEXT_SCHEMA use `additionalProperties: false` with explicit typed fields. The `numericValue`/`strValue` split avoids `value: {}` (confirmed API compatibility fix from adversarial review finding §invariants major item 3).

---

## 7. Determinism + Fail-Closed Anonymization Proofs

### Determinism

The LLM emits:
- `node.atlasTier = 'M80'` (string) → triage calls `tierToVcpu('M80', ENGINE_CONFIG)` → returns `32` (pure table lookup, no LLM) → `BindingResult(node.hoVcpu, 32, method:'table-lookup')`. The integer `32` is what the engine sees. The LLM never emitted a vCPU number.
- `{kind: 'avgPeak', avgPct: 0.18, peakPct: 0.45}` → validated range [0,1] and avg<=peak → `BindingResult(util.primary, {avgPct:0.18, peakPct:0.45})`. The engine receives the raw fractions.
- qualContext items → flow into `buildProseContext` as text strings → used only as LLM input context, never as numeric inputs. No arithmetic crosses the LLM boundary.

The TRUST rank table is unchanged. mergeBindings is unchanged. `toSizingInputs` is unchanged.

Vision binding for `node.hoVcpu` is explicitly filtered out of candidates when the tier-lookup synthesis fires (review finding §invariants critical item 2 — prevents hallucinated LLM scalar from surviving in the merge pool).

Golden stability: NORTHWIND_SIZING has `hoVcpu=32` produced by `bindKeyValue` on `'cores per node': '32'` (method `keyvalue`, TRUST=5). A new `node.atlasTier='M80'` table-lookup binding (TRUST=4) loses to keyvalue. The golden numbers are unchanged.

### Fail-Closed Anonymization

**Text path**: text primitives in `anonBundle` are already slugged by the Go launcher before triage. `classifyText` receives slugged text, produces slugged qualContext items. No Slugger needed or applied. (ONLY applying Slugger to image path is the explicit fix to the double-replace bug from adversarial review §invariants critical item 1.)

**Image path**: `readArtifactImage` receives an optional `Slugger: (text: string) => string`. After parsing the LLM response and before constructing any `QualContextItem`, every `qualContext[].text` field is passed through the Slugger. The Slugger is constructed in `triage.ts` as a synchronous pure-TS string replacer using `orderedForward(expandEntries(map))` from `anon/mapping.ts`. This is the same replacement logic the Go launcher applies, applied in-TS to image-derived strings.

**Why synchronous Slugger is safe**: the UNIFIED proposal's async Slugger was confirmed fatal (`.map()` producing `Promise[]` — review finding §invariants critical item 3). The synchronous version avoids this entirely. The Slugger is `(text: string) => string`, not async.

**Divergence note**: the TS Slugger and Go launcher share the same phrase list (`expandEntries(map)`) but differ in implementation language. A test is added that runs both over the same input and asserts identical output (review finding §invariants major item 7). Until that test exists, the TS Slugger is documented as "best-effort, same map, may diverge on edge-case Unicode — Go launcher is authoritative". The D2 per-image acknowledge gate is the human backstop for any residual misses.

**Enum string values** (e.g. `strValue: 'M80'` for `node.atlasTier`): these go to `tierToVcpu` immediately and produce a number. They never reach `buildProseContext` as strings. No re-slugging needed for controlled-vocabulary enum values.

**Leak paths enumerated**:

| Path | Status |
|---|---|
| Vision reads un-redacted name from garbled OCR region → qualContext item text | CLOSED: Slugger replaces any map-entry phrase before storage |
| Vision reads un-redacted name not in the map | RESIDUAL: D2 acknowledge gate is the backstop. The name would appear in qualContext and potentially in prose output. Rep must review redaction preview. |
| classifyText produces qualContext from un-slugged text | IMPOSSIBLE: text primitives are slugged before triage |
| Vision emits tier code containing company name | IMPOSSIBLE: tier codes (M80, etc.) are not company names |
| qualContext from TriageResult reaches generateProse un-slugged | IMPOSSIBLE by construction: re-slug occurs at read time in readArtifactImage, before storage |

---

## 8. D2 Per-Image Acknowledge Gate

### State Model

`WizardState` gains:
```typescript
imageAcknowledgedIds: string[];   // initialized to [] in initialWizardState()
```

Key format: `"${primitiveIndex}:${source}"` — index prevents same-named attachments from sharing acknowledgement; source provides display context. This matches the existing `ImgReview.id` convention.

### stepValidity Change

`/mnt/c/Users/rickh/GitHub/caseforge/src/ui/state.ts` line 116 area:

```typescript
const anonImageKeys = (s.anonBundle?.primitives ?? [])
  .map((p, i) => p.kind === 'image' ? `${i}:${p.source}` : null)
  .filter((k): k is string => k !== null);
const allAcknowledged = anonImageKeys.length === 0 ||
  anonImageKeys.every(k => s.imageAcknowledgedIds.includes(k));
const anonOk = !!s.anonBundle && (!anonHasImages || (s.imagesReviewed && allAcknowledged));
```

`imagesReviewed` is preserved as a necessary-but-not-sufficient condition (anonymize completed). `allAcknowledged` is the new per-image requirement. Both must be true for `anonOk`.

### Step3Anonymize.tsx UX Changes

1. Each `ImgReview` figcaption gains a second checkbox below the existing 'send to AI' checkbox:
   ```
   <label class={`cf-ack-label${!acked ? ' cf-ack-required' : ''}`}>
     <input type="checkbox"
       checked={state.imageAcknowledgedIds.includes(`${r.id}:${r.source}`)}
       onChange={() => toggleAcknowledge(r.id, r.source)} />
     I have reviewed this redaction
   </label>
   ```
2. `toggleAcknowledge(id, source)`: computes key `${id}:${source}`, toggles in `state.imageAcknowledgedIds` via `patch`.
3. `anonymizeAll()` line 149: change `patch({ anonBundle, imagesReviewed: true })` to `patch({ anonBundle, imagesReviewed: true, imageAcknowledgedIds: [] })`. The auto-set of `imagesReviewed: true` is KEPT (review finding §buildability critical item 2 — removing it would break the existing test `Step3Anonymize.test.tsx:160`). The D2 gate is enforced via the additional `allAcknowledged` check, not by removing `imagesReviewed`.
4. Back-nav recovery useEffect (line 63): `if (state.imagesReviewed && imgReview.length === 0) patch({ imagesReviewed: false, imageAcknowledgedIds: [] })`.
5. Count indicator below the grid: `"X of Y image(s) reviewed — acknowledge each before continuing"` when `anonImageKeys.length > allAcknowledgedCount`.
6. Card gets amber border (`cf-imgcard--unacked` CSS class) when not acknowledged.

### Archive Persistence

`serialize.ts` stateJson (line ~113): add `imageAcknowledgedIds: state.imageAcknowledgedIds` to the serialized object.

Deserialize path: `imageAcknowledgedIds: (stateJson.imageAcknowledgedIds as string[] | undefined) ?? []` — backward compat for archives saved before this field (review finding §buildability critical item 4).

---

## 9. D3 Cost Accounting

### triage() Return Type

```typescript
// Before:
export async function triage(...): Promise<TriageResult>

// After:
export async function triage(...): Promise<{ result: TriageResult; usage: Usage }>
```

All four callers updated atomically in the same PR:

1. `triage.test.ts` — all `triage()` calls → `const { result } = await triage(...)` or `const { result, usage } = await triage(...)`.
2. `northwind-classify.golden.test.ts` — two `triage()` calls at lines 62 and 84 → destructure both.
3. `orchestrate/index.test.ts` line 106 — `const precomputed = await triage(...)` → `const { result: precomputed } = await triage(...)` (review finding §buildability critical item 1, explicitly confirmed).
4. `Step4Confirm.tsx` — see §9c below.

### Usage Accumulation in triage.ts

```typescript
const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };

// In image branch:
const { bindings, qualContext, usage } = await readArtifactImage(...);
totalUsage.inputTokens += usage.inputTokens;
totalUsage.outputTokens += usage.outputTokens;

// In text branch:
const { bindings, qualContext, usage } = await classifyText(...);
totalUsage.inputTokens += usage.inputTokens;
totalUsage.outputTokens += usage.outputTokens;

return { result: { profileId, inventory, bindings, qualContext: { items: qualItems } }, usage: totalUsage };
```

### Pre-Triage Budget Guard in index.ts

Added at line 89 area before the triage call:

```typescript
const imgCount = config.bundle.primitives.filter(p => p.kind === 'image').length;
const txtCount = config.bundle.primitives.filter(p => p.kind === 'text' || p.kind === 'table').length;
const estClassifyIn = imgCount * 2000 + txtCount * 500;
const estClassifyOut = (imgCount + txtCount) * 200;
const classifyGuard = budgetGuard(budget, 'classify', estClassifyIn, estClassifyOut);
if (!classifyGuard.proceed) {
  recordSkipped(budget, 'classify', classifyGuard.warning ?? 'classify budget exceeded');
  fireCheckpoint();
  return { ...base, budgetLog: log(), gate: clear, error: classifyGuard.warning };
}
```

Then the triage call:
```typescript
let tri: TriageResult;
if (config.triage) {
  tri = config.triage;
  recordSkipped(budget, 'classify', 'classify reused from caller');
  fireCheckpoint();
} else {
  const { result, usage: classifyUsage } = await triage(
    config.bundle, config.profile, config.llm, model, config.anonMap
  );
  tri = result;
  if (config.llm) recordUsage(budget, 'classify', classifyUsage);
  else recordSkipped(budget, 'classify', 'no LLM — heuristics only');
  fireCheckpoint();
}
```

### Pre-Generate Budget Guard (Dynamic Estimate)

The code-order issue (review finding §buildability critical item 3): `buildProseContext` requires the assembled numeric DocModel which is only built at line 118. Solution: keep static base estimate, add qualContext item count penalty:

```typescript
const estGenerateIn = 3000 + ((tri.qualContext?.items.length ?? 0) * 50);
const guard = budgetGuard(budget, 'generate', estGenerateIn, 1500);
```

This avoids calling `assembleDocModel` before the guard, while accounting for qualContext inflation without full context pre-computation.

### D3 Gap: classify usage for precomputed-triage path

When `config.triage` is provided, Step4Confirm already ran triage and discarded the usage. This is accepted as a known gap for v1. `RunConfig` gains `classifyUsage?: Usage`. Step4Confirm stores the classify usage from the destructured triage result and passes it to `RunConfig`. The pipeline records it via `recordUsage` on the precomputed path. This closes the D3 gap completely but is implemented in the same PR to avoid leaving the gap documented-but-not-fixed.

### Step4Confirm.tsx Changes (review finding §buildability critical item 4)

```typescript
// Before:
triage(bundle, MONGODB_PROFILE, llm, MODEL)
  .then((tri) => {
    patch({ triage: tri });
  })

// After:
triage(bundle, MONGODB_PROFILE, llm, MODEL, state.map)
  .then(({ result: tri, usage: classifyUsage }) => {
    patch({ triage: tri, classifyUsage });  // classifyUsage is new optional WizardState field
  })
```

`launcher` is already available in `useWizard()` but is not currently destructured in Step4Confirm.tsx line 75. The Slugger is not async (no launcher call needed) — it is constructed from `state.map` directly. Add `launcher` to the destructure for future use, but the triage slugger parameter is the synchronous TS replacer.

Note: `state.classifyUsage` is a new optional `WizardState` field (`classifyUsage?: Usage`) that must be added alongside `imageAcknowledgedIds` and persisted in `serialize.ts`.

---

## 10. Trust, Confidence, Sufficiency — Motivating .msg → Directional-Estimate

### Signal Paths for the Motivating .msg

| Signal | Before | After |
|---|---|---|
| `cluster.shardCount` | BLOCKED (scalar from image, dropped at llm.ts:95) | scalar panel in ARTIFACT_SCHEMA → `readArtifactImage` emits BindingResult(scalar, 3, method:vision, conf:0.9) |
| `node.hoVcpu` | BLOCKED (same reason) | `node.atlasTier='M80'` enum panel → tier-lookup synthesis → BindingResult(32, method:table-lookup, conf:1.0, cap:1.0) → satisfied |
| `node.drVcpu` | BLOCKED (no path) | synthesized from same `node.atlasTier` binding → BindingResult(32, method:table-lookup, conf:1.0) → note 'assumed same tier — verify' |
| `util.primary` | BLOCKED (one of 9 panels captured, rest dropped) | multiple avgPeak panels in ARTIFACT_SCHEMA → assignRoles maps 'System CPU - node1 (highest load)' to primary → BindingResult(0.18/0.45, method:vision, conf:0.85) |
| `util.hoSec` | BLOCKED | same image, secondary panel → BindingResult(method:vision, conf:0.85) |
| `util.dr` | BLOCKED | same image, DR panel → BindingResult(method:vision, conf:0.85) |

After the fix: all 6 required signals bound. effectiveConfidence for vision signals = min(0.85, 0.7 cap) = 0.70. engFloor = 0.80. Vision-bound signals are `partial`, not `missing`. No required signal is `missing`. Therefore: `tier = 'directional-estimate'` (not blocked). The motivating .msg goes BLOCKED → directional-estimate.

Table-lookup signals (`node.hoVcpu`, `node.drVcpu`): effectiveConfidence = min(1.0, 1.0 cap) = 1.0 → `satisfied`.

The tier cannot be engineering-grade because vision cap (0.70) < engFloor (0.80) for the three util signals. This is correct and intentional per the sufficiency design.

### Why the Golden Tests Don't Drift

The existing Northwind test (native CSV path): heuristics bind all signals via `numeric-series` (TRUST=6) and `keyvalue` (TRUST=5). No new code paths run for heuristics-only bundles. Numbers unchanged.

The existing vision golden test (queuedVisionMock): the mock responses change shape (from `{signalId, avgPct, peakPct}` to `{panels:[{...}], qualContext:[]}`), but the same signal values are returned. The TriageResult bindings are identical in content; only the code path changes. The golden assertions (`NORTHWIND_SIZING`, `directional-estimate`) continue to pass.

---

## 11. File-by-File Change List

### New Files

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/qual-context.ts`
Exports: `QualContextCategory`, `QualContextItem` (with `source: string` field), `QualContext`, `emptyQualContext()`, `mergeQualContexts()`.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/llm-schemas.ts`
Exports: `ARTIFACT_SCHEMA` (multi-panel with `numericValue`/`strValue` fields), `TEXT_SCHEMA` (bindings with explicit typed fields + qualContext). Both use `additionalProperties: false` throughout.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/role-assign.ts`
Exports: `RoleToken`, `PanelRoleInput`, `RoleAssignment`, `assignRoles()`. Pure, no LLM. `heuristicLabels` field signals fallback use.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/tier-lookup.ts`
Exports: `tierToVcpu()`, `KNOWN_TIERS`. Pure, default-params to ENGINE_CONFIG.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/role-assign.test.ts`
New test file covering labeled/unlabeled/load-sort/positional/dedup scenarios.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/tier-lookup.test.ts`
New test file covering all 10 known tiers, unknown tier, case-folding, `M30_LOW_CPU → undefined`.

### Modified Files

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/llm.ts`
- Remove `CHART_SCHEMA` and `readChartImage`.
- Keep `PROSE_SCHEMA` and `classifyProse` as deprecated exports for one PR cycle; delete in a separate follow-up.
- Add `readArtifactImage(llm, img, schema, model, slugger?): Promise<{bindings, qualContext, usage}>`.
  - Uses ARTIFACT_SCHEMA.
  - Iterates `panels` array; validates per-entry (avgPeak range + avg<=peak, scalar sanity, enum non-empty, unknown signalId dropped).
  - Calls `assignRoles` only for `util.*` panels.
  - Injects `source` into each QualContextItem from `img.source`.
  - Applies Slugger to all QualContextItem.text fields (synchronous).
  - Returns `{bindings, qualContext: {items: qualItems}, usage: res.usage}`.
- Add `classifyText(llm, p, schema, model): Promise<{bindings, qualContext, usage}>`.
  - No Slugger parameter (text is already slugged).
  - Uses TEXT_SCHEMA.
  - Accepts all valueKinds from schema.
  - Injects `source` from `p.source`.
  - Returns `{bindings, qualContext: {items: qualItems}, usage: res.usage}`.
- Keep `toBase64` helper unchanged.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/triage.ts`
- Import `readArtifactImage`, `classifyText` (replacing `readChartImage`, `classifyProse`).
- Import `QualContext`, `QualContextItem`, `mergeQualContexts` from `./qual-context`.
- Import `tierToVcpu` from `./tier-lookup`.
- Import `ENGINE_CONFIG` from `../engine/config`.
- Import `MapEntry` from `../anon/mapping`; `expandEntries`, `orderedForward` from same.
- Add `anonMap?: MapEntry[]` parameter to `triage()`.
- Change return type to `Promise<{ result: TriageResult; usage: Usage }>`.
- Add `totalUsage: Usage = { inputTokens: 0, outputTokens: 0 }`.
- Build `slugger` from `anonMap`: `const slugger = anonMap ? makeSlugger(anonMap) : (s: string) => s`.
- Add `qualItems: QualContextItem[]` accumulator.
- Image branch: `const { bindings: got, qualContext: imgCtx, usage: u } = await readArtifactImage(llm, p, schema, model, slugger)`. Accumulate.
- Text branch: `const { bindings: got, qualContext: txtCtx, usage: u } = await classifyText(llm, p, schema, model)`. Accumulate.
- After all candidates accumulated, run tier-lookup synthesis (see §4g).
- Set `result.roleWarning` from synthesis step.
- Return `{ result: { profileId, inventory, bindings, qualContext: { items: qualItems } }, usage: totalUsage }`.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/types.ts`
- Import `QualContext` from `./qual-context`.
- Add `qualContext?: QualContext` to `TriageResult`.
- Add `roleWarning?: string` to `TriageResult`.

`/mnt/c/Users/rickh/GitHub/caseforge/src/engine/config.ts`
- Add `atlasTierVcpu: Record<string, number>` to `EngineConfig` interface.
- Add `atlasTierVcpu` table to `ENGINE_CONFIG` with source citation comment.

`/mnt/c/Users/rickh/GitHub/caseforge/src/profile/mongodb.ts`
- Add `node.atlasTier` signal to `recommended` array (see §4g spec above for exact fields).
- Aliases: `['instance size', 'cluster tier', 'atlas tier', 'instancesize', 'tier']` — NO tier code strings.

`/mnt/c/Users/rickh/GitHub/caseforge/src/orchestrate/prose.ts`
- Import `QualContext` from `../classify/qual-context`.
- `buildProseContext(d, qualContext?: QualContext): string` — add optional parameter; append CUSTOMER CONTEXT section when non-empty (20-item cap, 200-char truncation per item).
- `generateProse(docModel, llm, model, instruction?, qualContext?): Promise<{prose, usage}>` — add optional parameter; pass to `buildProseContext`; append per-deliverable weaving instructions to system prompt.

`/mnt/c/Users/rickh/GitHub/caseforge/src/orchestrate/index.ts`
- Add `anonMap?: MapEntry[]` and `qualContext?: QualContext` and `classifyUsage?: Usage` to `RunConfig`.
- Pre-triage budget guard (see §9).
- Destructure `{ result: tri, usage: classifyUsage }` from triage call.
- `recordUsage(budget, 'classify', classifyUsage)` when LLM ran; `recordSkipped` otherwise.
- Thread `tri.qualContext` to `generateProse`.
- Dynamic estimate for generate budget guard (see §9).

`/mnt/c/Users/rickh/GitHub/caseforge/src/orchestrate/gate.ts`
- `applyGateAnswers` already spreads triage (`{...triage, bindings: merged}`) so `qualContext` and `roleWarning` propagate automatically. No code changes needed.
- `buildGateData`: add optional role-assign gate item emission when `triage.roleWarning` is set. A `GateItem` with `signalId: 'role-assign'` and `collectRequest: triage.roleWarning`.

`/mnt/c/Users/rickh/GitHub/caseforge/src/ui/state.ts`
- Add `imageAcknowledgedIds: string[]` to `WizardState` (after `imagesReviewed`).
- Add `classifyUsage?: Usage` to `WizardState`.
- `initialWizardState()`: set `imageAcknowledgedIds: []`.
- `stepValidity()`: update `anonOk` as specified in §8.
- Export `imagePrimSources(bundle?: EvidenceBundle | null): string[]` helper used in stepValidity and tests.

`/mnt/c/Users/rickh/GitHub/caseforge/src/ui/steps/Step3Anonymize.tsx`
- Add `toggleAcknowledge(id: number, source: string)` function.
- Per-image acknowledge checkbox in figcaption.
- `anonymizeAll()`: change `patch({..., imagesReviewed: true})` to `patch({..., imagesReviewed: true, imageAcknowledgedIds: []})`.
- Back-nav recovery useEffect: add `imageAcknowledgedIds: []` to the reset patch.
- Count indicator for X/Y reviewed.

`/mnt/c/Users/rickh/GitHub/caseforge/src/ui/steps/Step4Confirm.tsx`
- Destructure `{ result: tri, usage: classifyUsage }` from `triage()` call.
- Add `state.map` as the `anonMap` parameter to `triage()`.
- Add `launcher` to the `useWizard()` destructure (for future async slugger support).
- `patch({ triage: tri, classifyUsage })`.
- Display `roleWarning` banner when `tri.roleWarning` is set.

`/mnt/c/Users/rickh/GitHub/caseforge/src/archive/serialize.ts`
- Add `imageAcknowledgedIds: state.imageAcknowledgedIds` to `stateJson` (serialize path, ~line 115).
- Add `classifyUsage: state.classifyUsage` to `stateJson`.
- Deserialize path: `imageAcknowledgedIds: (stateJson.imageAcknowledgedIds as string[] | undefined) ?? []`.
- Deserialize path: `classifyUsage: stateJson.classifyUsage as Usage | undefined`.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/triage.test.ts`
- All `triage()` calls → destructure `{ result }`.
- Update `recordingMock` to return ARTIFACT_SCHEMA shape for image calls and TEXT_SCHEMA shape for text calls (including the `DR CPU` panelLabel that triggers `roleTokenOf` → 'dr').
- The 'exactly 2 LLM calls' assertion at line 150 is preserved (one call per image, one per text).
- Add: tier-lookup synthesis test (M80 → hoVcpu=32, method=table-lookup).
- Add: unknown tier (M999 → no hoVcpu binding from this path).
- Add: vision hoVcpu candidate filtered when tier-lookup fires.
- Add: qualContext accumulation from both image and text primitives.
- Add: F1 re-slug test (qualContext item containing a map-entry phrase → slug in output).
- Update `readChartImage` test references to `readArtifactImage`.
- Update `classifyProse` test references to `classifyText`.

`/mnt/c/Users/rickh/GitHub/caseforge/src/classify/northwind-classify.golden.test.ts`
- Both `triage()` calls → destructure `{ result }`.
- Update `queuedVisionMock` responses to ARTIFACT_SCHEMA shape: `{ panels: [{ kind: 'avgPeak', panelLabel: 'System CPU', signalId: 'util.primary', avgPct: 0.18, peakPct: 0.45, confidence: 0.85 }], qualContext: [] }` (and corresponding hoSec/dr entries for subsequent calls).
- Add third test: 'motivating .msg scenario — multi-panel dashboard + scalar form screenshot + email text → directional-estimate (not blocked)'. Mock returns: form image → panels with `cluster.shardCount scalar 3`, `node.atlasTier enum M80`, `util.primary avgPeak 0.18/0.45`, `util.hoSec avgPeak 0.12/0.35`, `util.dr avgPeak 0.08/0.20`; email text → `qualContext: [{text: 'CFO needs payback under 2 years', category: 'concern'}]`. Asserts: verdict.tier === 'directional-estimate', toSizingInputs produces inputs with shards=3 hoVcpu=32 drVcpu=32.

`/mnt/c/Users/rickh/GitHub/caseforge/src/orchestrate/index.test.ts`
- Line 106: `const { result: precomputed } = await triage(fullBundle, MONGODB_PROFILE)`.
- Update 'fires onCheckpoint' test: classify checkpoint is now a real `recordUsage` entry (not skipped) when `llm` is provided. Since the test uses heuristics-only (no image calls), `classifyUsage` will be `{inputTokens:0, outputTokens:0}` — the checkpoint exists but has zero tokens.
- The 'reuses a caller-precomputed triage' test: the `precomputed` variable is now correctly typed as `TriageResult` after destructuring. Assert still passes.

`/mnt/c/Users/rickh/GitHub/caseforge/src/engine/config.test.ts` (if it exists, or add assertions to existing test)
- Assert `ENGINE_CONFIG.atlasTierVcpu['M80'] === 32`.
- Assert `ENGINE_CONFIG.atlasTierVcpu['M140'] === 48`.
- Assert `ENGINE_CONFIG.atlasTierVcpu['M300'] === 96`.
- Assert `tierToVcpu('M999', ENGINE_CONFIG.atlasTierVcpu) === undefined`.
- Assert `tierToVcpu('m80', ENGINE_CONFIG.atlasTierVcpu) === 32` (case-folding).

---

## 12. TDD Test Plan

### Phase A — Pure Types and Config (no LLM, no DOM)

- `qual-context.ts`: `mergeQualContexts` concatenates; `emptyQualContext` returns `{items:[]}`.
- `tier-lookup.ts`: all 10 known tiers correct; M999 → undefined; 'm80' → 32; 'M30_LOW_CPU' → undefined.
- `config.ts`: M80=32, M140=48, M300=96 assertions.
- `role-assign.ts`: explicit tokens; single unlabeled → primary; multiple unlabeled sorted by peakPct; duplicate token resolved by peakPct; `heuristicLabels` populated correctly.
- All existing tests pass.

### Phase B — LLM Seam Unit Tests (mocked LLM, no DOM)

- `readArtifactImage`: multi-panel → multiple bindings; avgPeak validation (avg>peak dropped, out-of-range dropped); inverted avgPeak (0.45/0.18) dropped; scalar from form image; enum M80; unknown signalId dropped; qualContext re-slugged via injected Slugger (phrase → slug); parse failure → empty return; usage returned.
- `classifyText`: scalar extraction; enum extraction; qualContext extraction (all 4 categories); non-schema signalId dropped; llm-text scalars don't displace numeric-series by trust rank.
- `triage.test.ts`: update all call sites; 'exactly 2 LLM calls' assertion preserved; tier-lookup synthesis tests; qualContext accumulation; F1 re-slug test.

### Phase C — Golden Tests (determinism anchors)

- `northwind-classify.golden.test.ts` test 1 (vision mock): update mock shape, assert directional-estimate + NORTHWIND_SIZING unchanged.
- `northwind-classify.golden.test.ts` test 2 (heuristics only): no change.
- `northwind-classify.golden.test.ts` test 3 (NEW — motivating .msg): assert directional-estimate, shards=3, hoVcpu=32, drVcpu=32.
- Engine goldens (`northwind-sizing.golden.test.ts`, `northwind.golden.test.ts`): no change.

### Phase D — Orchestrate and Prose

- `index.test.ts` line 106 destructure fix.
- Classify checkpoint: verify `budgetLog.some(c => c.stage === 'classify' && !c.skipped)` when LLM ran.
- Pre-triage guard: assert pipeline returns error when `budgetLimit.tokens = 1` (too small to classify).
- qualContext threading: mock `generateProse` to capture context string; assert 'CUSTOMER CONTEXT' present when qualContext non-empty.
- `prose.ts`: `buildProseContext` with qualContext → CUSTOMER CONTEXT section present; empty qualContext → section absent; 20-item cap enforced; 200-char truncation enforced.

### Phase E — State/UI (pure stepValidity, no DOM)

- `state.ts`: `stepValidity[3]` is false when images exist and `imageAcknowledgedIds` is empty; false when some but not all acknowledged; true when all acknowledged; true when no images.
- `initialWizardState()` has `imageAcknowledgedIds: []`.
- `imagePrimSources` helper returns correct keys.

### Phase F — Archive Round-Trip

- `serialize.test.ts`: add round-trip test asserting `imageAcknowledgedIds` and `classifyUsage` are preserved (serialize → deserialize → same values); old archives without the fields → deserialize produces `[]` / `undefined`.

### What Still Needs a Manual Browser/Vision Check

- `readArtifactImage` with a real dark/dense Atlas dashboard screenshot (tesseract OCR quality on these images is known-bad; the vision model may also struggle).
- Per-image acknowledge checkbox renders and gates Next button correctly in the browser.
- Go launcher vs TS Slugger equivalence test (see §7) requires both processes to run; add to integration test suite, not unit test suite.
- `recognizeWords` (tesseract.js) and canvas/redaction cannot run under jsdom/CI — tested manually via the existing browser test workflow.

---

## 13. Build Sequencing and Remaining Micro-Decisions

### PR-A — Types and Config (no behavior change)
Checklist:
- [ ] `qual-context.ts` + unit tests
- [ ] `tier-lookup.ts` + unit tests
- [ ] `role-assign.ts` + unit tests
- [ ] `EngineConfig.atlasTierVcpu` interface + table in `config.ts`
- [ ] `node.atlasTier` signal in `mongodb.ts`
- [ ] `TriageResult.qualContext?` and `TriageResult.roleWarning?` in `types.ts`
- [ ] All existing tests pass

### PR-B — LLM Schemas + readArtifactImage + classifyText
Checklist:
- [ ] `llm-schemas.ts` (ARTIFACT_SCHEMA, TEXT_SCHEMA with numericValue/strValue)
- [ ] `readArtifactImage` in `llm.ts` (including Slugger parameter, source injection, assignRoles for util.* only)
- [ ] `classifyText` in `llm.ts` (no Slugger, source injection)
- [ ] Old functions kept as deprecated exports
- [ ] Unit tests for both new functions (all validation cases including avg>peak)

### PR-C — Triage Wiring + triage() API Change (ATOMIC — all callers in same PR)
Checklist:
- [ ] `triage()` return type → `{result, usage}`
- [ ] Accumulate qualItems + totalUsage in triage.ts
- [ ] Tier-lookup synthesis (hoVcpu + drVcpu, with vision-hoVcpu candidate removal)
- [ ] roleWarning set on result
- [ ] anonMap/slugger parameter wired
- [ ] `triage.test.ts` — all call sites destructured
- [ ] `northwind-classify.golden.test.ts` — both calls destructured; test 3 added
- [ ] `orchestrate/index.test.ts` line 106 destructured
- [ ] `Step4Confirm.tsx` — destructure + state.map + classifyUsage storage
- [ ] Golden tests pass (test 3 must pass at directional-estimate)

### PR-D — Prose + Orchestrate
Checklist:
- [ ] `buildProseContext` qualContext parameter + CUSTOMER CONTEXT section (20-item cap, 200-char truncation)
- [ ] `generateProse` qualContext parameter + per-deliverable weaving instructions
- [ ] `index.ts` pre-triage budget guard + classify recordUsage + qualContext threading + dynamic generate estimate
- [ ] `RunConfig` new fields (anonMap, qualContext, classifyUsage)
- [ ] `gate.ts` role-assign gate item emission
- [ ] `index.test.ts` classify checkpoint assertion updated
- [ ] `prose.ts` unit tests

### PR-E — D2 Step3 Gate UX + Archive Persistence
Checklist:
- [ ] `state.ts` imageAcknowledgedIds + classifyUsage fields + stepValidity update
- [ ] `Step3Anonymize.tsx` per-image acknowledge checkbox + anonymizeAll reset + back-nav reset + count indicator
- [ ] `serialize.ts` persist imageAcknowledgedIds + classifyUsage + backward-compat deserialization
- [ ] `serialize.test.ts` round-trip test
- [ ] `state.ts` unit tests for stepValidity gating

### Remaining Micro-Decisions

1. **Deprecated function removal**: `readChartImage` and `classifyProse` are kept as deprecated exports in PR-B and removed in a separate cleanup PR after all callers have migrated. This avoids a single massive PR touching both the new functions and all test updates.

2. **drVcpu synthesis gate**: the current design synthesizes `node.drVcpu` from `node.atlasTier` when no higher-trust binding exists. If a customer has genuinely different DR tier (e.g. M80 home, M50 DR), the form screenshot would need a second `node.drAtlasTier` signal to distinguish. For v1 the design synthesizes from the same tier with an explicit note. A future `node.drAtlasTier` signal is non-blocking follow-up.

3. **Go launcher vs TS Slugger equivalence test**: document as a known gap and add to the integration test queue. Until the test passes, the TS Slugger is "best-effort same map" not "guaranteed equivalent." Acceptable given D2 human backstop.

4. **Invite the vision model to self-identify panel count**: the current prompt says "For EVERY visible panel..." but gives no hint about expected count. A monitoring dashboard known to have 3x3=9 panels would benefit from `(expect 9 panels in this 3x3 grid)`. This is a prompt-tuning detail that can be refined after the schema infrastructure is in place, without code changes.
