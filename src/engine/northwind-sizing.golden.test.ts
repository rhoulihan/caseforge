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
