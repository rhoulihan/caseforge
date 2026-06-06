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
