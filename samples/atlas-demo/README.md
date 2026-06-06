# Atlas demo fixture — Meridian Freight Systems (fictional)

A sample set of artifacts for a **MongoDB Atlas** (managed-cloud) customer, used to design and (later)
test the **Atlas source profile**. All data is fictional and illustrative.

| File | What it is | Role in CaseForge |
|---|---|---|
| `cluster-describe.json` | Atlas Admin API v2 *describe cluster* output | **Topology** → shards, instance tier (M50 → 8 vCPU), node counts, regions, disk |
| `atlas-invoice.csv` | Itemized monthly Atlas invoice (sums to $29,000/mo ≈ $348K/yr) | **Current cost** — parsed directly (the Atlas equivalent of the on-prem TCO build-up) |
| `cpu-utilization.csv` | CPU utilization time series (primary / secondary / DR) | **Sizing** → util.primary / util.hoSec / util.dr (avg + peak) |
| `customer-email.txt` | Context email from the customer | Narrative + anonymization-detection exercise |

**Scenario:** 3-shard sharded cluster, M50 (8 vCPU / 32 GB) per node, home `us-east-1` (3 electable/shard),
cross-region warm DR in `us-west-2` (2 electable/shard); ~1.8 TB logical data; ~$348K/yr Atlas spend.

> **Status:** This fixture exercises the proposed Atlas source profile, which is **not yet implemented**
> (today CaseForge ships only the self-managed MongoDB profile). See
> [`docs/ATLAS-SOURCE-PROFILE.md`](../../docs/ATLAS-SOURCE-PROFILE.md) for what the engine needs to support it.
> The key difference from the on-prem flow: the **current cost comes from the invoice** (deterministic),
> not from web-researched license/hardware/facility/labor components.
