import { describe, it, expect } from 'vitest';
import { claimConfidenceFromSignals } from './confidence';

const c = (effectiveConfidence: number) => ({ effectiveConfidence });

describe('claimConfidenceFromSignals', () => {
  it('tiers by the minimum effective confidence across the backing signals', () => {
    expect(claimConfidenceFromSignals([c(0.9), c(0.95)], false)).toBe('high');
    expect(claimConfidenceFromSignals([c(0.7), c(0.65)], false)).toBe('medium');
    expect(claimConfidenceFromSignals([c(0.5)], false)).toBe('low');
  });
  it('downgrades a derived (rolled-up) claim one tier, never below low', () => {
    expect(claimConfidenceFromSignals([c(0.9), c(0.95)], true)).toBe('medium');
    expect(claimConfidenceFromSignals([c(0.7)], true)).toBe('low');
    expect(claimConfidenceFromSignals([c(0.5)], true)).toBe('low');
  });
  it('treats a claim backed by no signals as low', () => {
    expect(claimConfidenceFromSignals([], false)).toBe('low');
  });
});
