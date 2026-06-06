# Supporting a MongoDB Atlas customer — engine analysis

**Question:** what does the CaseForge engine need in order to size and build a business case for a
customer already on **MongoDB Atlas** (managed cloud), rather than self-managed/on-prem MongoDB?

**Short answer:** very little of the *math* changes. The engine's entire **target side** (Oracle ADB
cost, the Peak÷N sizing model, the five-year status-quo-vs-migrate streams, payback, DR/RTO) is already
source-agnostic. The only thing that's genuinely on-prem-specific is how the **current cost** is
obtained — and for Atlas that's *easier*, because the customer's **monthly invoice is the current cost**
(parsed deterministically) rather than a web-researched build-up of license/hardware/facility/labor.

A worked sample customer lives in [`samples/atlas-demo/`](../samples/atlas-demo/).

---

## 1. What's reusable as-is

| Layer | Pieces | Why it's source-agnostic |
|---|---|---|
| Sizing | `consumedEcpu`, `baseFor`, `ceilings` (`src/engine/sizing.ts`); `SizingInputs` | Inputs are `shards × vCPU × utilization%` per role. Atlas supplies all three (tier→vCPU, metrics→util). |
| TCO target side | `adbTotal`, `annualSaving`, `fiveYear`, `net5`, `paybackYear` (`src/engine/tco.ts`) | Operate on `Range`s; indifferent to how the current-cost number was produced. |
| DR | `coldRtoHours` (`src/engine/dr.ts`) | Pure formula on data size. |
| Profile contract | `SourceProfile`, `SignalSpec`, `DerivationMethod` (`src/profile/types.ts`) | Already profile-agnostic — `table-lookup` is even documented as "e.g. Atlas tier → vCPU". |
| Orchestration | `runPipeline` (`src/orchestrate/index.ts`), `triage`, `toSizingInputs` | Already parameterized by a `SourceProfile`; nothing hardcodes MongoDB. |
| The 6 required sizing signals | `cluster.shardCount`, `node.hoVcpu`, `node.drVcpu`, `util.{primary,hoSec,dr}` | Same signals — just re-sourced from Atlas artifacts. |

**The Source-Profile seam already exists.** Adding Atlas is mostly *new data*, not new engine code.

## 2. What's source-specific (needs an Atlas variant)

Everything below assumes the current cost is a **synthesized on-prem build-up**:

- `TcoInputs.onpremComponents` — a fixed `Record` keyed `license / hardware / storage / facility / labor / backup` (`src/engine/types.ts`).
- The whole **research path** (`src/research/tco.ts`): `ONPREM_COMPONENTS`, the research schema, and the LLM prompt that *web-researches* those six components. For Atlas this is the **wrong shape** — the cost is in the invoice, not the market.
- **Labels/prose**: `ONPREM_LABELS` + cost-chart segment names in `src/render/builders.ts`; "On-prem MongoDB fully-loaded" framing in `src/render/businessCase.ts` and `src/orchestrate/prose.ts`.
- **UI**: `DEFAULT_TCO_INPUTS` and `tcoProfileFromState` (`src/ui/pipeline.ts`) are on-prem-shaped; the profile is hardcoded to `MONGODB_PROFILE`.
- `mongo.edition` signal + several `collectRequest` texts in `src/profile/mongodb.ts` reference Ops Manager / `db.stats()` / `sh.status()` (self-managed tooling).

## 3. Proposed design

**Add an `atlas` `SourceProfile` alongside `mongodb` — do not branch the engine.**

1. **Generalize the current-cost shape.** Rename `TcoInputs.onpremComponents` → a generic
   `currentCost: Record<string, Range>` (the on-prem key-set becomes just one possible set). `onpremTotal`
   becomes `currentTotal` (sum is identical). The Atlas key-set is the invoice's roll-up:
   `{ compute, storage, backup, dataTransfer, addOns, support }` (net of discounts).
2. **Parse the invoice instead of researching it.** For Atlas, the current cost is **derived from the
   uploaded invoice CSV** — deterministic, so it carries `numeric-series`/`keyvalue` confidence, **not**
   the 0.75 research cap. (On-prem keeps the research path.) This is a new, simpler `currentCost`
   derivation, not a change to the research engine.
3. **Atlas signal schema** (`src/profile/atlas.ts`): the 6 required sizing signals are unchanged but
   re-sourced — `node.hoVcpu`/`drVcpu` come from a **tier→vCPU lookup table** (M10–M200; see §4) keyed on
   `instanceSize` in the cluster description; `cluster.shardCount` from `numShards`; `util.*` from the
   metrics export. New `tcoCritical` signals describe the bill: per-role node counts, provisioned storage
   GB, backup GB, add-ons, support tier, and the **invoice monthly total** (the authoritative current cost).
4. **Profile selection.** Add `sourceType: 'mongodb' | 'atlas'` to the wizard (Step 1), and select the
   profile + the current-cost derivation accordingly. `runPipeline` already takes the profile as a param.
5. **Relabel, don't re-math.** Replace the hardcoded `ONPREM_LABELS` / chart segments / prose framing with
   **profile-driven labels** ("Atlas subscription" vs "On-prem MongoDB, fully-loaded"). `TcoSection` itself
   is source-agnostic; only the `currentCost` component labels differ.

Net: the migrate-vs-status-quo five-year story, payback, and sizing are **identical**; the customer just
sees "MongoDB Atlas subscription $348K/yr" as the baseline instead of an on-prem build-up.

## 4. Atlas tier → vCPU/RAM lookup (AWS, illustrative)

The one new constant table. Captured here; in implementation it becomes part of the adjustable config
(see [`SIZING-METHODOLOGY.md`](./SIZING-METHODOLOGY.md) §7).

| Tier | vCPU | RAM (GB) | Tier | vCPU | RAM (GB) |
|---|---|---|---|---|---|
| M10 | 2 | 2 | M60 | 16 | 64 |
| M20 | 2 | 4 | M80 | 32 | 128 |
| M30 | 2 | 8 | M140 | 48 | 192 |
| M40 | 4 | 16 | M200 | 64 | 256 |
| M50 | 8 | 32 | M300 | 96 | 384 |

(M10/M20 are burstable; M30+ are production tiers. "Low-CPU" variants have half the vCPU of the same size.)

## 5. Worked example (the `atlas-demo` fixture)

3-shard M50 cluster (8 vCPU/node), home + cross-region warm DR, ~1.8 TB, **$348K/yr Atlas**:
- **Sizing** (reused, unchanged): `shards=3`, `hoVcpu=8`, `drVcpu=8`, util primary ≈ 38%/70% avg/peak →
  the existing Peak÷N model produces the ADB ECPU provisioning + autoscale band.
- **Current cost** (new path): the invoice rolls up to `currentCost.compute/storage/backup/dataTransfer/
  addOns/support` summing to ~$348K/yr — used verbatim as the status-quo baseline.
- **Everything downstream** (ADB cost, 5-year A/B, payback, DR/RTO, the three deliverables) is the
  existing engine.

## 6. Scope & open decisions

- **Generalize vs. discriminated union** for `TcoInputs.currentCost`: a single generic `Record` (rename) is
  the smallest change and keeps `currentTotal` a one-liner; a discriminated `OnpremTcoInputs | AtlasTcoInputs`
  is more type-explicit but touches more call sites. *Recommendation: generic `Record` rename.*
- **Invoice parsing**: a deterministic mapper from invoice SKU categories → the 6 Atlas cost keys (the SKUs
  in `atlas-invoice.csv` are the contract). Lives behind the Atlas profile.
- **Overlap with the config-extraction task**: the ADB list rates, the Peak÷N divisor, the autoscale
  multipliers, **and** this Atlas tier→vCPU table all become entries in the same adjustable config — so the
  Atlas profile and the config-extraction work are best done together (the cost model is the shared seam).
- Golden coverage: a new Atlas golden fixture (Meridian) mirroring the Northwind goldens, asserting the
  reused sizing + the parsed current cost flow through to the same payback logic.
