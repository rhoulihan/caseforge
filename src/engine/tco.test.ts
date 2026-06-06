import { describe, it, expect } from 'vitest';
import { onpremTotal, adbTotal, annualSaving, fiveYear, net5, paybackYear } from './tco';
import type { TcoInputs } from './types';

const full: TcoInputs = {
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

describe('onpremTotal', () => {
  it('sums components at the chosen level', () => {
    expect(onpremTotal(full, 'central')).toBe(449500);
    expect(onpremTotal(full, 'low')).toBe(251500);
    expect(onpremTotal(full, 'high')).toBe(920000);
  });
});

describe('adbTotal', () => {
  it('adds the DR posture to the primary', () => {
    expect(adbTotal(full, 'none', 'central')).toBe(80926);
    expect(adbTotal(full, 'cold', 'central')).toBe(107746);
    expect(adbTotal(full, 'warm', 'central')).toBe(213649);
  });
});

describe('annualSaving', () => {
  it('computes central saving vs on-prem and the percent', () => {
    expect(annualSaving(full, 'warm')).toEqual({ amount: 235851, pct: 52 });
    expect(annualSaving(full, 'cold')).toEqual({ amount: 341754, pct: 76 });
  });
});

describe('five-year scenario', () => {
  it('Year 1 = on-prem + ADB primary + migration; Years 2-5 = ADB with DR', () => {
    const { A, B } = fiveYear(full, 'warm', 'central');
    expect(A).toEqual([680426, 213649, 213649, 213649, 213649]);
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
