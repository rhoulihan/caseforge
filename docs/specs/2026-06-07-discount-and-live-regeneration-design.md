# Design Spec — CaseForge: Customer Discount & Always-Current Regeneration

**Date:** 2026-06-07 · **Status:** Proposed (design — not yet implemented) · **Author:** Rick Houlihan + Claude<br>
**One-line:** Add a per-case customer discount to the cost model, and make "regenerate" always recompute the numbers with the *current* sizing/cost settings (not the figures frozen at first generation) — so a refined or reopened case reflects today's rates, today's formula config, and the rep's current discount.

> This is a prerequisite for the [business-case archives](./2026-06-07-business-case-archives-design.md) feature: an archived case can be old, so reopening and refining it must refresh the numbers to current rates rather than replay stale ones.

---

## 1. Motivation

Two coupled gaps in today's behavior:

1. **Numbers freeze at first generation.** Step 6 "Regenerate prose" reuses the `docModel` numbers and only rewrites prose (`generateProse` on the same model). If the engine's cost/sizing constants (`src/engine/config.ts`, centralized in v0.4.0) change — new Oracle ADB rates, a tweaked autoscale band — a regenerated or reopened case still shows the old figures.
2. **No way to model a negotiated discount.** Reps routinely quote a discount off the proposed solution; CaseForge has no input for it.

## 2. Decisions (locked with Rick)

- **Discount target:** the **total proposed solution** — ADB subscription + one-time migration + DR add-on. One percentage across everything CaseForge quotes. The **current-cost baseline** (on-prem build-up or Atlas bill) is the customer's actual spend and stays **undiscounted**.
- **Entry point:** **Step 1 Setup** (case-level input, default `0%`), **also adjustable in Step 6 Refine** so the rep can explore scenarios; changing it triggers a regenerate. Persisted in the archive.
- **Regeneration always recomputes** the deterministic sizing + cost math with the **current** `ENGINE_CONFIG` and the **current** discount, then rewrites prose on the fresh numbers.

## 3. Part A — Always-current regeneration

### Current state
- `runPipeline(config)` (`src/orchestrate/index.ts`) runs the full deterministic chain: triage → sizing → TCO → prose → render. It already accepts an injected `triage` (to skip re-running classification) and an `onCheckpoint` callback.
- Step 6 Refine bypasses the pipeline: it calls `generateProse(docModel, …, instruction)` directly and re-renders, so the numbers never recompute.

### Change
Make **Regenerate re-run the engine math**, not just prose:

- Add an optional `proseInstruction` to `runPipeline`'s config, forwarded to `generateProse` (which already takes an `instruction`). This unifies generate and refine on one code path.
- **Step 6 Regenerate** calls `runPipeline` with: the **cached `triage`** (reused — no new LLM classification unless files were added), the **current `ENGINE_CONFIG`** (engine fns already default to it), the **current discount**, and the **refine `proseInstruction`**. Result: sizing + TCO are recomputed from current settings, then prose is rewritten on the fresh figures, then all four deliverables re-render.
- The deterministic math is pure and LLM-free, so an unchanged-input refine yields identical numbers (stable), while a changed discount / changed config / added file flows straight through.

### Implication for old cases
Reopening an archived case and regenerating **refreshes its numbers to today's rates/config** — by design. *Viewing* a reopened case shows the numbers as last generated (the current version's `docModel` + rendered HTML); *regenerating* produces a **new content-package version** — it does **not** delete or overwrite the previous one (see the archive spec's versioning section), so the rep can always go back to what was generated before. The Refine view shows a hint — "rates/formulas may have changed since this case was generated; Regenerate to refresh" — when the case was opened from an archive.

## 4. Part B — Customer discount

### Model
- `WizardConfig` (`src/ui/state.ts`) gains `discountPct: number` (0–100, default `0`); it flows into the pipeline's `RunConfig`. It is a **per-case sales input**, deliberately *not* an `ENGINE_CONFIG` constant (those are Oracle formula constants, not deal terms).
- The TCO builder (`src/render/builders.ts` `buildTcoSection`) applies the discount to the **proposed** side only:
  - `proposedNet = proposedList × (1 − discountPct/100)` applied to each proposed component (ADB annual, DR add-on, one-time migration) — equivalent to discounting the total for a flat %.
  - Savings vs. baseline, the five-year stream, and payback are all recomputed from the **net** proposed figures.
  - The baseline (`currentTotal` / on-prem build-up / Atlas bill) is untouched.
- Determinism is preserved: the discount is a deterministic input; the engine still owns every number. The LLM never sets or sees the raw discount — only the resulting figures (which are anon-safe, like all `docModel` numbers).

### Rendering (discount transparency)
When `discountPct > 0`, the business case and sizing brief show **list vs. your-price** so the discount is explicit and compelling — e.g. "Oracle proposal: list $X/yr → **your price $0.85·X/yr (15% discount)**." The cost-comparison and five-year charts plot the **net** proposed cost; a labeled note records the applied discount. When `discountPct === 0` the rendering is exactly as today (no list-vs-net framing, no behavior change).

### UI
- **Step 1 Setup:** a "Customer discount (%)" field next to company/provider; numeric, 0–100, default 0, validated.
- **Step 6 Refine:** the same field, plus the existing prose-instruction box; editing either and clicking Regenerate recomputes (Part A).

## 5. Determinism & golden tests

- **Default `0%` is a strict no-op** → existing golden fixtures (Northwind: on-prem $449.5K, ADB warm $213,649, etc.) are unchanged. New tests cover `discountPct > 0`: assert the proposed total, savings, and payback shift correctly and the baseline does not.
- A regeneration test proves "current settings win": run a pipeline, change an `ENGINE_CONFIG` rate (via the override seam), regenerate, and assert the numbers move — locking in that regenerate recomputes rather than replays.
- Rendering tests: list-vs-net appears only when `discountPct > 0`; charts use the net proposed figure.

## 6. Build sequencing

This is **one PR**, and it lands **before** the archive PRs (the archive refine/resume flow depends on regenerate-recomputes):

- **PR 0 — Discount + always-current regeneration.** `discountPct` in `WizardConfig`/`RunConfig`; `buildTcoSection` discount math; `runPipeline` `proseInstruction`; Step 6 Regenerate calls `runPipeline` (cached triage); Setup + Refine discount fields; list-vs-net rendering; tests.

Then the archive feature (PRs A/B/C) builds on top, persisting `discountPct` in the archive and relying on regenerate-recomputes so reopened old cases refresh correctly.

## 7. Open defaults

- **Discount transparency = show list vs. your-price** when `> 0`. *(default — more compelling + honest; flag if you'd rather show only the net price)*
- **Discount is a single flat % across all proposed components** (ADB + migration + DR). *(per the locked decision)*
- **Reopened-archive viewing shows last-generated numbers; regenerate refreshes.** *(default — avoids silently changing a case the rep is just looking at)*
