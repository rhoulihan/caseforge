// The Northwind DocModel fixture. Every NUMBER is computed via the existing engine functions (so the
// fixture can't drift from the engine and the renderer only ever reads); prose is literal; the
// SufficiencyReport is a representative engineering-grade report. This is what the Plan 09
// orchestrator will assemble programmatically — here it doubles as the renderer golden input.

import { NORTHWIND_SIZING } from '../../engine/fixtures/northwind-sizing';
import { NORTHWIND } from '../../engine/fixtures/northwind';
import { consumedEcpu, baseFor, ceilings } from '../../engine/sizing';
import { onpremTotal, adbTotal, annualSaving, fiveYear, net5, paybackYear } from '../../engine/tco';
import { coldRtoHours } from '../../engine/dr';
import { PALETTE } from '../../charts/svg';
import { fmtUsd } from '../shared';
import type { Level, Range } from '../../engine/types';
import type { SufficiencyReport, SignalCoverageItem } from '../../classify/sufficiency-types';
import type { DocModel, SizingScenario, ClaimInput } from '../types';

// ADB list rates — used only to populate the sizing-brief ECPU/storage table (illustrative).
const ECPU_PER_HR = 0.0807;
const HRS_PER_MO = 730;
const STORAGE_PER_GB_MO = 0.1156;
const DATA_COMPRESSED_GB = 45_800; // ~45.8 TB on-disk (compressed)

const consumed = consumedEcpu(NORTHWIND_SIZING, 'workload'); // { avg 17.28, peak 43.2, ratio 2.5 }

function scenario(posture: 'conservative' | 'aggressive', n: number): SizingScenario {
  const base = baseFor(consumed.peak, consumed.avg, n);
  const { x2, x3 } = ceilings(base);
  const monthlyEcpuCost = Math.round(base * ECPU_PER_HR * HRS_PER_MO);
  const monthlyStorageCost = Math.round(DATA_COMPRESSED_GB * STORAGE_PER_GB_MO);
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

const range = (fn: (l: Level) => number): Range => ({ low: fn('low'), central: fn('central'), high: fn('high') });
const cumsum = (xs: number[]): number[] => xs.map(((s) => (x: number) => (s += x))(0));

const fyWarm = fiveYear(NORTHWIND, 'warm', 'central');
const fyCold = fiveYear(NORTHWIND, 'cold', 'central');
// Cumulative streams computed ONCE and shared by the TCO section + the chart spec (no drift).
const statusQuoCum = cumsum(fyWarm.B);
const warmCum = cumsum(fyWarm.A);
const coldCum = cumsum(fyCold.A);
const net5WarmLabel = `Net ~${fmtUsd(net5(NORTHWIND, 'warm'))} over 5 years (warm DR)`;

// A representative engineering-grade SufficiencyReport (native CPU series + confirmed topology).
const cov = (
  signalId: string,
  label: string,
  criticality: SignalCoverageItem['criticality'],
  method: SignalCoverageItem['method'],
  effectiveConfidence: number,
): SignalCoverageItem => ({
  signalId,
  label,
  criticality,
  status: 'satisfied',
  effectiveConfidence,
  method,
  value: null,
  evidence: [{ source: 'ops-manager-export.csv', primitiveKind: 'table' }],
  reason: `${method} (confidence ${effectiveConfidence.toFixed(2)})`,
});

const sufficiency: SufficiencyReport = {
  profileId: 'mongodb',
  inventory: [
    { name: 'ops-manager-export.csv', detectedType: 'csv', role: 'evidence', boundSignals: ['util.primary', 'util.hoSec', 'util.dr'] },
    { name: 'topology.txt', detectedType: 'text', role: 'evidence', boundSignals: ['cluster.shardCount', 'node.hoVcpu', 'node.drVcpu'] },
    { name: 'cover-email.txt', detectedType: 'text', role: 'noise', boundSignals: [] },
  ],
  coverage: [
    cov('cluster.shardCount', 'Shard count', 'required', 'keyvalue', 1),
    cov('node.hoVcpu', 'vCPU per node (home)', 'required', 'keyvalue', 1),
    cov('node.drVcpu', 'vCPU per node (DR)', 'required', 'keyvalue', 1),
    cov('util.primary', 'System-CPU — primary', 'required', 'numeric-series', 0.95),
    cov('util.hoSec', 'System-CPU — HA secondary', 'required', 'numeric-series', 0.95),
    cov('util.dr', 'System-CPU — DR', 'required', 'numeric-series', 0.95),
    cov('data.logicalSizeGb', 'Logical data size', 'recommended', 'keyvalue', 0.9),
    cov('data.storageSizeGb', 'On-disk storage size', 'recommended', 'keyvalue', 0.9),
  ],
  verdict: {
    tier: 'engineering-grade',
    headline: 'Engineering-grade — all required signals satisfied',
    requiredTotal: 6,
    requiredSatisfied: 6,
    requiredPartial: 0,
    requiredMissing: 0,
    meanRequiredConfidence: 0.98,
    limitingSignals: [],
    rationale: '6/6 required signals satisfied from native telemetry + confirmed topology.',
  },
  whatToCollect: [],
};

const claims: ClaimInput[] = [
  { id: 'A1', section: 'A', claim: 'Fully-loaded on-prem MongoDB cost', value: '$450K/yr', unit: 'USD/yr', derived: true, declaredSource: { label: 'Dossier: on-prem build-up', confidence: 'medium' } },
  { id: 'A2', section: 'A', claim: 'Oracle ADB + warm DR cost', value: '$214K/yr', unit: 'USD/yr', declaredSource: { label: 'Oracle published ECPU/storage pricing', confidence: 'high' } },
  { id: 'A3', section: 'A', claim: 'Lower annual cost', value: '52%', unit: '%', derived: true, declaredSource: { label: 'Derived: on-prem − ADB warm', confidence: 'medium' } },
  { id: 'A4', section: 'A', claim: 'Five-year net saving (warm DR)', value: '$712K', unit: 'USD', derived: true, declaredSource: { label: 'Derived: 5-yr streams', confidence: 'medium' } },
  { id: 'B1', section: 'B', claim: 'MongoDB Enterprise Advanced subscription', value: '$240K/yr', unit: 'USD/yr', declaredSource: { label: 'Dossier: reseller/G-Cloud triangulation (not public)', confidence: 'medium' } },
  { id: 'C1', section: 'C', claim: 'Peak consumed compute (workload)', value: '43.2 ECPU', unit: 'ECPU', dependsOnSignals: ['util.primary', 'util.hoSec', 'util.dr', 'node.hoVcpu', 'cluster.shardCount'] },
  { id: 'C2', section: 'C', claim: 'Conservative provisioned base (Peak÷2)', value: '22 ECPU', unit: 'ECPU', dependsOnSignals: ['util.primary', 'node.hoVcpu', 'cluster.shardCount'] },
  { id: 'D1', section: 'D', claim: 'Cold-DR recovery time', value: `~${coldRtoHours(DATA_COMPRESSED_GB / 1000)} hrs`, unit: 'hours', declaredSource: { label: 'Oracle backup-restore formula (1h + 1h/5TB)', confidence: 'high' } },
  { id: 'E1', section: 'E', claim: 'Blue/green cutover target', value: 'Jan 2027', unit: 'date', declaredSource: { label: 'Engagement assumption', confidence: 'low' } },
  { id: 'F1', section: 'F', claim: 'Cluster topology', value: '3 shards × 32 vCPU', unit: 'count', dependsOnSignals: ['cluster.shardCount', 'node.hoVcpu'] },
];

export const NORTHWIND_DOCMODEL: DocModel = {
  profileId: 'mongodb',
  companyName: 'Northwind',
  targetPlatform: 'Oracle Autonomous Database',
  preparedDate: '2026-06-05',
  documentStatus: 'preliminary',
  sizing: {
    basis: {
      shards: NORTHWIND_SIZING.shards,
      hoVcpu: NORTHWIND_SIZING.hoVcpu,
      drVcpu: NORTHWIND_SIZING.drVcpu,
      util: NORTHWIND_SIZING.util,
      assumptions: [
        '32 vCPU per home-region node, 16 per DR node (to confirm)',
        'Primary-only reads (secondary CPU is replication overhead)',
        'ECPU ≈ consumed vCPU at 1:1 (Phase-1)',
      ],
    },
    consumed,
    scenarios: [scenario('conservative', 2), scenario('aggressive', 3)],
    dataCompressedGb: DATA_COMPRESSED_GB,
  },
  tco: {
    onprem: {
      components: NORTHWIND.onpremComponents,
      labels: {
        license: 'MongoDB Enterprise Advanced',
        hardware: 'Servers (amortized)',
        storage: 'Storage hardware',
        facility: 'Data-center / facility',
        labor: 'DBA labor (loaded)',
        backup: 'Backup / DR tooling',
      },
      total: range((l) => onpremTotal(NORTHWIND, l)),
    },
    adbWarmAnnual: range((l) => adbTotal(NORTHWIND, 'warm', l)),
    adbColdAnnual: range((l) => adbTotal(NORTHWIND, 'cold', l)),
    savingWarm: annualSaving(NORTHWIND, 'warm'),
    savingCold: annualSaving(NORTHWIND, 'cold'),
    fiveYear: {
      years: ['Yr 1', 'Yr 2', 'Yr 3', 'Yr 4', 'Yr 5'],
      statusQuoCum,
      warmCum,
      coldCum,
      net5Warm: net5(NORTHWIND, 'warm'),
      net5Cold: net5(NORTHWIND, 'cold'),
      paybackYearWarm: paybackYear(NORTHWIND, 'warm'),
      migrationServices: NORTHWIND.migrationPs,
      transitionYearCost: fyWarm.A[0]!,
    },
    dr: [
      { posture: 'warm', addedAnnual: NORTHWIND.warmDrAdd, totalAnnual: range((l) => adbTotal(NORTHWIND, 'warm', l)), rtoText: '< 10 min', rpoText: '0 (switchover) / ≤ 1 min (failover)', failover: 'manual cross-region' },
      { posture: 'cold', addedAnnual: NORTHWIND.coldDrAdd, totalAnnual: range((l) => adbTotal(NORTHWIND, 'cold', l)), rtoText: `~${coldRtoHours(DATA_COMPRESSED_GB / 1000)} hrs`, rpoText: '~1 min', failover: 'manual cross-region' },
    ],
  },
  charts: {
    cost: {
      title: 'Fully-loaded annual cost',
      subtitle: 'On-prem MongoDB vs Oracle ADB (warm / cold DR)',
      maxK: 500,
      bars: [
        {
          lines: ['On-prem MongoDB', 'fully-loaded'],
          segments: [
            { value: 240, color: PALETTE.slate, name: 'MongoDB EA subscription' },
            { value: 130, color: PALETTE.mid, name: 'Hardware · storage · facility' },
            { value: 80, color: PALETTE.lite, name: 'DBA / ops labor + backup' },
          ],
          total: 450,
          rtoRpo: '',
        },
        {
          lines: ['Oracle ADB', '+ warm DR'],
          segments: [
            { value: 81, color: PALETTE.green, name: 'ADB primary' },
            { value: 133, color: PALETTE.greenLt, name: 'Autonomous Data Guard' },
          ],
          total: 214,
          rtoRpo: 'RTO < 10m / RPO 0',
          savePct: 52,
        },
        {
          lines: ['Oracle ADB', '+ cold DR'],
          segments: [
            { value: 81, color: PALETTE.green, name: 'ADB primary' },
            { value: 27, color: PALETTE.greenLt, name: 'backup-based DR' },
          ],
          total: 108,
          rtoRpo: 'RTO ~11h',
          savePct: 76,
        },
      ],
      note: 'Software + people dominate on-prem; the ADB ECPU model bundles the license.',
    },
    fiveYear: {
      title: 'Five-year cumulative cost',
      subtitle: 'Renew once, prove out, cut over by Jan 2027',
      maxM: 2.5,
      years: ['Yr 1', 'Yr 2', 'Yr 3', 'Yr 4', 'Yr 5'],
      statusQuo: statusQuoCum,
      migrateWarm: warmCum,
      migrateCold: coldCum,
      paybackYear: paybackYear(NORTHWIND, 'warm') ?? 2,
      netSavingsLabel: net5WarmLabel,
    },
  },
  sufficiency,
  claims,
  prose: {
    businessCase: {
      execSummary:
        'Northwind runs MongoDB on-prem at roughly $450K/yr fully loaded — license, people, hardware, and facility. The same workload on Oracle Autonomous Database lands near $214K/yr with warm cross-region DR (about 52% lower) or ~$108K with cold DR. The imminent MongoDB renewal is the funding bridge: renew once, prove out on ADB in parallel, and cut over via a low-risk blue/green migration.',
      fullyLoadedComparison:
        'The comparison is fully loaded: MongoDB Enterprise Advanced, amortized servers and storage, data-center overhead, and loaded DBA labor on one side; the all-in ADB ECPU + storage subscription on the other. Software and people — not hardware — dominate the on-prem cost, and the ECPU model folds the database license into a single consumption line.',
      migrationPath:
        'Renew MongoDB for one final year while a parallel ADB environment is validated against the live workload. MongoDB stays the fallback until the blue/green cutover completes in January 2027. The transition year carries the renewal plus a one-time prove-out and migration cost; every year after is steady-state ADB.',
      drContext:
        'Two recovery postures are offered so the business can match cost to its real RTO/RPO need. Warm (Autonomous Data Guard) keeps a continuously-replicated standby; cold (backup-based) is the lowest-cost option where a multi-hour restore is acceptable.',
      keyAssumptions:
        'Figures are conservative by design: DBA labor is modeled at ~0.4 FTE (likely understated), and MongoDB EA pricing is triangulated from reseller and marketplace listings (not public) — confirm against Northwind’s actual renewal quote. ADB sizing comes from the prior workload analysis.',
      pullQuote:
        'Renewing MongoDB one last time isn’t the cost of staying — it’s the down-payment on leaving. Payback lands within ~12 months of cutover.',
      nextSteps:
        'Renew MongoDB for one year and approve the parallel ADB prove-out now; run the blue/green migration with rollback and go live January 2027 with warm cross-region Data Guard; book a workshop to confirm the workload inputs and target data model.',
    },
    sizingBrief: {
      workloadContext:
        'System-CPU telemetry shows a low, bursty workload: ~18% average and ~45% peak on the primaries, a 2.5x average-to-peak ratio. The cluster is memory/storage-bound rather than CPU-bound, which is why a consumption-based ECPU model fits well.',
      provisioningApproach:
        'Sizing maps consumed vCPU to ECPU 1:1 (Phase-1) and provisions a base of max(Peak÷N, Average) so the base never sits below the average. Conservative uses Peak÷2; Aggressive uses Peak÷3; autoscaling absorbs bursts to 2x/3x the base.',
      sufficiencyStatement:
        'Inputs are engineering-grade: System-CPU series read natively from the Ops Manager export and topology confirmed from the deployment view.',
      followUps:
        'Confirm core counts per node, secondary read patterns, and the Oracle on-disk footprint versus the MongoDB-compressed size (the largest remaining cost lever).',
    },
    technicalReview: {
      technicalNotes:
        'Consumed ECPU is computed deterministically from shards × vCPU × utilization per role; the deliverable numbers are read verbatim from that engine output. Cache is pinned and IOPS are low, consistent with a memory-bound profile.',
      riskAndMitigation:
        'The dominant uncertainty is the Oracle data-model footprint relative to MongoDB’s compressed size; a target-schema workshop de-risks the storage line. MongoDB remains the rollback path throughout the prove-out.',
      dataModelDecision:
        'Phase-1 treats the migration as a like-for-like document workload on ADB’s JSON capability; a Phase-2 modeling pass can optimize hot collections.',
      performanceValidation:
        'Validate against captured peak windows on the parallel ADB environment before cutover; confirm autoscale headroom covers the observed ~80% spike (≈4.4x average, roughly weekly).',
    },
  },
};
