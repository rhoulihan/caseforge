# Design Spec — CaseForge: Business-Case Archives

**Date:** 2026-06-07 · **Status:** Proposed (design — not yet implemented) · **Author:** Rick Houlihan + Claude<br>
**One-line:** Persist each business case as a portable, launcher-managed `.zip` so a rep can close the app, reopen a prior case, refine it (with full continuity), and add more source files — all locally, with the same fail-closed anonymization guarantees as a fresh run.

> Storage model decided: **launcher-managed archives** in `~/CaseForge/archives/*.zip` with a home screen that lists saved cases. This spec is the artifact to review before we decompose it into implementation plans.

---

## 1. Motivation & goals

Today CaseForge is single-shot: a rep walks the seven-step wizard once, exports the deliverables, and the in-memory state is gone when the tab closes. There is no way to come back to a case, refine it later, or add a file the customer sent after the fact.

Goals:

- **Persist a complete case** — the original source files, the anonymized files that were sent to the LLM, the generated deliverables, and enough state to *resume*.
- **Reopen & refine** — open a prior case and land in the Refine step with the business case loaded; refining continues the narrative rather than starting cold.
- **Add files later** — bring new artifacts into an existing case, anonymizing only the new ones (reusing the approved map), then regenerate.
- **No new privacy surface** — only anonymized content ever reaches the LLM; archives are local-only and never uploaded.

Non-goals (v1): cloud sync, multi-user sharing, archive encryption, editing the numeric model after generation (numbers stay engine-locked; refinement is wording-only, as today).

## 2. What an archive is

A **single portable `.zip` per case**, stored by the launcher under `~/CaseForge/archives/<caseId>.zip`. `caseId` is a slug = `slug(companyName) + "-" + <shortTimestamp>` (e.g. `northwind-mutual-k9f2a1`), validated to `[a-z0-9-]+`.

Division of labor — **all zip building/parsing lives in TypeScript** (JSZip is already a dependency, and the logic is unit-testable under Vitest); the **Go launcher is a dumb blob store** that only peeks at `manifest.json` to build the home-screen list:

```
<caseId>.zip
├── manifest.json       # caseId, companyName, provider, status, schemaVersion,
│                       #   createdAt, updatedAt, refineCount, file index
├── state.json          # the hydratable WizardState (minus the API key, minus raw image bytes)
├── memory-state.json   # docModel + refinementHistory[]  ← the "resume" blob
├── sources/            # ORIGINAL uploaded files, exactly as dropped (contains PII)
├── anonymized/         # what the LLM saw: slugged text/tables as JSON, redacted images as PNG
├── output/             # generated deliverables: *.html + caseforge-docmodel.json
└── refinements/        # refinement-<n>.txt — the raw prompt text the rep typed
```

Image bytes (`Uint8Array`) cannot live in JSON, so image primitives in `state.json` / `anonymized/` reference their zip entry by path; the browser lazily reads the bytes back from the zip on load.

### `manifest.json` (launcher reads this for the list)

```jsonc
{
  "schemaVersion": 1,
  "caseId": "northwind-mutual-k9f2a1",
  "companyName": "Northwind Mutual",
  "provider": "claude",
  "status": "generated",            // "generated" | "refined"
  "createdAt": "2026-06-07T18:20:00Z",
  "updatedAt": "2026-06-07T18:41:00Z",
  "refineCount": 3,
  "files": { "sources": 5, "anonymized": 6, "outputs": 4 }
}
```

### `memory-state.json` (the resume blob)

```jsonc
{
  "docModel": { /* the full DocModel: numbers + prose + claims */ },
  "refinementHistory": [
    { "ts": "2026-06-07T18:30:00Z", "instruction": "tighten the exec summary", "slugged": "tighten the exec summary" }
  ]
}
```

`slugged` is the anonymized form actually sent to the LLM (see §5). Storing both the raw `instruction` (local) and the `slugged` form keeps the archive faithful while guaranteeing the model only ever saw slugs.

## 3. Why "resume the conversation" becomes a memory-state file

A key finding from tracing the code: **the LLM layer is fully stateless.** Both the initial generate and Step-6 refine build a fresh single-turn request (`messages: [{ role: 'user', content }]`, `src/orchestrate/prose.ts`); there is no transcript object, no message IDs, no server-side conversation handle (`src/provider/types.ts`). So there is no original conversation to "resume" literally.

The good news is that it doesn't matter: **`generateProse` rebuilds its entire context deterministically from the `docModel`** via `buildProseContext`, which carries *only* numbers, topology, and generic engine assumptions — never the company name or any real phrase (the renderer injects the real name locally at render time). So:

- `docModel` is **anonymization-safe** — refine doesn't leak today, and the memory-state file is safe to store and re-send.
- Reloading `docModel` already restores everything the model needs.
- The only missing piece for continuity is the **history of prior refinement instructions** — captured in `refinementHistory[]` and replayed on each refine.

This is functionally indistinguishable from resuming a conversation, and it survives app restarts. It is the only viable design given the stateless provider layer, and it is what the rest of this spec builds on.

## 4. Launcher endpoints (Go)

New routes alongside the existing `/anonymize`, `/deanonymize`, `/health` (same `serve.go` style, the same `..`-traversal guard, `127.0.0.1`-only):

| Method & path | Body / params | Returns | Notes |
|---|---|---|---|
| `POST /archive` | `caseId` + raw zip bytes | `{ ok, caseId }` | Writes `~/CaseForge/archives/<caseId>.zip` atomically (temp file + rename). Overwrites on update. |
| `GET /archives` | — | `[{ caseId, companyName, status, updatedAt, refineCount }]` | For each zip, read **only** `manifest.json` to build the row. Unreadable/corrupt zips are skipped, not fatal. |
| `GET /archive/{caseId}` | — | zip bytes | `Cache-Control: no-store`. |
| `DELETE /archive/{caseId}` | — | `{ ok }` | Remove a case from the home screen. |

Hardening (mirrors the existing launcher posture): `caseId` validated to `[a-z0-9-]+` before it touches the filesystem; `MaxBytesReader` on the upload; the archives directory is created on first save under the user's home; archive reads/writes are confined to that directory (no path escape). The browser client (`src/launcher/client.ts`) gains `saveArchive`, `listArchives`, `loadArchive`, `deleteArchive`.

## 5. Lifecycle

- **Temporary archive = the current in-memory `WizardState`.** Nothing is persisted while the rep moves Setup → … → Generate. ("Collect data in a temporary archive that isn't saved" = exactly today's ephemeral state.)
- **On successful Generate (Step 5):** assign a `caseId`, build the zip in TS, `POST /archive`. The case now exists on disk with `status: "generated"`.
- **Update (re-POST the same `caseId`)** after each successful **refine**, **add-files**, or **export**; `updatedAt` / `refineCount` bump and `status` becomes `"refined"`.

## 6. Home screen & opening a case

Today the app always mounts at Step 1. We add a **pre-wizard home screen**:

```
┌─────────────────────────────┐
│  CaseForge                  │
│  ▸ + New business case      │
│  ─ Recent cases ─────────── │
│  • Northwind Mutual  6/05   │
│  • Acme Re-platform  5/28   │
└─────────────────────────────┘
```

- **New business case** → today's wizard from Step 1.
- **Open** (`GET /archives` populates the list; `GET /archive/{id}` loads one) → unzip in the browser, hydrate `WizardState` from `state.json` + lazily-loaded image bytes, and set `step: 6` **directly** in the hydrated state. The wizard renders whatever `state.step` is, so the Refine view shows immediately — viewing the deliverables needs no API key.
- **API key on open / navigation:** the key is session-only (never archived). Note `maxReachableStep` gates *clicking* between steps on **all** prior steps being valid, and `stepValidity[1]` requires `hasApiKey` — so until the key is entered, the stepper rail is locked even though we've landed on Step 6. That's fine for viewing. A refine needs the key, so the refine action, when `!hasApiKey`, shows a small inline key prompt (prefilled provider/company from the archive). Once the key is set, every hydrated step (config, bundle, anonBundle, confirmed, docModel) is valid, so `maxReachableStep` restores full back/forth navigation across the case — no walk back through Setup required.

## 7. Refinement continuity & instruction handling

- `memory-state.json` carries `docModel` + an accumulating `refinementHistory[]`. Each refine appends its instruction; the next regeneration replays the history so the model has continuity.
- **The refinement instruction is slug-anonymized before it reaches the LLM.** Today the instruction text is passed to `generateProse` raw (`src/orchestrate/prose.ts`) — if a rep types a real customer name in the refine box, it leaks. This is a latent gap we close as part of this feature: run the instruction through the launcher `/anonymize` with the current map; the LLM sees slugs, while the **raw** text is saved to `refinements/refinement-<n>.txt` (local only) and to `refinementHistory[].instruction`.

## 8. Adding files during refine

A new **"Add more files"** action in Step 6:

1. Capture the current refine-box text into `refinements/refinement-<n>.txt` and stash it as a new `pendingRefinement` state field so it survives the detour back through the wizard.
2. Reset to **Step 2 (Drop files)** with the existing source files **preselected**, plus the **memory-state file** preselected (so its context is in scope), plus the new refinement `.txt`.
3. The rep adds new files. **Only the new files are ingested + anonymized.** The existing approved `map` is the baseline; detection runs over the **new primitives only**; new candidates extend/merge into the map; only the new primitives are slugged (the existing `anonBundle` primitives are retained). New images go through the same scan → review → redact gate.
4. Flow back through Confirm → Generate. The carried `pendingRefinement` instructions are included in the regeneration and then appended to `refinementHistory`.

This reuses the existing downstream-reset cascade in `Step2DropFiles` (re-dropping already invalidates `anonBundle`/`triage`/`pipeline`); the new wrinkle is *incremental* anonymization keyed off the prior map rather than a from-scratch re-detect.

## 9. State changes (`src/ui/state.ts`)

- `WizardState` gains: `caseId: string | null`, `refinementHistory: RefinementEntry[]`, `pendingRefinement: string | null`.
- New entry screen sits *before* the stepper; `initialWizardState()` is unchanged for "New", and a new `hydrateFromArchive(zip): Partial<WizardState>` produces the open-case state.
- `stepValidity` is unchanged in spirit; the image fail-closed gate already added in v0.4.0 continues to apply to any images brought in via add-files.

## 10. Privacy

Archives **contain customer PII** (the original `sources/` and the real-name deliverables in `output/`). They are local-only, never uploaded, and `~/CaseForge/archives/` is outside the repo. Only slugged content is ever sent to the LLM — the anonymized bundle, the slug-anonymized refinement instructions, and the anon-safe `docModel`. The archive directory should be documented in the User Guide as containing sensitive data the rep is responsible for.

## 11. Testing strategy

- **TS (Vitest):** archive (de)serialize round-trip (a `WizardState` → zip → `WizardState` with image bytes intact); `manifest.json` parse; incremental-anon merge (new files extend the map, existing slugs preserved); `hydrateFromArchive` → Step 6 reachable; refinement-instruction slug-anonymization; `refinementHistory` replay shape.
- **Go (httptest):** `POST /archive` writes + round-trips; `GET /archives` lists from manifests and skips corrupt zips; `GET`/`DELETE` by id; `caseId` validation rejects traversal; oversized upload rejected.
- **UI:** home screen lists + "New"; open → land on Step 6; add-files → reset to Step 2 with existing + memory file preselected and only-new-files anonymized.

## 12. Build sequencing (three PRs)

Each PR is independently green and shippable:

- **PR A — Archive core.** Zip schema + (de)serialize round-trip; Go endpoints + tests; save-on-generate; the home screen (New / Open / list / delete); open → hydrate → Step 6; inline API-key re-entry.
- **PR B — Refine continuity.** `memory-state.json` + `refinementHistory` replay; instruction slug-anonymization; refinement `.txt` capture; update-on-refine.
- **PR C — Add-files incremental.** `pendingRefinement` carry-through; Step 2 preselect; incremental detect/merge/anonymize of new files only; regenerate-with-carried-instructions.

## 13. Open questions / defaults chosen

- **Container = `.zip`**, one per case (portable, single artifact). *(default)*
- **`caseId` = slug(company)+short-timestamp.** *(default)*
- **Archive updated on every successful generate/refine/add-files/export.** *(default)*
- **Instruction anonymization on by default.** *(default — also closes a current latent leak)*
- **No archive encryption in v1** — local files; flagged as PII in the User Guide. *(default; revisit if reps store archives on shared drives)*
