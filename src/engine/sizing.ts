import type { SizingInputs, Scope, RoleUtil } from './types';
import { ENGINE_CONFIG } from './config';

export interface Consumed {
  avg: number;
  peak: number;
  ratio: number;
}

/** Consumed ECPU at average and peak utilization, by scope. Consumed vCPU is mapped to ECPU by
 * `ecpuPerVcpu` (Phase-1 = 1:1; see config). */
export function consumedEcpu(i: SizingInputs, scope: Scope, ecpuPerVcpu: number = ENGINE_CONFIG.sizing.ecpuPerVcpu): Consumed {
  const role = (vcpu: number, u: RoleUtil) => ({
    avg: i.shards * vcpu * u.avgPct * ecpuPerVcpu,
    peak: i.shards * vcpu * u.peakPct * ecpuPerVcpu,
  });
  const prim = role(i.hoVcpu, i.util.primary);
  if (scope === 'workload') {
    return { avg: prim.avg, peak: prim.peak, ratio: prim.peak / prim.avg };
  }
  const sec = role(i.hoVcpu, i.util.hoSec);
  const dr = role(i.drVcpu, i.util.dr);
  const avg = prim.avg + sec.avg + dr.avg;
  const peak = prim.peak + sec.peak + dr.peak;
  return { avg, peak, ratio: peak / avg };
}

/** Provisioned base = ceil(max(Peak/n, Average)); never below average (avoids continuous bursting). */
export function baseFor(peak: number, avg: number, n: number): number {
  return Math.ceil(Math.max(peak / n, avg));
}

/** Autoscale band = the configured multipliers × the provisioned base (default 2× and 3×). */
export function ceilings(base: number, multipliers: readonly [number, number] = ENGINE_CONFIG.sizing.autoscaleMultipliers): { x2: number; x3: number } {
  return { x2: multipliers[0] * base, x3: multipliers[1] * base };
}
