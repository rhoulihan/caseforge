# Sample: "Northwind Mutual" demo artifacts

**Fictional** customer data for trying CaseForge end-to-end. Northwind Mutual Insurance,
Jane Okafor, the hostnames/IPs, and the numbers are all invented.

## What's here
- `customer-email.txt` — a workload-description email. Exercises **anonymization** (it names a
  company, a person + email, and hostnames/IPs that the detector should catch) and gives prose
  the classifier can read.
- `topology.csv` — shard count, vCPU per node (primary/DR), logical + on-disk data size.
- `cpu-utilization.csv` — primary / secondary / DR CPU% over time, with a month-end spike (so the
  peak-to-average ratio is meaningful).

## How to use
1. Launch CaseForge (`./scripts/run-local.sh`, or a packaged build) and open the wizard.
2. **Setup:** pick a provider, paste your API key, company name `Northwind Mutual Insurance`.
3. **Drop files:** drag all three files from this folder in.
4. **Anonymize:** confirm the detected map (Northwind Mutual Insurance, Jane Okafor,
   db-prod-01.nw.local, 10.20.30.40, …) — all replaced with slugs before any AI call.
5. **Confirm → Generate → Refine → Export.** You should land at a Directional-or-better estimate
   and three deliverables.

Nothing here leaves your machine un-anonymized.
