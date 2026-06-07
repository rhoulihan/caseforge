// Triage result shapes — the typed handoff classify -> sufficiency -> engine. Bindings carry
// a RAW confidence; the sufficiency report applies the per-method cap (cap policy lives on the
// profile's ProfileThresholds). Tier and what-to-collect live in the SufficiencyReport, NOT here.

import type { Primitive } from '../ingest/types';
import type { DerivationMethod } from '../profile/types';
import type { QualContext } from './qual-context';

export type Coverage = 'satisfied' | 'partial' | 'missing';

export interface EvidenceRef {
  source: string; // the primitive's source file
  primitiveKind: Primitive['kind'];
  locator?: string; // e.g. column header, sheet name, page
}

/** A scalar signal value, an avg/peak pair (util/iops), or an enum string (edition, readPreference). */
export type SignalValue = number | { avgPct: number; peakPct: number } | string;

export interface BindingResult {
  signalId: string;
  value?: SignalValue;
  confidence: number; // RAW 0..1; the method cap is applied in sufficiency, not here
  method: DerivationMethod;
  evidence: EvidenceRef[];
  note?: string;
}

export interface PrimitiveClassification {
  source: string;
  kind: Primitive['kind'];
  role: string; // 'metric-time-series' | 'cost-model' | 'topology' | 'prose' | 'noise' | ...
  boundSignals: string[];
  ignored: boolean; // true when treated as noise
  note?: string;
}

export interface TriageResult {
  profileId: string;
  inventory: PrimitiveClassification[];
  bindings: BindingResult[];
  /** Qualitative deliverable context mined alongside signals (concerns/objections/timeline/positioning). */
  qualContext?: QualContext;
  /** Set when any util panel role was assigned by the load/positional heuristic — surfaced for rep override. */
  roleWarning?: string;
}
