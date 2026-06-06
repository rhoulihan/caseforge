// The DocModel — the single pure-data structure the renderers consume. Numbers are computed by
// the engine (the Northwind fixture / the Plan 09 orchestrator assemble it); prose is REQUIRED input;
// charts reuse the existing src/charts types. The renderer reads verbatim — it never does math.

import type { CostChartData } from '../charts/costChart';
import type { FiveYearChartData } from '../charts/fiveYearChart';
import type { Range, RoleUtil } from '../engine/types';
import type { Consumed } from '../engine/sizing';
import type { SufficiencyReport } from '../classify/sufficiency-types';
import type { ClaimConfidence } from '../classify/confidence';

export interface SizingScenario {
  level: 'low' | 'central' | 'high';
  posture: 'conservative' | 'aggressive';
  base: number; // provisioned ECPU base
  ceiling2x: number;
  ceiling3x: number;
  monthlyEcpuCost: number;
  annualEcpuCost: number;
  monthlyStorageCost: number;
  annualStorageCost: number;
  totalMonthly: number;
  totalAnnual: number;
}

export interface SizingBasis {
  shards: number;
  hoVcpu: number;
  drVcpu: number;
  util: { primary: RoleUtil; hoSec: RoleUtil; dr: RoleUtil };
  assumptions: string[];
}

export interface SizingSection {
  basis: SizingBasis;
  consumed: Consumed; // {avg, peak, ratio} at workload scope
  scenarios: SizingScenario[];
  dataCompressedGb: number;
}

export interface DrOption {
  posture: 'warm' | 'cold';
  addedAnnual: Range;
  totalAnnual: Range;
  rtoText: string;
  rpoText: string;
  failover: string;
}

export interface FiveYear {
  years: string[];
  statusQuoCum: number[];
  warmCum: number[];
  coldCum?: number[];
  net5Warm: number;
  net5Cold: number;
  paybackYearWarm: number | null;
  migrationServices: Range;
  transitionYearCost: number;
}

export interface TcoSection {
  onprem: { components: Record<string, Range>; labels: Record<string, string>; total: Range };
  adbWarmAnnual: Range;
  adbColdAnnual: Range;
  savingWarm: { amount: number; pct: number };
  savingCold: { amount: number; pct: number };
  fiveYear: FiveYear;
  dr: DrOption[];
}

// Per-doc prose is REQUIRED — TypeScript fails if the orchestrator omits a field (no silent gaps).
export interface BusinessCaseProse {
  execSummary: string;
  fullyLoadedComparison: string;
  migrationPath: string;
  drContext: string;
  keyAssumptions: string;
  pullQuote: string;
  nextSteps: string;
}
export interface SizingBriefProse {
  workloadContext: string;
  provisioningApproach: string;
  sufficiencyStatement: string;
  followUps: string;
}
export interface TechnicalReviewProse {
  technicalNotes: string;
  riskAndMitigation: string;
  dataModelDecision: string;
  performanceValidation: string;
}

export type ClaimSection = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export interface ClaimInput {
  id: string;
  section: ClaimSection;
  claim: string;
  value: string | number;
  unit: string;
  /** Signal ids whose SufficiencyReport coverage backs this claim (sizing claims). */
  dependsOnSignals?: string[];
  /** Explicit provenance for cost/research claims not in the signal schema (e.g. the dossier). */
  declaredSource?: { label: string; confidence: ClaimConfidence };
  /** A rolled-up claim (downgraded one confidence tier). */
  derived?: boolean;
}

export interface DocModel {
  profileId: string;
  companyName: string;
  targetPlatform: string;
  preparedDate: string; // ISO 8601
  documentStatus: 'preliminary' | 'draft' | 'final';
  sizing: SizingSection;
  tco: TcoSection;
  charts: { cost: CostChartData; fiveYear: FiveYearChartData };
  sufficiency: SufficiencyReport;
  prose: { businessCase: BusinessCaseProse; sizingBrief: SizingBriefProse; technicalReview: TechnicalReviewProse };
  claims: ClaimInput[];
}

export interface RenderedDoc {
  filename: string;
  html: string;
}
