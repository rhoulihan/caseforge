// Shared confidence tiering for the claims checklist. A claim backed by signal coverage takes the
// MINIMUM effective confidence of its backing signals (a chain is only as strong as its weakest
// link); a derived/rolled-up claim drops one tier to reflect compounded uncertainty.

import type { SignalCoverageItem } from './sufficiency-types';

export type ClaimConfidence = 'high' | 'medium' | 'low';

export function claimConfidenceFromSignals(
  signals: ReadonlyArray<Pick<SignalCoverageItem, 'effectiveConfidence'>>,
  isDerived: boolean,
): ClaimConfidence {
  if (signals.length === 0) return 'low';
  const min = Math.min(...signals.map((s) => s.effectiveConfidence));
  let tier: ClaimConfidence = min >= 0.85 ? 'high' : min >= 0.6 ? 'medium' : 'low';
  if (isDerived) tier = tier === 'high' ? 'medium' : 'low';
  return tier;
}
