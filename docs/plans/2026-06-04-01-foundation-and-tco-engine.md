# Foundation + TCO Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the CaseForge repo toolchain (TypeScript, Vitest, ESLint/Prettier, Vite) with green CI/CD, then build the deterministic TCO business-case engine test-first, proven against the Northwind golden numbers.

**Architecture:** A pure, dependency-free TypeScript module (`src/engine/tco.ts`) computes on-prem vs ADB annual cost, DR options, the 5-year migrate-vs-status-quo scenario, savings, and payback from typed inputs. No LLM, no I/O — pure functions, the single source of truth for every business-case number (port of `tco_calc.py`). CI runs lint + typecheck + test (with coverage) + build on every push/PR.

**Tech Stack:** Node 22, pnpm, TypeScript (strict), Vitest, ESLint (flat config) + Prettier, Vite (library/app build), GitHub Actions.

---

## File Structure
- `package.json` — scripts: `lint`, `typecheck`, `test`, `build`.
- `tsconfig.json` — strict TS.
- `vitest.config.ts` — test runner + V8 coverage.
- `eslint.config.js` — flat ESLint config (TS).
- `.prettierrc.json` — formatting.
- `.github/workflows/ci.yml` — CI: install → lint → typecheck → test → build.
- `src/engine/types.ts` — shared engine types (`Range`, `Level`, `DrPosture`, `TcoInputs`).
- `src/engine/tco.ts` — the deterministic TCO engine (pure functions).
- `src/engine/tco.test.ts` — unit tests per function.
- `src/engine/fixtures/northwind.ts` — the Northwind golden inputs.
- `src/engine/northwind.golden.test.ts` — end-to-end golden assertions (reproduces our hand-run numbers).
- `src/smoke.test.ts` — trivial test proving the harness + CI work.

---

### Task 0: Project scaffold, test harness, and CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.github/workflows/ci.yml`, `src/smoke.test.ts`

- [ ] **Step 1: Write the failing test** — `src/smoke.test.ts`

```ts
import { describe, it, expect } from 'vitest';

describe('harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails (no runner yet)**

Run: `pnpm test`
Expected: FAIL — `pnpm` script/`vitest` not found (toolchain not installed yet).

- [ ] **Step 3: Create the toolchain config**

`package.json`:
```json
{
  "name": "caseforge",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "build": "vite build"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^2.1.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"],
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] },
  },
});
```

`eslint.config.js`:
```js
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/', 'coverage/', 'app/dist/'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsparser, parserOptions: { project: false } },
    plugins: { '@typescript-eslint': tseslint },
    rules: { '@typescript-eslint/no-unused-vars': 'error' },
  },
];
```

`.prettierrc.json`:
```json
{ "singleQuote": true, "semi": true, "printWidth": 100 }
```

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 4: Install and run the test to verify it passes**

Run: `pnpm install && pnpm test`
Expected: PASS — `harness > runs`; coverage table prints.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts eslint.config.js .prettierrc.json .github/workflows/ci.yml src/smoke.test.ts
git commit -m "chore: toolchain, test harness, and CI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: Engine types + on-prem total

**Files:**
- Create: `src/engine/types.ts`, `src/engine/tco.ts`, `src/engine/tco.test.ts`

- [ ] **Step 1: Write the failing test** — `src/engine/tco.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { onpremTotal } from './tco';
import type { TcoInputs } from './types';

const inputs: Pick<TcoInputs, 'onpremComponents'> = {
  onpremComponents: {
    license: { low: 135000, central: 240000, high: 450000 },
    hardware: { low: 40000, central: 58000, high: 121000 },
    storage: { low: 5000, central: 22000, high: 95000 },
    facility: { low: 31500, central: 49500, high: 99000 },
    labor: { low: 35000, central: 70000, high: 135000 },
    backup: { low: 5000, central: 10000, high: 20000 },
  },
};

describe('onpremTotal', () => {
  it('sums components at the chosen level', () => {
    expect(onpremTotal(inputs as TcoInputs, 'central')).toBe(449500);
    expect(onpremTotal(inputs as TcoInputs, 'low')).toBe(251500);
    expect(onpremTotal(inputs as TcoInputs, 'high')).toBe(920000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: FAIL — cannot find module `./tco` / `onpremTotal` is not a function.

- [ ] **Step 3: Write minimal implementation**

`src/engine/types.ts`:
```ts
export interface Range { low: number; central: number; high: number }
export type Level = keyof Range;
export type DrPosture = 'none' | 'cold' | 'warm';

export interface TcoInputs {
  onpremComponents: Record<string, Range>;
  adbPrimary: Range;
  coldDrAdd: Range;
  warmDrAdd: Range;
  migrationPs: Range;
}
```

`src/engine/tco.ts`:
```ts
import type { TcoInputs, Level } from './types';

export function onpremTotal(inputs: TcoInputs, level: Level): number {
  return Object.values(inputs.onpremComponents).reduce((sum, r) => sum + r[level], 0);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/types.ts src/engine/tco.ts src/engine/tco.test.ts
git commit -m "feat(engine): on-prem fully-loaded annual total

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ADB total by DR posture

**Files:**
- Modify: `src/engine/tco.ts`, `src/engine/tco.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/engine/tco.test.ts`

```ts
import { adbTotal } from './tco';

const adb = {
  adbPrimary: { low: 78525, central: 80926, high: 100000 },
  coldDrAdd: { low: 18774, central: 26820, high: 40231 },
  warmDrAdd: { low: 128481, central: 132723, high: 142620 },
} as Pick<TcoInputs, 'adbPrimary' | 'coldDrAdd' | 'warmDrAdd'>;

describe('adbTotal', () => {
  it('adds the DR posture to the primary', () => {
    expect(adbTotal(adb as TcoInputs, 'none', 'central')).toBe(80926);
    expect(adbTotal(adb as TcoInputs, 'cold', 'central')).toBe(107746);
    expect(adbTotal(adb as TcoInputs, 'warm', 'central')).toBe(213649);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: FAIL — `adbTotal` is not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/engine/tco.ts`

```ts
import type { DrPosture } from './types';

export function adbTotal(inputs: TcoInputs, dr: DrPosture, level: Level): number {
  const add =
    dr === 'cold' ? inputs.coldDrAdd[level] : dr === 'warm' ? inputs.warmDrAdd[level] : 0;
  return inputs.adbPrimary[level] + add;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tco.ts src/engine/tco.test.ts
git commit -m "feat(engine): ADB annual total by DR posture

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Annual savings (amount + percent)

**Files:**
- Modify: `src/engine/tco.ts`, `src/engine/tco.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/engine/tco.test.ts`

```ts
import { annualSaving } from './tco';

const full = { ...inputs, ...adb, migrationPs: { low: 75000, central: 150000, high: 300000 } } as TcoInputs;

describe('annualSaving', () => {
  it('computes central saving vs on-prem and the percent', () => {
    expect(annualSaving(full, 'warm')).toEqual({ amount: 235851, pct: 52 });
    expect(annualSaving(full, 'cold')).toEqual({ amount: 341754, pct: 76 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: FAIL — `annualSaving` is not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/engine/tco.ts`

```ts
export function annualSaving(inputs: TcoInputs, dr: DrPosture): { amount: number; pct: number } {
  const base = onpremTotal(inputs, 'central');
  const amount = base - adbTotal(inputs, dr, 'central');
  return { amount, pct: Math.round((100 * amount) / base) };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tco.ts src/engine/tco.test.ts
git commit -m "feat(engine): annual savings amount and percent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Five-year scenario, net savings, and payback

**Files:**
- Modify: `src/engine/tco.ts`, `src/engine/tco.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/engine/tco.test.ts`

```ts
import { fiveYear, net5, paybackYear } from './tco';

describe('five-year scenario', () => {
  it('Year 1 = on-prem + ADB primary + migration; Years 2-5 = ADB with DR', () => {
    const { A, B } = fiveYear(full, 'warm', 'central');
    expect(A).toEqual([680426, 213649, 213649, 213649, 213649]); // Y1 dual-run + PS
    expect(B).toEqual([449500, 449500, 449500, 449500, 449500]);
  });
  it('net 5-year savings (status quo total - migrate total)', () => {
    expect(net5(full, 'warm')).toBe(712478);
    expect(net5(full, 'cold')).toBe(1136090);
  });
  it('payback is the first year cumulative migrate <= cumulative status quo', () => {
    expect(paybackYear(full, 'warm')).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: FAIL — `fiveYear` / `net5` / `paybackYear` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/engine/tco.ts`

```ts
export function fiveYear(inputs: TcoInputs, dr: DrPosture, level: Level): { A: number[]; B: number[] } {
  const op = onpremTotal(inputs, level);
  const y1 = op + inputs.adbPrimary[level] + inputs.migrationPs[level];
  const steady = adbTotal(inputs, dr, level);
  return { A: [y1, steady, steady, steady, steady], B: [op, op, op, op, op] };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function net5(inputs: TcoInputs, dr: DrPosture): number {
  const { A, B } = fiveYear(inputs, dr, 'central');
  return sum(B) - sum(A);
}

export function paybackYear(inputs: TcoInputs, dr: DrPosture): number | null {
  const { A, B } = fiveYear(inputs, dr, 'central');
  let ca = 0;
  let cb = 0;
  for (let i = 0; i < A.length; i++) {
    ca += A[i]!;
    cb += B[i]!;
    if (i > 0 && cb >= ca) return i + 1;
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/engine/tco.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/tco.ts src/engine/tco.test.ts
git commit -m "feat(engine): five-year scenario, net savings, payback year

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Northwind golden fixture (end-to-end engine validation)

**Files:**
- Create: `src/engine/fixtures/northwind.ts`, `src/engine/northwind.golden.test.ts`

- [ ] **Step 1: Write the failing test** — `src/engine/northwind.golden.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { NORTHWIND } from './fixtures/northwind';
import { onpremTotal, adbTotal, annualSaving, net5, paybackYear } from './tco';

describe('Northwind golden numbers (must reproduce the hand-run business case)', () => {
  it('on-prem fully-loaded central ≈ $450K', () => {
    expect(onpremTotal(NORTHWIND, 'central')).toBe(449500);
  });
  it('ADB warm ≈ $214K, cold ≈ $108K', () => {
    expect(adbTotal(NORTHWIND, 'warm', 'central')).toBe(213649);
    expect(adbTotal(NORTHWIND, 'cold', 'central')).toBe(107746);
  });
  it('warm saving 52% / ~$236K; cold 76% / ~$342K', () => {
    expect(annualSaving(NORTHWIND, 'warm')).toEqual({ amount: 235851, pct: 52 });
    expect(annualSaving(NORTHWIND, 'cold')).toEqual({ amount: 341754, pct: 76 });
  });
  it('5-year net savings: $712,478 (warm) / $1,136,090 (cold); payback Year 2', () => {
    expect(net5(NORTHWIND, 'warm')).toBe(712478);
    expect(net5(NORTHWIND, 'cold')).toBe(1136090);
    expect(paybackYear(NORTHWIND, 'warm')).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/engine/northwind.golden.test.ts`
Expected: FAIL — cannot find `./fixtures/northwind`.

- [ ] **Step 3: Write the fixture** — `src/engine/fixtures/northwind.ts`

```ts
import type { TcoInputs } from '../types';

// Verified central/low/high inputs from the Northwind engagement (USD/yr).
export const NORTHWIND: TcoInputs = {
  onpremComponents: {
    license: { low: 135000, central: 240000, high: 450000 },
    hardware: { low: 40000, central: 58000, high: 121000 },
    storage: { low: 5000, central: 22000, high: 95000 },
    facility: { low: 31500, central: 49500, high: 99000 },
    labor: { low: 35000, central: 70000, high: 135000 },
    backup: { low: 5000, central: 10000, high: 20000 },
  },
  adbPrimary: { low: 78525, central: 80926, high: 100000 },
  coldDrAdd: { low: 18774, central: 26820, high: 40231 },
  warmDrAdd: { low: 128481, central: 132723, high: 142620 },
  migrationPs: { low: 75000, central: 150000, high: 300000 },
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/engine/northwind.golden.test.ts`
Expected: PASS — all golden assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/fixtures/northwind.ts src/engine/northwind.golden.test.ts
git commit -m "test(engine): Northwind golden fixture reproduces the business-case numbers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review
- **Spec coverage:** This plan implements the determinism principle (§3) and the TCO half of the sizing/TCO engine (§9, §11) plus the toolchain/CI foundation (§13–§14). The sizing engine (utilization→ECPU), charts, ingest, classify, adapter, orchestrator, renderer, refine, UI, and launcher are explicitly deferred to plans 1–9 in the roadmap (not gaps — sequenced).
- **Placeholder scan:** No TBDs; every code/test step contains full code and exact commands.
- **Type consistency:** `Range`/`Level`/`DrPosture`/`TcoInputs` defined in Task 1 and used unchanged in Tasks 2–5 and the fixture. Function names (`onpremTotal`, `adbTotal`, `annualSaving`, `fiveYear`, `net5`, `paybackYear`) are consistent across tasks and the golden test.
- **Numbers:** Golden values match the verified `tco_calc.py` outputs (on-prem $449,500; ADB warm $213,649 / cold $107,746; savings 52%/76%; net5 $712,478/$1,136,090; payback Yr 2).
