# Sizing Engine Implementation Plan (plan 02)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deterministic utilization→ECPU sizing — consumed average/peak ECPU by scope, the avg→peak ratio, and base provisioning (Peak÷N floored at the average) with autoscale ceilings. Port of `sizing_calc.py`; produces the ADB sizing that feeds the TCO engine.

**Architecture:** Pure functions in `src/engine/sizing.ts` over typed `SizingInputs`. ECPU ≈ consumed vCPU (net 1:1). No LLM, no I/O. Validated against the Northwind sizing fixture.

**Tech Stack:** Same as plan 01 (TypeScript, Vitest).

---

### Task 1: consumedEcpu (avg/peak/ratio by scope)
**Files:** Modify `src/engine/types.ts`; Create `src/engine/sizing.ts`, `src/engine/sizing.test.ts`, `src/engine/fixtures/northwind-sizing.ts`

- [ ] **Step 1: failing test** — `src/engine/sizing.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { consumedEcpu } from './sizing';
import { NORTHWIND_SIZING } from './fixtures/northwind-sizing';

describe('consumedEcpu', () => {
  it('workload scope = primaries only (HO=32): avg 17.28, peak 43.2, ratio 2.5', () => {
    const c = consumedEcpu(NORTHWIND_SIZING, 'workload');
    expect(c.avg).toBeCloseTo(17.28, 2);
    expect(c.peak).toBeCloseTo(43.2, 2);
    expect(c.ratio).toBeCloseTo(2.5, 3);
  });
  it('full-cluster scope sums all roles: avg 32.64, peak 86.4', () => {
    const c = consumedEcpu(NORTHWIND_SIZING, 'fullcluster');
    expect(c.avg).toBeCloseTo(32.64, 2);
    expect(c.peak).toBeCloseTo(86.4, 2);
  });
});
```
- [ ] **Step 2: run red** — `pnpm vitest run src/engine/sizing.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement** — add to `src/engine/types.ts`:
```ts
export interface RoleUtil { avgPct: number; peakPct: number }
export type Scope = 'workload' | 'fullcluster';
export interface SizingInputs {
  shards: number;
  hoVcpu: number;
  drVcpu: number;
  util: { primary: RoleUtil; hoSec: RoleUtil; dr: RoleUtil };
}
```
`src/engine/sizing.ts`:
```ts
import type { SizingInputs, Scope, RoleUtil } from './types';

export interface Consumed { avg: number; peak: number; ratio: number }

export function consumedEcpu(i: SizingInputs, scope: Scope): Consumed {
  const role = (vcpu: number, u: RoleUtil) => ({
    avg: i.shards * vcpu * u.avgPct,
    peak: i.shards * vcpu * u.peakPct,
  });
  const prim = role(i.hoVcpu, i.util.primary);
  if (scope === 'workload') return { avg: prim.avg, peak: prim.peak, ratio: prim.peak / prim.avg };
  const sec = role(i.hoVcpu, i.util.hoSec);
  const dr = role(i.drVcpu, i.util.dr);
  const avg = prim.avg + sec.avg + dr.avg;
  const peak = prim.peak + sec.peak + dr.peak;
  return { avg, peak, ratio: peak / avg };
}
```
`src/engine/fixtures/northwind-sizing.ts`:
```ts
import type { SizingInputs } from '../types';
export const NORTHWIND_SIZING: SizingInputs = {
  shards: 3,
  hoVcpu: 32,
  drVcpu: 16,
  util: {
    primary: { avgPct: 0.18, peakPct: 0.45 },
    hoSec: { avgPct: 0.12, peakPct: 0.35 },
    dr: { avgPct: 0.08, peakPct: 0.2 },
  },
};
```
- [ ] **Step 4: run green** — `pnpm vitest run src/engine/sizing.test.ts` → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat(engine): consumed ECPU by scope with avg→peak ratio"`

---

### Task 2: baseFor (Peak÷N floored at average) + ceilings
**Files:** Modify `src/engine/sizing.ts`, `src/engine/sizing.test.ts`

- [ ] **Step 1: failing test** — append:
```ts
import { baseFor, ceilings } from './sizing';

describe('baseFor / ceilings', () => {
  it('Conservative (n=2) = 22, Aggressive (n=3) = 18 floored to average', () => {
    expect(baseFor(43.2, 17.28, 2)).toBe(22);
    expect(baseFor(43.2, 17.28, 3)).toBe(18); // Peak/3=14.4 < avg 17.28 → floored, ceil → 18
  });
  it('autoscale ceilings are 2x and 3x the base', () => {
    expect(ceilings(22)).toEqual({ x2: 44, x3: 66 });
    expect(ceilings(18)).toEqual({ x2: 36, x3: 54 });
  });
});
```
- [ ] **Step 2: run red** → FAIL (not exported).
- [ ] **Step 3: implement** — append to `src/engine/sizing.ts`:
```ts
/** Provisioned base = ceil(max(Peak/n, Average)); never below average (avoids continuous bursting). */
export function baseFor(peak: number, avg: number, n: number): number {
  return Math.ceil(Math.max(peak / n, avg));
}

export function ceilings(base: number): { x2: number; x3: number } {
  return { x2: 2 * base, x3: 3 * base };
}
```
- [ ] **Step 4: run green** → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat(engine): Peak÷N base sizing with average floor and autoscale ceilings"`

---

### Task 3: Northwind sizing golden (end-to-end)
**Files:** Create `src/engine/northwind-sizing.golden.test.ts`

- [ ] **Step 1: failing test**
```ts
import { describe, it, expect } from 'vitest';
import { NORTHWIND_SIZING } from './fixtures/northwind-sizing';
import { consumedEcpu, baseFor, ceilings } from './sizing';

describe('Northwind sizing golden', () => {
  it('workload ratio 2.5x; Conservative base 22 (44/66), Aggressive base 18 (36/54)', () => {
    const { avg, peak, ratio } = consumedEcpu(NORTHWIND_SIZING, 'workload');
    expect(ratio).toBeCloseTo(2.5, 3);
    expect(baseFor(peak, avg, 2)).toBe(22);
    expect(ceilings(baseFor(peak, avg, 2))).toEqual({ x2: 44, x3: 66 });
    expect(baseFor(peak, avg, 3)).toBe(18);
    expect(ceilings(baseFor(peak, avg, 3))).toEqual({ x2: 36, x3: 54 });
  });
});
```
- [ ] **Step 2: run red** → FAIL (test references already-built fns but file new; should actually pass once written since fns exist — so this is a regression-lock test). Run to confirm.
- [ ] **Step 3:** (no new impl — golden lock over Tasks 1–2).
- [ ] **Step 4: run green** → PASS.
- [ ] **Step 5: commit** — `git commit -m "test(engine): Northwind sizing golden lock"`

---

## Self-Review
- Spec coverage: implements the sizing model + autoscaling/avg-to-peak (§9, §11) deterministically.
- Numbers verified against `sizing_calc.py`: workload avg 17.28 / peak 43.2 / ratio 2.5; base 22 (cons) / 18 (aggr); ceilings 44/66 and 36/54; full-cluster 32.64 / 86.4.
- Types (`SizingInputs`, `RoleUtil`, `Scope`, `Consumed`) and fn names (`consumedEcpu`, `baseFor`, `ceilings`) consistent across tasks.
