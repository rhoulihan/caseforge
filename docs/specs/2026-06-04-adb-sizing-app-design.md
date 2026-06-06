# Design Spec — Portable AI Sizing & Business-Case Generator (CaseForge)

**Date:** 2026-06-04 (rev. 2026-06-05 — anonymization folded in) · **Status:** Draft for review · **Author:** Rick Houlihan + Claude<br>
**One-line:** A self-contained, browser-based app a sales rep extracts and runs locally; it ingests a folder of customer artifacts, optionally anonymizes customer identifiers before anything is analyzed, uses the rep's own Claude or OpenAI key to reproduce the exact sizing → proposal → business-case workflow we ran by hand, and produces an internal review, customer-facing proposals, and a high-level business case, with an assimilate-feedback-and-refine loop.

---

## 1. Problem & goals

Field reps need to size a non-Oracle workload onto Oracle Autonomous Database (ADB) and produce credible, on-brand proposals and a TCO business case — the multi-hour expert workflow we just executed for Northwind. Goal: package that workflow so any rep can run it on their laptop in minutes, with no software install and no central service handling customer data.

**Goals**
- Reproduce the proven pipeline: ingest → extract → classify → analyze (vision) → deterministic sizing → assumptions gate → generate 3 outputs → verify → refine.
- Self-contained: extract a zip, run a tiny launcher, work in the browser. No runtime/install.
- Bring-your-own-key: works with **Claude or OpenAI**, the rep's key, billed to the rep.
- Customer documents stay on the laptop (parsed client-side); only the specific evidence sent for analysis goes to the rep's chosen LLM provider.
- **Optionally anonymize identifiers before analysis** — a deterministic system utility replaces sensitive phrases (customer name, people, hostnames…) with opaque slugs so the provider only ever sees slugs; the real phrases are restored in the final deliverables (§12).
- Outputs: (1) internal technical review, (2) customer-facing proposal/brief, (3) high-level business case — each refinable from feedback.
- On-brand and consistent: the methodology, sizing model, Oracle exec-summary templates, and the global SVG house style are baked in.

**Non-goals (v1)**
- Multiple source databases (designed-for, not built — see §17).
- A hosted multi-tenant service or any server that sees customer data.
- Replacing Phase-2 engineering; this produces Phase-1 *notional* deliverables, clearly labeled.

## 2. Locked decisions
| # | Decision | Choice |
|---|---|---|
| D1 | Packaging | **Static SPA + tiny per-OS Go launcher** (serves `localhost`, opens browser). All logic + key client-side. |
| D2 | Providers | **Claude and OpenAI**, BYO-key, direct browser calls (`anthropic-dangerous-direct-browser-access` / `dangerouslyAllowBrowser`). |
| D3 | Cost/pricing research | **Live provider web-search tool** at run time (needs internet for the business case). |
| D4 | Source scope | **MongoDB → ADB only in v1, built behind a Source-Profile seam** for future DBs. |
| D5 | Run model | **Hybrid**: auto first-draft, one mandatory "confirm assumptions / fill gaps" gate, then jump-in-and-regenerate any stage. |
| D6 | Confidentiality | **In-app warning not to share customer-identifiable information**, and **always default to zero-retention / no-train provider endpoints**. |
| D7 | Ingest | **Format-agnostic**: identify evidence by *content/role*, not file extension (see §6–§7). |
| D8 | Anonymization | **Pre-analysis identifier stripping by the Go launcher** (a system utility, never the model): real phrases → opaque slugs before any analysis, restored in deliverables. Fails closed — anything it can't text-replace (images/binaries) is quarantined, not sent. See §12. |

## 3. Guiding principles
- **Format-agnostic, content-first.** The app figures out *what each artifact is* (a CPU time-series, a topology table, a licensing doc, a metrics chart) regardless of how it arrived (`.msg`, CSV, PDF, screenshot, pasted text).
- **Make sense of a dump; name the gaps.** Reps will drop a pile of mixed, partly-irrelevant files. The app inventories and identifies what's there, ignores the noise, and produces an explicit, up-front *what's-missing* report tied to result quality — so a rep knows exactly what to collect from the customer before incomplete data yields a weak proposal. **Telling the rep what's missing is a primary feature, not an afterthought.**
- **Determinism where it counts.** All sizing/TCO numbers come from a JS engine (the ported `sizing_calc`/`tco_calc`); the LLM reads charts and writes prose but never computes totals.
- **Evidence → claims traceability.** Every quantified claim in an output maps back to its evidence/source (auto-generated claims checklist, as we built by hand).
- **BYO-key, data stays local.** Documents are parsed in the browser; only selected evidence is sent to the rep's provider, over a zero-retention endpoint, with a confidentiality warning.
- **Strip identifiers before they leave — deterministically, not by the model.** When the rep enables it, anonymization is performed by a system utility (the launcher), not the LLM, and **fails closed** on anything it can't text-replace — so identifiers can't silently slip into a prompt or context window (§12).
- **Baked-in expertise.** Methodology, prompts, sizing model, doc templates, and SVG house style ship with the app so quality is consistent across a broad salesforce.

## 4. Architecture overview

```
┌── Go launcher (per-OS binary) ──────────────────────────────────────────────────────────┐
│  Two roles:                                                                              │
│   (a) static file server + browser opener — serves app/ on http://localhost:PORT;        │
│       never sees docs or key.                                                            │
│   (b) anonymize / deanonymize system utility — the ONLY component that touches raw        │
│       identifiers, locally, so the model never does (§12).                               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                     │ http://localhost
┌────────────────────▼─────────────────────────────────────────── Browser SPA ───────────┐
│  UI / wizard (hybrid run model, review+refine; anonymization mapping-builder form)       │
│  Orchestrator  ──drives──►  pipeline stages, token/cost budget, state                    │
│     │                                                                                    │
│  Ingest → Extract(container plugins) → Classify/Triage(AI+heuristics) → Evidence Bundle  │
│     │                                                                                    │
│  Anonymize (launcher) ─ identifiers→slugs BEFORE analysis ─┐  Deanonymize before export  │
│     │                                                      │                             │
│  Source Profile (MongoDB): signal schema · sizing model · prompt templates · cost model  │
│     │                                                                                    │
│  Sizing/TCO engine (deterministic JS)   Chart generator (SVG house style)                │
│     │                                                                                    │
│  Doc renderer → 3 outputs (HTML + print-to-PDF)   Refine module   Claims checklist       │
│     │                                                                                    │
│  Provider adapter ──HTTPS──► Claude OR OpenAI (vision, web-search tool, JSON, BYO-key)    │
│                              (sees slugs only when anonymization is enabled)             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Provider adapter (the only provider-specific code)
A single interface; everything else is provider-agnostic.
```
interface LLM {
  complete(opts: {
    system?, messages, images?,        // vision: image blocks
    tools?,                             // e.g. hosted web_search
    jsonSchema?,                        // structured output (validated)
    model, maxTokens?, temperature?
  }): Promise<{ text, toolResults?, usage }>   // usage → cost meter
}
```
Implementations: `ClaudeLLM` (Messages API + browser-access header + web_search tool) and `OpenAILLM` (Responses/Chat API + `dangerouslyAllowBrowser` + web search). Handles retries, rate-limit backoff, streaming, and **zero-retention endpoint configuration (D6)**. A model picker per provider (model IDs read from a small config so they're updatable without code changes; consult the Claude API reference for current Claude model IDs at build time). By the time the adapter runs, evidence has already passed through anonymization (§12) if the rep enabled it — the adapter sees slugs, never raw identifiers.

## 6. Ingest & extract (format-agnostic)
- **Folder pick:** `<input type="file" webkitdirectory>` (universal; no secure-context needed). On Chromium, optionally upgrade to File System Access API to write outputs back to the folder.
- **Type detection by content, not extension:** sniff magic bytes / structure; extension is a hint only.
- **Container extractor plugins** (each yields *primitives*): Outlook `.msg`/`.eml` (incl. embedded images), PDF (text + per-page rendered images), spreadsheets `.xlsx`/`.xls`, **CSV/TSV**, `.docx`, images (PNG/JPG/…), plain text/markdown, JSON, HTML. Unknown binary → flagged & skipped; unknown text-like → treated as text.
- **Primitive types:** `TextBlock`, `Table` (typed rows/cols, numeric series recognized), `Image` (bytes + provenance), `KeyValue` metadata. This is the JS port of what we did with `extract_msg`/`openpyxl`/`pdftotext`, generalized.

## 7. Classify / triage (the new, essential stage)
Maps heterogeneous primitives onto **what the sizing needs**, regardless of source format.
- The **Source Profile declares a signal schema** — the information the sizing requires (for MongoDB: cluster topology, node RAM/cores, data size, CPU avg/peak, memory/cache, IOPS, oplog/write rate, ops/sec & concurrency, edition, read preference, growth, …), each with **how it can be derived** and a **criticality** (*required* for a defensible number · *recommended* · *optional/refinement*).
- **Triage** assigns every primitive a semantic role and binds it to schema signals:
  - **Heuristics** for the obvious (a spreadsheet of formulas → likely the sizing/cost model; a CSV with a timestamp + numeric columns → a metric series).
  - **Numeric series handled natively:** when a signal is available as structured numbers (CSV/table), the JS engine computes avg/peak/P95 directly — *more accurate than reading a chart*.
  - **Vision** for images/charts: the LLM identifies "this is a System-CPU time-series, primary ~18% avg / ~45% peak," etc. — the fallback when only a picture exists.
  - **LLM text classification** for ambiguous prose/tables (licensing terms, topology descriptions).
- **Output → a rep-facing Data Intake & Sufficiency Report** (produced early, before any drafting):
  - **Inventory:** every file found and what the app determined it *is* (or "unrecognized / ignored as noise") — so the rep sees the messy dump was understood.
  - **Signal-coverage matrix:** each needed signal marked **satisfied / partial / missing**, the evidence that satisfies it, and a confidence (the signal-filled Evidence Bundle made visible).
  - **"What to collect" list:** for missing or low-confidence *required* signals, a plain-language, copy-pasteable request the rep can send the customer (e.g., "cores per data-bearing node," "MongoDB edition," "ops/sec by collection").
  - **Output-quality verdict:** ties completeness to result tier — e.g., *"Enough for a directional estimate now; collect X and Y to reach an engineering-grade, defensible number."*
  This report informs the rep up front **and** drives the mandatory assumptions/gaps gate (§8.5): proceed-with-flagged-assumptions, or pause and gather more.

## 8. Pipeline & run model (hybrid)
1. **Ingest → Extract → Classify** (above) → Evidence Bundle + **Data Intake & Sufficiency Report** (§7), shown to the rep before drafting.
2. **Anonymize (optional, recommended)** — if the rep supplied a mapping, the launcher (§12) replaces identifiers with opaque slugs *before any evidence is analyzed*; files it can't text-anonymize (images/binaries) are flagged for the rep to redact or exclude. Skipped cleanly if no mapping is supplied.
3. **Analyze** — LLM synthesizes the workload characterization from vision + structured signals (slugs only when anonymization is on).
4. **Size** — deterministic JS engine computes sizing scenarios (Peak÷N, ECPU mapping, autoscaling) and TCO.
5. **GATE — confirm assumptions / fill gaps** (the one mandatory stop): rep reviews satisfied signals, edits assumptions, answers gaps (e.g., cores/node, edition). Pre-filled with the model's proposed defaults.
6. **Generate** — three outputs (LLM prose + JS math + JS charts).
7. **Verify** — lighter single/dual-pass check of math, claims, consistency; auto-build the claims→evidence checklist.
8. **Review & Refine** — per-output feedback → regenerate that output with feedback + prior draft + evidence; version history. Rep can also jump back to any earlier stage and re-run downstream.
9. **Deanonymize → Export** — the launcher restores real phrases from slugs in the generated outputs (§12), then HTML + browser print-to-PDF; optional write-back to the project folder.
Cross-cutting: a **token/cost budget** with a live estimate and a confirm before expensive steps (vision over many images + web search).

## 9. Source Profile (MongoDB v1) — the extension seam
A profile bundles: the **signal schema** (§7), the **sizing/TCO model** (ported `sizing_calc.py` + `tco_calc.py`), the **prompt templates** for analysis/generation, the **assumptions schema + defaults**, the **cost components & web-search queries**, and the **doc templates** (Oracle exec-summary CSS for the three outputs). Adding PostgreSQL/MySQL/SQL Server later = a new profile implementing the same interface; the engine, adapter, ingest, classify, anonymizer, renderer, and refine loop are reused unchanged.

## 10. Outputs
- **Internal technical review** — analysis, sizing scenarios, assumptions, positioning notes (clearly internal).
- **Customer-facing proposal/brief** — sanitized, collaborative tone (our Customer Brief format).
- **High-level business case** — TCO comparison + charts + the blue/green narrative (our one-pager format).
- **Claims → evidence checklist** — every figure mapped to its source/confidence.
All rendered HTML with embedded house-style SVGs; PDF via browser print.

## 11. Determinism, charts, rendering
- Sizing/TCO math = pure JS functions (unit-tested), single source of truth (a `data.json` analog) consumed by both charts and docs.
- **Chart generator** ports the house-style helpers (`box/line/hop_h/T`, Oracle palette, step-over arcs) per `~/.claude/svg-guidelines.md`; every figure validated against the four non-negotiables (in-frame, no collisions, clean connectors, step-overs).
- PDF via `window.print()` against print CSS (high fidelity, zero deps).

## 12. Anonymization (pre-analysis identifier stripping)
A confidentiality control that goes beyond the D6 warning: sensitive phrases (customer name, people, hostnames, project codenames, …) are replaced with opaque slugs **before any artifact is analyzed**, so the rep's provider only ever receives slugs, and the real phrases are restored in the **final deliverables**. Built in plan 05; full design in `2026-06-04-anonymization-design.md`.

- **Done by a system utility, never the model (D8).** The substitution runs in the **Go launcher** — `caseforge anonymize` / `caseforge deanonymize`, a deterministic, dependency-free CLI — so real phrases are never rendered in an AI prompt or context window. The SPA never performs the replace; it only builds the map.
- **Mapping model (TS, in the SPA — `src/anon/mapping.ts`):** `MapEntry { phrase, slug }`; opaque, LLM-stable category slugs (`CF_ORG_01`, `CF_PERSON_02`, `CF_HOST_03`, …); TSV serialization kept **byte-identical** to the launcher; validation rejects empty phrase/slug, `slug == phrase`, and duplicate slugs, and warns on substrings. A **script-driven mapping-builder form** lets a rep assemble the map (ships with the SPA UI work).
- **Variant expansion (the leak fix, single source of truth in TS):** the builder expands each phrase into its case / whitespace / NFC+NFD variants, all sharing one slug, so the launcher's literal matcher catches every casing and normalization form without itself being clever.
- **Replace algorithm:** longest-phrase-first, **literal, single-pass** — once a region is replaced it is not re-scanned, so an introduced slug can never be re-matched. Forward = phrase→slug; reverse = slug→phrase.
- **Fails closed on what it can't anonymize.** Operates on UTF-8 text; **images, binaries, symlinks, oversized and non-UTF-8 files are quarantined to `_FLAGGED/` and NOT passed through** (identifiers baked into chart pixels can't be text-replaced). The CLI exits non-zero (code 3) unless `--allow-flagged`, forcing the rep to redact or exclude them. A slug that already appears in the source **aborts the run pre-flight** (it would corrupt the reverse pass). Refuses `--in == --out` and nested in/out paths.
- **Pipeline placement (§8):** `anonymize(source)` → SPA ingests the anonymized output → analyze / generate on slugs only → `deanonymize(artifacts)` before export. Later plans add launcher `POST /anonymize` & `/deanonymize` endpoints so the SPA can route the *extracted text* of office/PDF/email docs through the same core (single source of truth for the replace).
- **Invariants (tested — the whole point):** round-trip `deanonymize(anonymize(x)) == x` for text inputs (no data loss); leak-check — the anonymized output contains **none** of the mapped phrases (enforced as tests, analogous to the charts' `noCollisions` / `withinFrame`). An adversarial security review found and fixed 6 critical + 8 major leak/correctness vectors before merge. CI gained a **Go job** (`go vet` / `test` / `build`) alongside the Node job.
- **Scope (v1, YAGNI):** text + extracted-text anonymization + image/binary flagging. **OCR-based image redaction and regex/fuzzy matching are explicitly deferred** (literal only).

## 13. Confidentiality, key handling, errors
- **Confidentiality (D6, D8):** prominent first-run + per-run warning: *"Do not include customer-identifiable information you are not authorized to send to a third-party LLM."* When the rep enables it, identifiers are anonymized before analysis (§12) so the provider sees only slugs. Provider calls **default to zero-retention / no-train endpoints**; the chosen retention posture is shown in the UI. Docs are parsed locally; only selected evidence leaves the browser, only to the rep's provider, over HTTPS.
- **Key handling:** entered in-app, kept in `sessionStorage` by default (cleared on close), optional encrypted save; sent only to the provider; never to the launcher or any Oracle endpoint.
- **Errors:** unsupported/garbled file → skip + warn (run continues); API errors → typed messages (invalid key, rate limit w/ backoff, CORS, quota); partial results preserved; runs resumable from saved state.

## 14. Packaging & distribution
```
<AppName>/
  launch-win.exe  launch-mac  launch-linux   ← Go static server + browser opener + anonymize/deanonymize (~6 MB each)
  app/            ← built static SPA (index.html + bundled JS/CSS/libs, no CDN)
  samples/        ← the Northwind docs as a built-in demo + golden fixture
  README.txt      ← extract, run launcher, paste key, point at a folder
```
Same SPA can **also be hosted** at a URL (bonus, zero-download path) from one codebase. Versioned zips per release.

## 15. Tech stack
- **Launcher:** Go (single static binary per OS; trivial cross-compile; no runtime). Dependency-free `launcher/` module; also provides the `anonymize` / `deanonymize` subcommands (§12).
- **SPA:** built with a standard bundler (e.g., Vite) at dev time → **static output** shipped in `app/`; prefer a light/no heavy-framework footprint. Vendored libs (no CDN, for offline/local): `@kenjiuno/msgreader` (.msg), SheetJS (xlsx), pdf.js (PDF), a CSV parser; provider SDKs (Anthropic/OpenAI JS) or thin fetch wrappers.
- **No build step at runtime** — the shipped artifact is static files.

## 16. Risks & early spikes
1. **Browser-side web-search tool** actually working for both providers (Claude `web_search`, OpenAI web search) via direct BYO-key calls — verify first; fallback to rep-supplied cost inputs.
2. **Vision token cost** on image-heavy inputs (e.g., 9 chart panels) — measure; consider down-scaling/tiling and prefer structured data when present.
3. **PDF fidelity** of `window.print()` across Chrome/Edge/Firefox/Safari — verify; the one-pager already prints cleanly in Chrome.
4. **`.msg` robustness** in pure JS — fallback: let the Go launcher parse natively if the JS lib chokes.
5. **Zero-retention endpoint specifics** per provider — confirm exact headers/endpoints/flags at build time.
6. **Identifiers baked into images** can't be text-anonymized — mitigated by fail-closed `_FLAGGED/` quarantine (§12); the residual decision (redact or exclude) is the rep's, surfaced explicitly.

## 17. Extensibility
New source DB = new Source Profile (signal schema + model + templates + cost queries). Ingest, classify, anonymizer, adapter, engine harness, renderer, refine loop, and launcher are profile-agnostic and reused.

## 18. Testing
- Pure-function unit tests for the sizing/TCO engine and chart generator.
- Provider adapter behind a mock for orchestrator tests.
- **Anonymization:** round-trip and leak-check invariants + quarantine/abort behavior (Go), and the mapping model — slug suggestion, TSV round-trip with escaping, validation, variant expansion (TS); CI runs a dedicated Go job.
- **The Northwind docs ship as the golden end-to-end fixture** — the app must reproduce (within tolerance) the sizing and business-case numbers we produced by hand.

## 19. Open questions (to resolve in planning)
- App name / repo name — resolved: **CaseForge** (`github.com/rhoulihan/caseforge`).
- Exact model defaults per provider and how the model list is updated.
- Verification depth default (single vs dual pass) and its token budget.
- How much project state to persist and where (IndexedDB vs folder write-back).
- Whether the launcher stays "dumb" or optionally proxies/parses (current: dumb static server **plus** the anonymize/deanonymize utility — §12).

## 20. Milestones (high level)
1. **Spike** the risks in §16 (web-search BYO-key, vision cost, print-PDF, `.msg`).
2. **Core engine offline**: ingest → extract → classify → deterministic sizing + charts + anonymization (launcher), tested on the Northwind fixture, no LLM.
3. **Provider adapter + analyze/generate** for one provider, then the second.
4. **Three outputs + claims checklist + refine loop.**
5. **Packaging**: Go launcher + zip + samples; optional hosted build.
6. **Hardening**: confidentiality/zero-retention, cost guardrails, errors, cross-browser.
