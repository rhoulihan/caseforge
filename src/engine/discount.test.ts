import { describe, it, expect } from 'vitest';
import { applyDiscount } from './discount';
import { NORTHWIND } from './fixtures/northwind';
import { adbTotal, onpremTotal } from './tco';

describe('applyDiscount', () => {
  it('is a strict no-op at 0% (same reference) — goldens unaffected', () => {
    expect(applyDiscount(NORTHWIND, 0)).toBe(NORTHWIND); // identical reference, not just equal
  });

  it('clamps below 0 and treats NaN as 0 (no-op)', () => {
    expect(applyDiscount(NORTHWIND, -5)).toBe(NORTHWIND);
    expect(applyDiscount(NORTHWIND, NaN)).toBe(NORTHWIND);
  });

  it('scales every PROPOSED component by (1 - pct/100) and leaves the baseline untouched', () => {
    const d = applyDiscount(NORTHWIND, 20); // factor 0.8
    expect(d.onpremComponents).toBe(NORTHWIND.onpremComponents); // BASELINE untouched (same ref)
    expect(d.adbPrimary.central).toBeCloseTo(NORTHWIND.adbPrimary.central * 0.8, 6);
    expect(d.warmDrAdd.central).toBeCloseTo(NORTHWIND.warmDrAdd.central * 0.8, 6);
    expect(d.coldDrAdd.high).toBeCloseTo(NORTHWIND.coldDrAdd.high * 0.8, 6);
    expect(d.migrationPs.low).toBeCloseTo(NORTHWIND.migrationPs.low * 0.8, 6);
  });

  it('flows into the TCO math: discounted ADB total = list × factor; baseline total unchanged', () => {
    const d = applyDiscount(NORTHWIND, 25); // factor 0.75
    // adbWarmAnnual = adbPrimary + warmDrAdd; both discounted → whole total × 0.75
    expect(adbTotal(d, 'warm', 'central')).toBeCloseTo(adbTotal(NORTHWIND, 'warm', 'central') * 0.75, 4);
    expect(adbTotal(d, 'cold', 'central')).toBeCloseTo(adbTotal(NORTHWIND, 'cold', 'central') * 0.75, 4);
    // baseline (on-prem) is the customer's current spend — must NOT move
    expect(onpremTotal(d, 'central')).toBe(onpremTotal(NORTHWIND, 'central'));
  });

  it('100% discount zeroes the proposed cost (free) but not the baseline', () => {
    const d = applyDiscount(NORTHWIND, 100);
    expect(adbTotal(d, 'warm', 'central')).toBe(0);
    expect(onpremTotal(d, 'central')).toBe(onpremTotal(NORTHWIND, 'central'));
  });
});
