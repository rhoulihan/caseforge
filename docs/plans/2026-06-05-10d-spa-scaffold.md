# Plan 10d — SPA scaffold (Vite + Preact + base CSS + component-test harness)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Stand up the browser app shell — Vite + Preact, the Oracle-house-style base CSS, and a component-test harness — so the Phase-2 components (10e–10l) have a foundation. The heavy logic already lives in pure TS modules; this is the thin view layer's skeleton.

**Decisions (user-approved):** Preact + Vite; plain CSS in the existing Oracle house style. This sub-plan is foundational/mechanical; the actual wizard + component *layouts* are designed (with mockups) before they are built.

**Tech Stack:** preact 10 (runtime); @preact/preset-vite, @testing-library/preact, jsdom (dev). vite 5 already present.

---

## Locked decisions
- **One config:** consolidate into `vite.config.ts` (via `defineConfig` from `vitest/config`) holding the `preact()` plugin AND the `test` block; delete `vitest.config.ts`. The plugin compiles JSX for both `vite build` and `vitest`.
- **Test env per-file:** keep the global vitest env `node` (existing pure-function tests stay fast); component tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
- **Source layout:** UI lives under `src/ui/`; entry `src/main.tsx` renders `<App/>` into `#app`. Pure modules (engine/ingest/render/…) are untouched.
- **JSX:** tsconfig `"jsx": "react-jsx"`, `"jsxImportSource": "preact"`, add `"lib": ["ES2022","DOM","DOM.Iterable"]`. No per-file React/Preact import needed.
- **Scripts:** `dev: vite`, `build: vite build` (replaces the echo placeholder). `dist/` already gitignored.
- **Lint:** extend the flat config `files` glob to include `**/*.tsx`.

## Files
- Modify: `tsconfig.json` (jsx + lib), `eslint.config.js` (lint .tsx), `package.json` (scripts), delete `vitest.config.ts`.
- Create: `vite.config.ts`, `index.html`, `src/main.tsx`, `src/ui/App.tsx`, `src/ui/styles.css`, `src/ui/App.test.tsx`.

---

### Task 1 — Toolchain config
- [ ] `vite.config.ts` with `preact()` + the migrated `test` block; delete `vitest.config.ts`.
- [ ] tsconfig jsx/lib; eslint `.tsx`; package.json `dev`/`build`.
- [ ] Verify the existing suite still runs (node env) under the new config.

### Task 2 — App shell + base CSS + entry
- [ ] `index.html` (`#app` + module script), `src/main.tsx` (render App, import styles), `src/ui/App.tsx` (header/main/footer shell), `src/ui/styles.css` (Oracle palette vars, Segoe UI, header accent bar, footer).

### Task 3 — Component-test harness (proves the setup)
- [ ] `src/ui/App.test.tsx` (`@vitest-environment jsdom`): render `<App/>` via `@testing-library/preact`, assert the `<h1>` is "CaseForge". Proves JSX compile + jsdom render + queries work.
- [ ] `vite build` produces `dist/` successfully (no app logic yet → light bundle).

## Self-Review
- Pure modules + their node-env tests untouched; component tests are jsdom per-file.
- `vite build` green; full gate (typecheck/lint/test) green.
- Wizard/component UX designed with the user (mockups) in later sub-plans — this is infra only.
