import { describe, it, expect } from 'vitest';
import { consumedEcpu, baseFor, ceilings } from './sizing';
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

describe('baseFor / ceilings', () => {
  it('Conservative (n=2) = 22, Aggressive (n=3) = 18 floored to average', () => {
    expect(baseFor(43.2, 17.28, 2)).toBe(22);
    expect(baseFor(43.2, 17.28, 3)).toBe(18);
  });
  it('autoscale ceilings are 2x and 3x the base', () => {
    expect(ceilings(22)).toEqual({ x2: 44, x3: 66 });
    expect(ceilings(18)).toEqual({ x2: 36, x3: 54 });
  });
});
