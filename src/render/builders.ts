// Deterministic builders that assemble a DocModel's numeric sections from inputs. These reuse the
// engine functions (never re-implement the math) and are pinned to the Northwind goldens by builders.test.
// They are the single source the orchestrator (and the Northwind fixture's goldens) agree on.

import type { SizingInputs, TcoInputs, Level, Range } from '../engine/types';
import { consumedEcpu, baseFor, ceilings } from '../engine/sizing';
import { onpremTotal, adbTotal, annualSaving, fiveYear, net5, paybackYear } from '../engine/tco';
import { applyDiscount, discountFactor } from '../engine/discount';
import { coldRtoHours } from '../engine/dr';
import { buildSizingClaims } from './claims';
import { ENGINE_CONFIG } from '../engine/config';
import { PALETTE } from '../charts/svg';
import type { CostChartData } from '../charts/costChart';
import type { FiveYearChartData } from '../charts/fiveYearChart';
import { fmtUsd } from './shared';
import type {
  DocModel,
  SizingScenario,
  SizingBasis,
  TcoSection,
  BusinessCaseProse,
  SizingBriefProse,
  TechnicalReviewProse,
  ClaimInput,
} from './types';
import type { SufficiencyReport } from '../classify/sufficiency-types';

export interface EcpuStorageRates {
  ecpuPerHr: number;
  storagePerGbMo: number;
  hoursPerMonth?: number;
}

const DEFAULT_HRS_PER_MO = ENGINE_CONFIG.adb.hoursPerMonth;

function scenario(posture: 'conservative' | 'aggressive', n: number, inputs: SizingInputs, rates: EcpuStorageRates, dataCompressedGb: number): SizingScenario {
  const c = consumedEcpu(inputs, 'workload');
  const base = baseFor(c.peak, c.avg, n);
  const { x2, x3 } = ceilings(base);
  const hrs = rates.hoursPerMonth ?? DEFAULT_HRS_PER_MO;
  const monthlyEcpuCost = Math.round(base * rates.ecpuPerHr * hrs);
  const monthlyStorageCost = Math.round(dataCompressedGb * rates.storagePerGbMo);
  return {
    level: 'central',
    posture,
    base,
    ceiling2x: x2,
    ceiling3x: x3,
    monthlyEcpuCost,
    annualEcpuCost: monthlyEcpuCost * 12,
    monthlyStorageCost,
    annualStorageCost: monthlyStorageCost * 12,
    totalMonthly: monthlyEcpuCost + monthlyStorageCost,
    totalAnnual: monthlyEcpuCost * 12 + monthlyStorageCost * 12,
  };
}

export function buildSizingScenarios(inputs: SizingInputs, rates: EcpuStorageRates, dataCompressedGb: number): SizingScenario[] {
  return [
    scenario('conservative', ENGINE_CONFIG.sizing.conservativeDivisor, inputs, rates, dataCompressedGb),
    scenario('aggressive', ENGINE_CONFIG.sizing.aggressiveDivisor, inputs, rates, dataCompressedGb),
  ];
}

const range = (fn: (l: Level) => number): Range => ({ low: fn('low'), central: fn('central'), high: fn('high') });
const cumsum = (xs: number[]): number[] => xs.map(((s) => (x: number) => (s += x))(0));

const ONPREM_LABELS: Record<string, string> = {
  license: 'MongoDB Enterprise Advanced',
  hardware: 'Servers (amortized)',
  storage: 'Storage hardware',
  facility: 'Data-center / facility',
  labor: 'DBA labor (loaded)',
  backup: 'Backup / DR tooling',
};

export function buildTcoSection(tcoInputs: TcoInputs, dataCompressedGb: number): TcoSection {
  const fyWarm = fiveYear(tcoInputs, 'warm', 'central');
  const fyCold = fiveYear(tcoInputs, 'cold', 'central');
  const labels: Record<string, string> = {};
  for (const k of Object.keys(tcoInputs.onpremComponents)) labels[k] = ONPREM_LABELS[k] ?? k;
  const coldRto = coldRtoHours(dataCompressedGb / 1000);
  return {
    onprem: { components: tcoInputs.onpremComponents, labels, total: range((l) => onpremTotal(tcoInputs, l)) },
    adbWarmAnnual: range((l) => adbTotal(tcoInputs, 'warm', l)),
    adbColdAnnual: range((l) => adbTotal(tcoInputs, 'cold', l)),
    savingWarm: annualSaving(tcoInputs, 'warm'),
    savingCold: annualSaving(tcoInputs, 'cold'),
    fiveYear: {
      years: ['Yr 1', 'Yr 2', 'Yr 3', 'Yr 4', 'Yr 5'],
      statusQuoCum: cumsum(fyWarm.B),
      warmCum: cumsum(fyWarm.A),
      coldCum: cumsum(fyCold.A),
      net5Warm: net5(tcoInputs, 'warm'),
      net5Cold: net5(tcoInputs, 'cold'),
      paybackYearWarm: paybackYear(tcoInputs, 'warm'),
      migrationServices: tcoInputs.migrationPs,
      transitionYearCost: fyWarm.A[0]!,
    },
    dr: [
      { posture: 'warm', addedAnnual: tcoInputs.warmDrAdd, totalAnnual: range((l) => adbTotal(tcoInputs, 'warm', l)), rtoText: '< 10 min', rpoText: '0 (switchover) / ≤ 1 min (failover)', failover: 'manual cross-region' },
      { posture: 'cold', addedAnnual: tcoInputs.coldDrAdd, totalAnnual: range((l) => adbTotal(tcoInputs, 'cold', l)), rtoText: `~${coldRto} hrs`, rpoText: '~1 min', failover: 'manual cross-region' },
    ],
  };
}

const segK = (n: number): number => Math.round(n / 1000);

interface Seg {
  value: number;
  color: string;
  name: string;
}

/** A bar whose total is the AUTHORITATIVE rounded figure; the last segment absorbs the grouped-
 *  rounding remainder so the stacked segments always sum exactly to the total. */
function costBar(lines: [string, string], totalCentral: number, segs: Seg[], rtoRpo: string, savePct?: number) {
  const total = segK(totalCentral);
  const head = segs.slice(0, -1);
  const last = segs[segs.length - 1]!;
  const headSum = head.reduce((s, x) => s + x.value, 0);
  return { lines, segments: [...head, { ...last, value: total - headSum }], total, rtoRpo, savePct };
}

export function buildCostChartData(_companyName: string, tco: TcoSection): CostChartData {
  const oc = tco.onprem.components;
  const cc = (k: string): number => oc[k]?.central ?? 0;
  const warmDr = tco.dr.find((d) => d.posture === 'warm')!;
  const coldDr = tco.dr.find((d) => d.posture === 'cold')!;
  const adbPrimary = tco.adbWarmAnnual.central - warmDr.addedAnnual.central; // primary = warm total - warm add
  const coldRtoLabel = `RTO ${coldDr.rtoText.replace(/\s*hrs?$/, 'h')}`; // engine-derived, not hardcoded

  const bars = [
    costBar(['On-prem MongoDB', 'fully-loaded'], tco.onprem.total.central, [
      { value: segK(cc('license')), color: PALETTE.slate, name: 'MongoDB EA subscription' },
      { value: segK(cc('hardware') + cc('storage') + cc('facility')), color: PALETTE.mid, name: 'Hardware · storage · facility' },
      { value: 0, color: PALETTE.lite, name: 'DBA / ops labor + backup' }, // absorbs the remainder
    ], ''),
    costBar(['Oracle ADB', '+ warm DR'], tco.adbWarmAnnual.central, [
      { value: segK(adbPrimary), color: PALETTE.green, name: 'ADB primary' },
      { value: 0, color: PALETTE.greenLt, name: 'Autonomous Data Guard' },
    ], 'RTO < 10m / RPO 0', tco.savingWarm.pct),
    costBar(['Oracle ADB', '+ cold DR'], tco.adbColdAnnual.central, [
      { value: segK(adbPrimary), color: PALETTE.green, name: 'ADB primary' },
      { value: 0, color: PALETTE.greenLt, name: 'backup-based DR' },
    ], coldRtoLabel, tco.savingCold.pct),
  ];
  const maxTotal = Math.max(...bars.map((b) => b.total));
  return {
    title: 'Fully-loaded annual cost',
    subtitle: 'On-prem MongoDB vs Oracle ADB (warm / cold DR)',
    maxK: Math.ceil((maxTotal + 50) / 100) * 100,
    bars,
    note: 'Software + people dominate on-prem; the ADB ECPU model bundles the license.',
  };
}

export function buildFiveYearChartData(tco: TcoSection): FiveYearChartData {
  const fy = tco.fiveYear;
  const maxCum = Math.max(...fy.statusQuoCum, ...fy.warmCum, ...(fy.coldCum ?? []));
  const maxM = Math.ceil((maxCum / 1_000_000 + 0.2) * 2) / 2; // up to the next 0.5M with headroom
  return {
    title: 'Five-year cumulative cost',
    subtitle: 'Renew once, prove out, cut over by Jan 2027',
    maxM,
    years: fy.years,
    statusQuo: fy.statusQuoCum,
    migrateWarm: fy.warmCum,
    migrateCold: fy.coldCum,
    paybackYear: fy.paybackYearWarm ?? 2,
    netSavingsLabel: `Net ~${fmtUsd(fy.net5Warm)} over 5 years (warm DR)`,
  };
}

export interface AssembleOptions {
  companyName: string;
  targetPlatform: string;
  preparedDate: string;
  documentStatus: 'preliminary' | 'draft' | 'final';
  sizingInputs: SizingInputs;
  assumptions: string[];
  rates: EcpuStorageRates;
  dataCompressedGb: number;
  tcoInputs: TcoInputs;
  sufficiency: SufficiencyReport;
  prose: { businessCase: BusinessCaseProse; sizingBrief: SizingBriefProse; technicalReview: TechnicalReviewProse };
  claims: ClaimInput[];
  discountPct?: number; // customer discount on the proposed solution; default 0 (strict no-op)
}

/** Assemble a complete DocModel: engine-computed numbers + caller-supplied prose/claims/sufficiency.
 * A customer discount (if any) is applied to the PROPOSED tcoInputs before the TCO math, so every
 * derived figure (savings, 5-year, payback, charts) reflects the discounted price; the baseline is
 * untouched. */
export function assembleDocModel(o: AssembleOptions): DocModel {
  const discountPct = o.discountPct ?? 0;
  const tco = buildTcoSection(applyDiscount(o.tcoInputs, discountPct), o.dataCompressedGb);
  // The discount applies to the whole PROPOSED Oracle cost, so the sizing-scenario ECPU/storage costs
  // (the indicative ADB cost shown in the Sizing Brief) are discounted by the same factor — keeping every
  // customer-facing Oracle figure consistent. Provisioning (ECPU counts) is unaffected; rates only scale price.
  const f = discountFactor(discountPct);
  const scenarioRates = f === 1 ? o.rates : { ...o.rates, ecpuPerHr: o.rates.ecpuPerHr * f, storagePerGbMo: o.rates.storagePerGbMo * f };
  // When discounted, also carry the pre-discount (list) ADB annual so the renderer can show list-vs-net.
  const listAdbAnnual = discountPct > 0 ? { warm: adbTotal(o.tcoInputs, 'warm', 'central'), cold: adbTotal(o.tcoInputs, 'cold', 'central') } : undefined;
  const basis: SizingBasis = {
    shards: o.sizingInputs.shards,
    hoVcpu: o.sizingInputs.hoVcpu,
    drVcpu: o.sizingInputs.drVcpu,
    util: o.sizingInputs.util,
    assumptions: o.assumptions,
  };
  const consumed = consumedEcpu(o.sizingInputs, 'workload');
  const scenarios = buildSizingScenarios(o.sizingInputs, scenarioRates, o.dataCompressedGb);
  // Always synthesize the authoritative sizing + TCO claims from the engine numbers, so the claims
  // checklist is never empty (even when the rep skipped cost research). Merge with any caller-supplied
  // (researched) cost claims, deduped by id — synthesized win, which keeps the set stable when a refine
  // passes the prior docModel.claims back in (the regenerated sz-/tco- claims replace, not duplicate).
  const synthClaims = buildSizingClaims({ basis, consumed, scenarios, tco });
  const synthIds = new Set(synthClaims.map((c) => c.id));
  const claims = [...synthClaims, ...o.claims.filter((c) => !synthIds.has(c.id))];
  return {
    profileId: o.sufficiency.profileId,
    companyName: o.companyName,
    targetPlatform: o.targetPlatform,
    preparedDate: o.preparedDate,
    documentStatus: o.documentStatus,
    discountPct,
    listAdbAnnual,
    sizing: { basis, consumed, scenarios, dataCompressedGb: o.dataCompressedGb },
    tco,
    charts: { cost: buildCostChartData(o.companyName, tco), fiveYear: buildFiveYearChartData(tco) },
    sufficiency: o.sufficiency,
    prose: o.prose,
    claims,
  };
}
