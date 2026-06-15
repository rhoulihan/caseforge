export interface Range {
  low: number;
  central: number;
  high: number;
}
export type Level = keyof Range;
export type DrPosture = 'none' | 'cold' | 'warm';

export interface TcoInputs {
  onpremComponents: Record<string, Range>;
  adbPrimary: Range;
  coldDrAdd: Range;
  warmDrAdd: Range;
  migrationPs: Range;
}

export interface RoleUtil {
  avgPct: number;
  peakPct: number;
}
export type Scope = 'workload' | 'fullcluster';
export interface SizingInputs {
  shards: number;
  hoVcpu: number;
  drVcpu: number;
  util: { primary: RoleUtil; hoSec: RoleUtil; dr: RoleUtil };
}

/** The storage figure the rep provided + whether it was already compressed (on-disk) + the assumed
 * Oracle compression ratio. The EFFECTIVE on-disk size used by the cost = effectiveCompressedGb(rawGb,
 * compressed, ratio) — computed once in toSizingInputs (engine/storage.ts). */
export interface StorageBasis {
  rawGb: number;
  compressed: boolean;
  ratio: number;
}
