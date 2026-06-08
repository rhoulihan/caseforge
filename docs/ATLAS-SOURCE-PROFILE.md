# Supporting a MongoDB Atlas customer — engine analysis

> **Updated 2026-06-07.** Re-verified against the code through the v0.4.0-pending tree. The proposed
> Atlas source profile is **still not implemented** — CaseForge today ships only the self-managed
> MongoDB profile (`src/profile/mongodb.ts`). This remains a design spec plus a runnable demo fixture
> ([`samples/atlas-demo/`](../samples/atlas-demo/)); every concrete claim below was checked against the
> current source.

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
| Profile contract | `SourceProfile`, `SignalSpec`, `DerivationMethod` (`src/profile/types.ts`) | Already profile-agnostic — `table-lookup` is even documented as "e.g. Atlas tier -> vCPU". |
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
   re-sourced — `node.hoVcpu`/`drVcpu` come from a **tier→vCPU lookup table** (M10–M300; see §4) keyed on
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
(see [`SIZING-METHODOLOGY.md`](./SIZING-METHODOLOGY.md) §7), the same `src/engine/config.ts` seam that now
centralizes the ADB sizing + cost constants.

| Tier | vCPU | RAM (GB) | Tier | vCPU | RAM (GB) |
|---|---|---|---|---|---|
| M10 | 2 | 2 | M60 | 16 | 64 |
| M20 | 2 | 4 | M80 | 32 | 128 |
| M30 | 2 | 8 | M140 | 48 | 192 |
| M40 | 4 | 16 | M200 | 64 | 256 |
| M50 | 8 | 32 | M300 | 96 | 384 |

(M10/M20 are burstable; M30+ are production tiers. "Low-CPU" variants have half the vCPU of the same size.)

## 5. Worked example (the `atlas-demo` fixture)

The fixture is **Meridian Freight Systems** (fictional). Its four artifacts map one-to-one onto the
engine's needs:

| Artifact | What it is | Role |
|---|---|---|
| `cluster-describe.json` | Atlas Admin API v2 *describe cluster* output (`GET /api/atlas/v2/groups/{groupId}/clusters/{name}` shape) | **Topology** → `numShards`, `instanceSize` (M50 → 8 vCPU), per-region node counts, disk |
| `atlas-invoice.csv` | Itemized monthly Atlas invoice (sums to ~$29,000/mo ≈ $348K/yr, net of the commitment-discount credit) | **Current cost** — parsed directly (the Atlas equivalent of the on-prem TCO build-up) |
| `cpu-utilization.csv` | CPU utilization time series (System / Secondary / DR columns) | **Sizing** → `util.primary` / `util.hoSec` / `util.dr` (avg + peak) |
| `customer-email.txt` | Context email from the customer (Priya Nair) | Narrative + anonymization-detection exercise |

3-shard M50 cluster (8 vCPU/node), home `us-east-1` (3 electable/shard) + cross-region warm DR in
`us-west-2` (2 electable/shard), ~1.8 TB logical (2,500 GB provisioned disk/node), **~$348K/yr Atlas**:

- **Sizing** (reused, unchanged): `shards=3`, `hoVcpu=8`, `drVcpu=8`, util primary ≈ 48%/70% avg/peak
  (System CPU column; Secondary ≈ 38%/55%, DR ≈ 25%/35%) → the existing Peak÷N model produces the ADB
  ECPU provisioning + autoscale band.
- **Current cost** (new path): the invoice rolls up to `currentCost.compute/storage/backup/dataTransfer/
  addOns/support` (the M50 instance hours, gp3 storage, PITR + snapshot backup, cross-region transfer,
  Atlas Search add-on, Enterprise support, less the annual-commitment credit) summing to ~$348K/yr — used
  verbatim as the status-quo baseline.
- **Everything downstream** (ADB cost, 5-year A/B, payback, DR/RTO, the three deliverables) is the
  existing engine.

The customer email is explicit that the **Atlas bill** is the CFO's number ("base the savings case on
that, not on a hypothetical self-managed build-out"), which is exactly why the Atlas current-cost path is
invoice-parse, not research.

> The same fixture also exercises CaseForge's **anonymization** flow. Real-looking names (Meridian Freight
> Systems, Priya Nair), project/cluster IDs (`meridian-prod`), and regions are candidate phrases the rep
> approves into the fail-closed map before any AI call. Ingest also **extracts embedded raster images** and
> sends them to the LLM's vision model — but, as of the v0.4.0 work, images are sent **as-is** (the local OCR
> redaction experiment was removed): Step 3 shows each image and the rep reviews/excludes it, so were a
> topology/CPU screenshot dropped in alongside these text artifacts, the rep is responsible for ensuring it
> carries no baked-in PII. The Atlas demo today ships only text/CSV/JSON, so no images are sent.

## 6. Scope & open decisions

- **Generalize vs. discriminated union** for `TcoInputs.currentCost`: a single generic `Record` (rename) is
  the smallest change and keeps `currentTotal` a one-liner; a discriminated `OnpremTcoInputs | AtlasTcoInputs`
  is more type-explicit but touches more call sites. *Recommendation: generic `Record` rename.*
- **Invoice parsing**: a deterministic mapper from invoice SKU categories → the 6 Atlas cost keys (the SKUs
  in `atlas-invoice.csv` — e.g. `ATLAS_INSTANCE_M50_AWS`, `ATLAS_DATA_STORAGE_AWS`, `ATLAS_BACKUP_*`,
  `ATLAS_DATA_TRANSFER_CROSS_REGION`, `ATLAS_SEARCH`, `ATLAS_SUPPORT_ENTERPRISE`, `ATLAS_COMMITMENT_DISCOUNT`
  — are the contract). Lives behind the Atlas profile.
- **Overlap with the config-extraction work** (now shipped as `src/engine/config.ts`): the ADB list rates,
  the Peak÷N divisor, and the autoscale multipliers already live in that adjustable config. This Atlas
  tier→vCPU table is the natural next entry — the cost model is the shared seam, so the Atlas profile slots
  onto config that already exists.
- Golden coverage: a new Atlas golden fixture (Meridian) mirroring the Northwind goldens, asserting the
  reused sizing + the parsed current cost flow through to the same payback logic.
