import { describe, it, expect } from 'vitest';
import { buildSizingScenarios, buildTcoSection, buildCostChartData, buildFiveYearChartData, assembleDocModel } from './builders';
import { NORTHWIND_SIZING } from '../engine/fixtures/northwind-sizing';
import { NORTHWIND } from '../engine/fixtures/northwind';
import { NORTHWIND_DOCMODEL } from './fixtures/northwind-docmodel';
import { buildCostChart } from '../charts/costChart';
import { buildFiveYearChart } from '../charts/fiveYearChart';
import { withinFrame, noCollisions } from '../charts/svg';
import { ENGINE_CONFIG } from '../engine/config';

// Rates from the central config (so this golden tests production rates); the asserted output numbers
// below stay pinned — if a rate in config changes, those assertions fail and force a deliberate update.
const rates = { ecpuPerHr: ENGINE_CONFIG.adb.ecpuPerHr, storagePerGbMo: ENGINE_CONFIG.adb.storagePerGbMo };
const DATA_GB = 45_800;

describe('buildSizingScenarios', () => {
  const scenarios = buildSizingScenarios(NORTHWIND_SIZING, rates, DATA_GB);
  it('produces conservative (÷2) and aggressive (÷3) scenarios reproducing the engine goldens', () => {
    const c = scenarios.find((s) => s.posture === 'conservative')!;
    const a = scenarios.find((s) => s.posture === 'aggressive')!;
    expect([c.base, c.ceiling2x, c.ceiling3x]).toEqual([22, 44, 66]);
    expect([a.base, a.ceiling2x, a.ceiling3x]).toEqual([18, 36, 54]);
    expect(c.monthlyEcpuCost).toBe(1296); // round(22 * 0.0807 * 730)
    expect(a.monthlyEcpuCost).toBe(1060); // round(18 * 0.0807 * 730)
    expect(c.monthlyStorageCost).toBe(5294); // round(45800 * 0.1156)
  });
  it('keeps every scenario total equal to the sum of its parts', () => {
    for (const s of scenarios) {
      expect(s.totalMonthly).toBe(s.monthlyEcpuCost + s.monthlyStorageCost);
      expect(s.totalAnnual).toBe(s.annualEcpuCost + s.annualStorageCost);
      expect(s.annualEcpuCost).toBe(s.monthlyEcpuCost * 12);
    }
  });
});

describe('buildTcoSection', () => {
  const tco = buildTcoSection(NORTHWIND, DATA_GB);
  it('reproduces the TCO goldens', () => {
    expect(tco.onprem.total.central).toBe(449500);
    expect(tco.adbWarmAnnual.central).toBe(213649);
    expect(tco.adbColdAnnual.central).toBe(107746);
    expect(tco.savingWarm).toEqual({ amount: 235851, pct: 52 });
    expect(tco.fiveYear.net5Warm).toBe(712478);
    expect(tco.fiveYear.net5Cold).toBe(1136090);
    expect(tco.fiveYear.paybackYearWarm).toBe(2);
    expect(tco.fiveYear.warmCum[0]).toBe(tco.fiveYear.transitionYearCost);
    expect(tco.fiveYear.warmCum[1]).toBe(tco.fiveYear.transitionYearCost + 213649);
    expect(tco.fiveYear.warmCum[4]).toBe(tco.fiveYear.transitionYearCost + 213649 * 4);
  });
  it('produces warm and cold DR options with engine-derived RTO', () => {
    const warm = tco.dr.find((d) => d.posture === 'warm')!;
    const cold = tco.dr.find((d) => d.posture === 'cold')!;
    expect(warm.rtoText).toContain('10 min');
    expect(cold.rtoText).toContain('11'); // coldRtoHours(45.8) = 11
  });
});

describe('customer discount (via assembleDocModel)', () => {
  const base = buildTcoSection(NORTHWIND, DATA_GB);
  const opts = {
    companyName: 'Northwind',
    targetPlatform: 'Oracle Autonomous Database',
    preparedDate: '2026-06-05',
    documentStatus: 'preliminary' as const,
    sizingInputs: NORTHWIND_SIZING,
    assumptions: [],
    rates,
    dataCompressedGb: DATA_GB,
    storageBasis: { rawGb: 45_800, compressed: true, ratio: 3 },
    tcoInputs: NORTHWIND,
    sufficiency: NORTHWIND_DOCMODEL.sufficiency,
    prose: NORTHWIND_DOCMODEL.prose,
    claims: NORTHWIND_DOCMODEL.claims,
  };

  it('default (no discount) is a strict golden no-op', () => {
    const dm = assembleDocModel(opts);
    expect(dm.discountPct).toBe(0);
    expect(dm.tco.adbWarmAnnual.central).toBe(213649);
    expect(dm.tco.savingWarm).toEqual({ amount: 235851, pct: 52 });
  });

  it('discounts the proposed ADB cost (25%) but never the on-prem baseline', () => {
    const dm = assembleDocModel({ ...opts, discountPct: 25 });
    expect(dm.discountPct).toBe(25);
    expect(dm.tco.adbWarmAnnual.central).toBeCloseTo(base.adbWarmAnnual.central * 0.75, 2);
    expect(dm.tco.adbColdAnnual.central).toBeCloseTo(base.adbColdAnnual.central * 0.75, 2);
    expect(dm.tco.onprem.total.central).toBe(base.onprem.total.central); // baseline untouched
  });

  it('raises the savings % and feeds the discounted figure into the cost chart', () => {
    const dm = assembleDocModel({ ...opts, discountPct: 25 });
    expect(dm.tco.savingWarm.pct).toBeGreaterThan(base.savingWarm.pct); // cheaper proposal → bigger saving
    const warmBar = dm.charts.cost.bars.find((b) => b.lines.join(' ').includes('warm'))!;
    expect(warmBar.total).toBe(Math.round(dm.tco.adbWarmAnnual.central / 1000)); // chart uses the discounted total
  });

  it('also discounts the indicative sizing-scenario Oracle costs (consistent across the deliverable set)', () => {
    const b = assembleDocModel(opts); // 0%
    const dm = assembleDocModel({ ...opts, discountPct: 25 });
    expect(dm.sizing.scenarios[0]!.totalAnnual / b.sizing.scenarios[0]!.totalAnnual).toBeCloseTo(0.75, 1); // cost scaled
    expect(dm.sizing.scenarios[0]!.base).toBe(b.sizing.scenarios[0]!.base); // provisioning (ECPU) unchanged
  });

  it('carries the list-vs-net display figure only when discounted', () => {
    expect(assembleDocModel(opts).listAdbAnnual).toBeUndefined(); // 0% → no list figure
    const dm = assembleDocModel({ ...opts, discountPct: 25 });
    expect(dm.listAdbAnnual!.warm).toBe(213649); // pre-discount list, from undiscounted inputs
  });
});

describe('chart builders', () => {
  const tco = buildTcoSection(NORTHWIND, DATA_GB);
  it('builds a 3-bar cost chart whose segments sum to each total and savePct is read from the TCO', () => {
    const cost = buildCostChartData('Northwind', tco);
    expect(cost.bars).toHaveLength(3);
    expect(cost.bars[1]!.savePct).toBe(52);
    expect(cost.bars[2]!.savePct).toBe(76);
    expect(cost.bars[0]!.total).toBe(Math.round(tco.onprem.total.central / 1000)); // authoritative, not segment-sum
    expect(cost.bars[1]!.total).toBe(Math.round(tco.adbWarmAnnual.central / 1000));
    expect(cost.bars[2]!.rtoRpo).toContain('11'); // engine-derived cold RTO, not hardcoded
    for (const bar of cost.bars) expect(bar.segments.reduce((s, seg) => s + seg.value, 0)).toBe(bar.total);
    const s = buildCostChart(cost);
    expect(withinFrame(s, 16)).toBe(true);
    expect(noCollisions(s)).toBe(true);
    expect(s.hasNonFinite()).toBe(false);
  });
  it('builds a five-year chart from the TCO cumulative arrays that respects the invariants', () => {
    const fy = buildFiveYearChartData(tco);
    expect(fy.paybackYear).toBe(2);
    expect(fy.netSavingsLabel).toContain('$712K');
    const s = buildFiveYearChart(fy);
    expect(withinFrame(s, 16)).toBe(true);
    expect(noCollisions(s)).toBe(true);
    expect(s.hasNonFinite()).toBe(false);
  });
});

describe('assembleDocModel', () => {
  const docModel = assembleDocModel({
    companyName: 'Northwind',
    targetPlatform: 'Oracle Autonomous Database',
    preparedDate: '2026-06-05',
    documentStatus: 'preliminary',
    sizingInputs: NORTHWIND_SIZING,
    assumptions: ['32 vCPU per home node (to confirm)', 'Primary-only reads'],
    rates,
    dataCompressedGb: DATA_GB,
    storageBasis: { rawGb: 45_800, compressed: true, ratio: 3 },
    tcoInputs: NORTHWIND,
    sufficiency: NORTHWIND_DOCMODEL.sufficiency,
    prose: NORTHWIND_DOCMODEL.prose,
    claims: NORTHWIND_DOCMODEL.claims,
  });
  it('assembles a complete DocModel whose numbers match the render goldens (drift guard)', () => {
    expect(docModel.sizing.scenarios.map((s) => s.base)).toEqual([22, 18]);
    expect(docModel.tco.adbWarmAnnual.central).toBe(213649);
    expect(docModel.tco.savingWarm.pct).toBe(52);
    expect(docModel.tco.fiveYear.net5Warm).toBe(712478);
    expect(docModel.charts.fiveYear.paybackYear).toBe(2);
    expect(docModel.charts.cost.bars).toHaveLength(3);
    expect(docModel.sizing.consumed.ratio).toBe(2.5);
    expect(docModel.prose.businessCase.execSummary.length).toBeGreaterThan(0);
    expect(docModel.sizing.basis.assumptions.length).toBe(2);
  });

  it('synthesizes the claims checklist from the engine numbers even when no claims are supplied', () => {
    const dm = assembleDocModel({
      companyName: 'Northwind',
      targetPlatform: 'Oracle Autonomous Database',
      preparedDate: '2026-06-05',
      documentStatus: 'preliminary',
      sizingInputs: NORTHWIND_SIZING,
      assumptions: [],
      rates,
      dataCompressedGb: DATA_GB,
      storageBasis: { rawGb: 45_800, compressed: true, ratio: 3 },
      tcoInputs: NORTHWIND,
      sufficiency: NORTHWIND_DOCMODEL.sufficiency,
      prose: NORTHWIND_DOCMODEL.prose,
      claims: [], // the rep skipped cost research — the checklist must still populate
    });
    expect(dm.claims.length).toBeGreaterThan(0);
    expect(dm.claims.some((c) => c.id === 'sz-shards')).toBe(true);
    expect(dm.claims.some((c) => c.id === 'tco-onprem')).toBe(true);
  });

  it('dedups synthesized claims against caller-supplied ones by id (stable across a refine round-trip)', () => {
    const opts2 = {
      companyName: 'Northwind',
      targetPlatform: 'Oracle Autonomous Database',
      preparedDate: '2026-06-05',
      documentStatus: 'preliminary' as const,
      sizingInputs: NORTHWIND_SIZING,
      assumptions: [],
      rates,
      dataCompressedGb: DATA_GB,
      storageBasis: { rawGb: 45_800, compressed: true, ratio: 3 },
      tcoInputs: NORTHWIND,
      sufficiency: NORTHWIND_DOCMODEL.sufficiency,
      prose: NORTHWIND_DOCMODEL.prose,
    };
    const first = assembleDocModel({ ...opts2, claims: [] });
    // Feed the prior claims back in (what a Refine regenerate does) — the count must not grow.
    const second = assembleDocModel({ ...opts2, claims: first.claims });
    expect(second.claims.length).toBe(first.claims.length);
  });
});
