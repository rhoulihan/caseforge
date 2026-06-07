// Customer discount — a per-case SALES input (not an ENGINE_CONFIG formula constant). It is applied to
// the PROPOSED solution only: the Oracle ADB subscription (adbPrimary), the DR add-ons (warm/cold), and
// the one-time migration. The current-cost BASELINE (onpremComponents) is the customer's actual spend
// and is NEVER discounted. A 0% discount returns the inputs unchanged (strict no-op), so the
// deterministic golden fixtures are unaffected; clamped to [0, 100] defensively.

import type { TcoInputs, Range } from './types';

/** The multiplier a `discountPct` (clamped to [0,100]; NaN→0) applies to a proposed cost: `1 - pct/100`. */
export function discountFactor(discountPct: number): number {
  return 1 - Math.max(0, Math.min(100, discountPct || 0)) / 100;
}

/** Scale the proposed-cost components of `inputs` by `(1 - discountPct/100)`, leaving the baseline
 * (`onpremComponents`) untouched. `discountPct` is clamped to [0, 100]; 0 returns `inputs` as-is. */
export function applyDiscount(inputs: TcoInputs, discountPct: number): TcoInputs {
  const f = discountFactor(discountPct);
  if (f === 1) return inputs; // strict no-op — identical reference, goldens unchanged
  const scale = (r: Range): Range => ({ low: r.low * f, central: r.central * f, high: r.high * f });
  return {
    onpremComponents: inputs.onpremComponents, // BASELINE — the customer's current spend, undiscounted
    adbPrimary: scale(inputs.adbPrimary),
    coldDrAdd: scale(inputs.coldDrAdd),
    warmDrAdd: scale(inputs.warmDrAdd),
    migrationPs: scale(inputs.migrationPs),
  };
}
