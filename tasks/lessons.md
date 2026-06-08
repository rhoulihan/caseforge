# Lessons

## 2026-06-08 — A dominant output driver is a *required* input, not an optional enhancement

**Context:** Investigating the storage-estimate default. I correctly found that storage was
classified `recommended` in code and framed the fix as "let the rep optionally enter it / surface a
warning." Rick corrected: "storage is a required sizing item. this needs to be corrected."

**Pattern / mistake:** I described the current (wrong) classification as if it were the design intent,
then offered "make it rep-enterable" as merely *one* fix option. When a value drives a dominant or
authoritative output (storage = ~79% of the TCO bill, plus the cold-DR RTO), the primary question is
**"should this be required (gated, blocking)?"** — not "how do we let the rep optionally supply it."

**Rule:** When auditing inputs, classify each by its **blast radius on the output**, not just its
current code criticality. If a missing value would silently corrupt a headline number, treat
"promote to required + gate it" as the default proposal and lead with it — don't soft-pedal a required
input as an optional upgrade or a warning string.
