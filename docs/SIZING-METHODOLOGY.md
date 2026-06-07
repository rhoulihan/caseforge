# CaseForge — Sizing & TCO Methodology

How CaseForge turns a customer's MongoDB workload into an Oracle Autonomous Database (ADB) sizing and a
five-year business case. **Every number below is computed deterministically in code** (`src/engine/`); the
AI is used only to research current list prices, read chart images, and write prose — it never produces an
authoritative figure.

> _Updated 2026-06-07._ The numeric constants this model relies on (the headroom divisor, autoscale
> multipliers, DR restore rate, the consumed-vCPU→ECPU ratio, and ADB list rates) are centralized in one
> adjustable configuration — **`src/engine/config.ts`** (`ENGINE_CONFIG`) — so they can be updated in a
> single place when Oracle pricing or guidance changes. Each engine function defaults to these values but
> accepts an override argument, so tests (and the MongoDB Atlas source profile) can vary a single knob
> without forking the math. See §7 for the full table.

## 1. Sizing (compute)

CaseForge sizes **provisioned ECPU** for ADB from the customer's measured MongoDB topology and utilization.

**Consumed ECPU** for a role is consumed vCPU scaled by the configured `ecpuPerVcpu` ratio (Phase-1 = 1:1):

```
consumed = shards × vCPU_per_node × utilization% × ecpuPerVcpu
```

evaluated at both **average** and **peak** utilization. For the **`fullcluster`** scope, the primary,
home-region secondary, and DR roles are summed; for the **`workload`** scope, only the primary role is
counted. (`consumedEcpu`, `src/engine/sizing.ts`.)

**Provisioned base** applies a headroom rule — provision for a fraction of peak, but never below average so
the database isn't continuously bursting:

```
base = ceil( max( Peak / n , Average ) )
```

where `n` is the peak-headroom divisor (`conservativeDivisor` = 2, or `aggressiveDivisor` = 3).
**Autoscale ceilings** are set at the configured multipliers — **2×** and **3×** the base — the band ADB
auto-scaling is allowed to use. (`baseFor`, `ceilings`.)

## 2. TCO (cost)

**On-prem annual cost** is the sum of its components at the chosen estimate level (`low` / `central` /
`high`):

```
onprem = sum( onpremComponents[level] )      // license + hardware + storage + facility + labor + backup + …
```

**ADB annual cost** is the primary subscription plus the added cost of the chosen DR posture:

```
adb = adbPrimary + { cold: coldDrAdd, warm: warmDrAdd, none: 0 }
```

**Annual saving** = `onprem(central) − adb(central)`, also expressed as a percentage of on-prem.
(`onpremTotal`, `adbTotal`, `annualSaving`, `src/engine/tco.ts`.)

## 3. Five-year business case

Two cost streams are compared over five years:

- **A — Migrate:** Year 1 = on-prem renewal + ADB primary prove-out + one-time migration services
  (`onprem + adbPrimary + migrationPs`); Years 2–5 = steady-state ADB with the chosen DR posture.
- **B — Status quo:** on-prem cost every year.

From these:

- **Net 5-year saving** = `sum(B) − sum(A)` at the central level.
- **Payback year** = the first year (after Year 1) where cumulative migrate cost ≤ cumulative status-quo
  cost (`null` if it never pays back). (`fiveYear`, `net5`, `paybackYear`.)

## 4. Disaster recovery

- **Cold (backup-based) RTO** = `ceil( coldRtoBaseHours + dataTB × coldRtoHoursPerTb )` hours — by default a
  one-hour base plus one hour per 5 TB (`0.2 h/TB`).
- **Warm** DR carries a standby and so adds the `warmDrAdd` cost but a much lower RTO.
  (`coldRtoHours`, `src/engine/dr.ts`.)

## 5. Confidence & sufficiency

CaseForge never silently guesses. Each required signal is classified by how it was obtained, and the data
intake is graded:

- **Blocked** — a required signal is missing; the report lists exactly what to ask the customer for.
- **Directional estimate** — enough to size, but some inputs rest on assumptions or lower-confidence
  evidence (e.g. a value read from a chart image). A signal that defaults to an assumption can never be
  graded engineering-grade.
- **Engineering-grade** — all required signals come from authoritative, native evidence.

Researched cost figures are capped at *medium* confidence, so a market-researched price can never be
presented as authoritative without the rep confirming it.

## 6. Data sources

- **Customer workload telemetry** — topology (shards, vCPU per node, DR cores) and utilization
  (average / peak / P95), parsed locally from the artifacts the customer provides. Only the rep-approved,
  anonymized content ever reaches the AI.
- **Oracle ADB list pricing** — ECPU and storage rates used for the ADB cost lines. These are researched
  at run time (and confirmed by the rep) or supplied as the `ENGINE_CONFIG.adb` defaults.
- **On-prem TCO inputs** — license / hardware / storage / facility / labor / backup. The values shipped in
  the golden fixtures are **illustrative figures for a fictional reference customer**, used only to pin the
  deterministic tests — not a real customer.
- **MongoDB Atlas source profile** — when the source is Atlas, the same topology and cost signals are
  re-sourced from an Atlas-exported profile (a tier→vCPU lookup supplies cores; the invoice monthly total is
  the authoritative current cost). See [`ATLAS-SOURCE-PROFILE.md`](./ATLAS-SOURCE-PROFILE.md) and the
  runnable `samples/atlas-demo` fixture.

## 7. Tunable constants — `src/engine/config.ts`

The knobs most likely to change as Oracle pricing and guidance evolve are centralized in a single,
documented configuration object — **[`src/engine/config.ts`](../src/engine/config.ts)** (`ENGINE_CONFIG`).
Edit them there (one place) when an update arrives from the Oracle team, refresh the golden tests in the
same change (a deliberate, reviewable record of the pricing/guidance update), and rebuild. The engine
functions default to these values but accept an override argument, so tests — and the Atlas source profile —
can vary a single knob without forking the math.

| Constant (`ENGINE_CONFIG.*`) | Role | Default | Source |
|---|---|---|---|
| `adb.ecpuPerHr` | ADB compute cost line | **$0.0807 / ECPU-hr** | Oracle ADB list pricing |
| `adb.storagePerGbMo` | ADB storage cost line | **$0.1156 / GB-mo** | Oracle ADB list pricing |
| `adb.hoursPerMonth` | annualize the ECPU rate | **730** | 365×24/12 (standard billing month) |
| `sizing.conservativeDivisor` | `base = ceil(max(Peak/n, Avg))` | **2** (Peak÷2) | CaseForge provisioning model (§1) |
| `sizing.aggressiveDivisor` | aggressive base | **3** (Peak÷3) | CaseForge provisioning model (§1) |
| `sizing.autoscaleMultipliers` | autoscale band on the base | **[2, 3]** (2× / 3×) | CaseForge provisioning model (§1) |
| `sizing.ecpuPerVcpu` | consumed vCPU → ECPU | **1** (1:1, Phase-1) | CaseForge sizing assumption |
| `dr.coldRtoBaseHours` | cold-DR restore base | **1 h** | Oracle backup-restore rule of thumb |
| `dr.coldRtoHoursPerTb` | cold-DR restore per-TB | **0.2 h/TB** (= 1 h / 5 TB) | Oracle backup-restore rule of thumb |

A drift-guard unit test (`src/engine/config.test.ts`) pins these documented defaults and confirms each
engine function both reads the config and honors an override, so an unintended change to a rate fails CI
rather than slipping out silently.

The five-year stream composition (Year-1 prove-out + one-time migration; Years 2–5 steady-state ADB) is
structural and lives in `src/engine/tco.ts` (§3), not in the constant table. The on-prem TCO component
estimates (license/hardware/facility/labor/…) are *customer-specific* — researched or rep-supplied at run
time — and are deliberately **not** in this config (they are not Oracle formula constants). The proposed
MongoDB **Atlas** source profile *would* add an Atlas tier→vCPU lookup table (M10–M300) to this same
adjustable config — that work is analyzed but **not yet implemented** (`src/engine/config.ts` currently
holds only `{adb, sizing, dr}`); see [`ATLAS-SOURCE-PROFILE.md`](./ATLAS-SOURCE-PROFILE.md) §4.
