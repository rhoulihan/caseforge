import { describe, it, expect } from 'vitest';
import { NORTHWIND_DOCMODEL } from './fixtures/northwind-docmodel';
import { renderBusinessCase } from './businessCase';

const m = NORTHWIND_DOCMODEL;

describe('Northwind DocModel — engine-derived consistency (the renderer reads, never recomputes)', () => {
  it('reproduces the sizing goldens', () => {
    expect(m.sizing.consumed.ratio).toBe(2.5);
    const cons = m.sizing.scenarios.find((s) => s.posture === 'conservative')!;
    const aggr = m.sizing.scenarios.find((s) => s.posture === 'aggressive')!;
    expect([cons.base, cons.ceiling2x, cons.ceiling3x]).toEqual([22, 44, 66]);
    expect([aggr.base, aggr.ceiling2x, aggr.ceiling3x]).toEqual([18, 36, 54]);
  });

  it('reproduces the TCO goldens', () => {
    expect(m.tco.onprem.total.central).toBe(449500);
    expect(m.tco.adbWarmAnnual.central).toBe(213649);
    expect(m.tco.adbColdAnnual.central).toBe(107746);
    expect(m.tco.savingWarm.pct).toBe(52);
    expect(m.tco.fiveYear.net5Warm).toBe(712478);
    expect(m.tco.fiveYear.net5Cold).toBe(1136090);
    expect(m.tco.fiveYear.paybackYearWarm).toBe(2);
  });

  it('every scenario total equals the sum of its parts', () => {
    for (const s of m.sizing.scenarios) {
      expect(s.totalMonthly).toBe(s.monthlyEcpuCost + s.monthlyStorageCost);
      expect(s.totalAnnual).toBe(s.annualEcpuCost + s.annualStorageCost);
      expect(s.annualEcpuCost).toBe(s.monthlyEcpuCost * 12);
    }
  });

  it('five-year cumulative arrays are the running sum of the yearly streams', () => {
    const sq = m.tco.fiveYear.statusQuoCum;
    expect(sq[4]).toBe(449500 * 5);
    for (let i = 1; i < sq.length; i++) expect(sq[i]!).toBeGreaterThan(sq[i - 1]!);
    expect(m.tco.fiveYear.warmCum[4]).toBe(m.tco.fiveYear.transitionYearCost + m.tco.adbWarmAnnual.central * 4);
  });

  it('the business case renders the headline numbers consistently', () => {
    const html = renderBusinessCase(m).html;
    expect(html).toContain('$450K');
    expect(html).toContain('$214K');
    expect(html).toContain('52%');
  });
});
