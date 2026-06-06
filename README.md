# CaseForge

**Forge a sizing, a customer proposal, and a TCO business case from a folder of raw customer artifacts — locally, with your own LLM key.**

CaseForge is a self-contained, browser-based tool for the field salesforce. A rep runs a tiny launcher, brings their own **Claude or OpenAI** API key, and walks a 7-step wizard that reproduces an expert sizing → proposal → business-case workflow:

1. **Setup** — pick a provider, paste an API key (kept in the browser session only, never written to disk), set a token budget.
2. **Drop files** — drag in whatever the customer sent (xlsx, docx, pptx, pdf, .msg/.eml, csv, html, images…); parsed **locally**, nothing leaves the machine.
3. **Anonymize** — sensitive phrases are detected locally (no AI) and replaced with opaque slugs **before any AI call**; the rep reviews a fail-closed map.
4. **Confirm** — a Data Intake & Sufficiency Report (Blocked / Directional / Engineering-grade) plus a one-screen gate to confirm assumptions or supply real values.
5. **Generate** — deterministic sizing/TCO math runs in code (never the model); a live cost ticker shows spend while the AI only researches list prices, reads charts, and writes prose.
6. **Refine** — preview the three deliverables + a claims checklist; refine the wording (numbers stay locked).
7. **Export** — download the deliverables (real names already in place).

Customer documents stay on the laptop (parsed in-browser); only **anonymized** evidence is sent to the rep's chosen provider, over a zero-retention endpoint.

**v1 scope:** MongoDB → Oracle Autonomous Database, built behind a Source-Profile seam so other source databases can be added later.

> **Using CaseForge as a sales rep?** You don't need any of the developer setup below — see the plain-English **[Sales Rep Guide](docs/USER-GUIDE.md)**: download, double-click, and walk the wizard. (The same guide ships inside every release zip as `Guide.md`.)

## Quick start (run locally)

Requires **Node ≥ 20**, **pnpm**, and **Go ≥ 1.23**.

```bash
./scripts/run-local.sh          # builds the SPA + launcher, serves on http://127.0.0.1:8080
# or, step by step:
pnpm install && pnpm build      # → dist/
cd launcher && go build -o bin/caseforge . && cd ..
./launcher/bin/caseforge serve --app-dir dist
```

Then open the printed URL. For UI development, `pnpm dev` runs the Vite dev server, which proxies the launcher endpoints to `127.0.0.1:8080` (run the launcher alongside, or override with `VITE_LAUNCHER_ORIGIN`).

**Try it with sample data:** drop the three files in [`samples/northwind-demo/`](samples/northwind-demo/) (fictional customer artifacts) into the wizard — they exercise anonymization and reach a sizing result. Pre-built per-OS zips (launcher + SPA) are produced by the Release workflow.

## Status
Functional end-to-end — the full 7-step wizard. Built with full CI/CD and strict TDD. Design spec: [`docs/specs/2026-06-04-adb-sizing-app-design.md`](docs/specs/2026-06-04-adb-sizing-app-design.md).

## Architecture (summary)
- **SPA** (TypeScript, built to static assets) — all logic + the API key live in the browser.
- **Go launcher** (per-OS static binary, cross-compiled in CI) — serves the app on `http://localhost` and opens the browser; never sees docs or keys.
- **Provider adapter** — one interface over Claude and OpenAI (vision, web-search tool, structured output).
- **Source Profile (MongoDB)** — signal schema, sizing/TCO model, prompt + document templates.

See the spec for full detail.

## License
MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Oracle and/or its affiliates.
