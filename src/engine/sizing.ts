import type { SizingInputs, Scope, RoleUtil } from './types';

export interface Consumed {
  avg: number;
  peak: number;
  ratio: number;
}

/** Consumed ECPU (≈ consumed vCPU, net 1:1) at average and peak utilization, by scope. */
export function consumedEcpu(i: SizingInputs, scope: Scope): Consumed {
  const role = (vcpu: number, u: RoleUtil) => ({
    avg: i.shards * vcpu * u.avgPct,
    peak: i.shards * vcpu * u.peakPct,
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

/** Autoscale band: 2x and 3x the provisioned base. */
export function ceilings(base: number): { x2: number; x3: number } {
  return { x2: 2 * base, x3: 3 * base };
}
