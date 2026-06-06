import type { SizingInputs } from '../types';

// Northwind workload sizing inputs (System-CPU utilization read from Ops Manager charts).
export const NORTHWIND_SIZING: SizingInputs = {
  shards: 3,
  hoVcpu: 32,
  drVcpu: 16,
  util: {
    primary: { avgPct: 0.18, peakPct: 0.45 },
    hoSec: { avgPct: 0.12, peakPct: 0.35 },
    dr: { avgPct: 0.08, peakPct: 0.2 },
  },
};
