import type { TcoInputs, Level, DrPosture } from './types';

/** Fully-loaded on-prem annual cost = sum of all components at the chosen level. */
export function onpremTotal(inputs: TcoInputs, level: Level): number {
  return Object.values(inputs.onpremComponents).reduce((sum, r) => sum + r[level], 0);
}

/** ADB annual cost = primary + the chosen DR posture's added cost. */
export function adbTotal(inputs: TcoInputs, dr: DrPosture, level: Level): number {
  const add =
    dr === 'cold' ? inputs.coldDrAdd[level] : dr === 'warm' ? inputs.warmDrAdd[level] : 0;
  return inputs.adbPrimary[level] + add;
}

/** Central annual saving (on-prem - ADB) and its percentage of on-prem. */
export function annualSaving(inputs: TcoInputs, dr: DrPosture): { amount: number; pct: number } {
  const base = onpremTotal(inputs, 'central');
  const amount = base - adbTotal(inputs, dr, 'central');
  return { amount, pct: Math.round((100 * amount) / base) };
}

/**
 * Five-year cost streams.
 * A (migrate): Year 1 = on-prem renewal + ADB primary prove-out + one-time migration; Years 2-5 = ADB with DR.
 * B (status quo): on-prem every year.
 */
export function fiveYear(
  inputs: TcoInputs,
  dr: DrPosture,
  level: Level
): { A: number[]; B: number[] } {
  const op = onpremTotal(inputs, level);
  const y1 = op + inputs.adbPrimary[level] + inputs.migrationPs[level];
  const steady = adbTotal(inputs, dr, level);
  return { A: [y1, steady, steady, steady, steady], B: [op, op, op, op, op] };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** Net 5-year savings at central = status-quo total - migrate total. */
export function net5(inputs: TcoInputs, dr: DrPosture): number {
  const { A, B } = fiveYear(inputs, dr, 'central');
  return sum(B) - sum(A);
}

/** First year (1-indexed, >1) where cumulative migrate cost <= cumulative status-quo cost; null if never. */
export function paybackYear(inputs: TcoInputs, dr: DrPosture): number | null {
  const { A, B } = fiveYear(inputs, dr, 'central');
  let ca = 0;
  let cb = 0;
  for (let i = 0; i < A.length; i++) {
    ca += A[i]!;
    cb += B[i]!;
    if (i > 0 && cb >= ca) return i + 1;
  }
  return null;
}
