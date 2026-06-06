// The Data Intake & Sufficiency Report payload (spec §7) — a rep-facing answer to "what was
// understood, what's missing, what to collect, and how good a result can this support".

import type { DetectedType } from '../ingest/types';
import type { Criticality, DerivationMethod } from '../profile/types';
import type { Coverage, EvidenceRef, SignalValue } from './types';

export type ResultTier = 'blocked' | 'directional-estimate' | 'engineering-grade';

export interface InventoryItem {
  name: string;
  detectedType?: DetectedType;
  role: 'evidence' | 'noise' | 'unrecognized'; // v1 has no 'flagged' — anon quarantine threads in Plan 10
  boundSignals: string[];
  note?: string;
}

export interface SignalCoverageItem {
  signalId: string;
  label: string;
  criticality: Criticality;
  status: Coverage;
  effectiveConfidence: number; // raw confidence capped by derivation method
  method: DerivationMethod | null;
  value: SignalValue | null;
  evidence: EvidenceRef[];
  reason: string;
}

export interface OutputQualityVerdict {
  tier: ResultTier;
  headline: string;
  requiredTotal: number;
  requiredSatisfied: number;
  requiredPartial: number;
  requiredMissing: number;
  meanRequiredConfidence: number;
  limitingSignals: string[];
  rationale: string;
}

export interface WhatToCollectItem {
  signalId: string;
  criticality: Criticality;
  severity: 'blocking' | 'upgrade';
  request: string;
  why: string;
  currentState: 'missing' | 'low-confidence';
}

export interface SufficiencyReport {
  profileId: string;
  inventory: InventoryItem[];
  coverage: SignalCoverageItem[];
  verdict: OutputQualityVerdict;
  whatToCollect: WhatToCollectItem[];
}
