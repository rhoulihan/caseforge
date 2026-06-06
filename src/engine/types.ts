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
