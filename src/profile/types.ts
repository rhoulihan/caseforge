// Profile-agnostic Source-Profile vocabulary (spec §9). This is the contract triage binds
// AGAINST and that SizingInputs are assembled FROM (via engineSlot). No MongoDB specifics
// live here — adding PostgreSQL/MySQL later = a new SourceProfile implementing this shape.

export type Criticality = 'required' | 'recommended' | 'optional';

/** How a signal value was obtained. Drives the confidence cap in the sufficiency report. */
export type DerivationMethod =
  | 'numeric-series' // native avg/peak/P95 computed in JS from a time-series — highest trust
  | 'keyvalue' // exact key==alias parse of a literal value
  | 'table-lookup' // exact lookup (e.g. Atlas tier -> vCPU)
  | 'vision' // LLM read a value off a chart image
  | 'llm-text' // LLM classified ambiguous prose/table
  | 'heuristic' // inferred / fuzzy-aliased structural bind
  | 'assumption-default' // a defaulted value standing in for missing evidence (NOT a measurement)
  | 'manual'; // a rep-confirmed measurement entered at the §8.5 gate

export type SignalValueKind = 'scalar' | 'avgPeak' | 'enum';

export interface SignalSpec {
  id: string;
  label: string;
  unit?: string;
  valueKind: SignalValueKind;
  criticality: Criticality;
  /** Can a flagged assumption fill it at the gate? (`required` + `defaultable:false` = a hard gap.) */
  defaultable: boolean;
  /** True for signals that gate a major TCO cost line even if the sizing engine doesn't need them. */
  tcoCritical?: boolean;
  derivableBy: DerivationMethod[];
  /** Lowercase match tokens for heuristic/keyvalue binding. */
  aliases: string[];
  /** The SizingInputs field this required signal feeds (e.g. 'shards', 'util.primary'). */
  engineSlot?: string;
  /** Plain-language, copy-pasteable customer request when this signal is missing. */
  collectRequest: string;
  /** Why the rep needs it — surfaced in the sufficiency report. */
  collectWhy: string;
}

export interface SignalSchema {
  signals: SignalSpec[];
}

/** Confidence caps per derivation method + the verdict-tier floors. Centralized so non-Mongo profiles can tune. */
export interface ProfileThresholds {
  methodCap: Record<DerivationMethod, number>;
  missingFloor: number; // below this effective confidence -> 'missing'
  engFloor: number; // at/above this -> 'satisfied'
  engMean: number; // mean required confidence needed for 'engineering-grade'
}

export interface SourceProfile {
  id: string;
  signalSchema: SignalSchema;
  thresholds: ProfileThresholds;
}
