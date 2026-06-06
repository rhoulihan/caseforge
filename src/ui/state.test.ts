import { describe, it, expect } from 'vitest';
import { initialWizardState, stepValidity, maxReachableStep, type WizardState } from './state';
import type { EvidenceBundle } from '../ingest/types';

const bundle: EvidenceBundle = { files: [], primitives: [{ kind: 'text', source: 'a', text: 'hi' }] };

function withSetup(over: Partial<WizardState> = {}): WizardState {
  return { ...initialWizardState(), config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000 }, hasApiKey: true, ...over };
}

describe('stepValidity', () => {
  it('initial state: nothing advance-valid except the terminal step', () => {
    const v = stepValidity(initialWizardState());
    expect(v[1]).toBe(false);
    expect(v[2]).toBe(false);
    expect(v[7]).toBe(true);
  });
  it('setup becomes valid only with config + apiKey + non-empty company', () => {
    expect(stepValidity(withSetup())[1]).toBe(true);
    expect(stepValidity(withSetup({ hasApiKey: false }))[1]).toBe(false);
    expect(stepValidity(withSetup({ config: { provider: 'claude', companyName: '  ', tokenBudget: 1 } }))[1]).toBe(false);
  });
  it('files valid only after setup + a non-empty bundle', () => {
    expect(stepValidity(withSetup({ bundle }))[2]).toBe(true);
    expect(stepValidity(withSetup())[2]).toBe(false);
    expect(stepValidity(withSetup({ bundle: { files: [], primitives: [] } }))[2]).toBe(false);
  });
  it('anonymize → confirm chain', () => {
    expect(stepValidity(withSetup({ bundle, anonBundle: bundle }))[3]).toBe(true);
    expect(stepValidity(withSetup({ bundle, anonBundle: bundle }))[4]).toBe(false);
    expect(stepValidity(withSetup({ bundle, anonBundle: bundle, confirmed: true }))[4]).toBe(true);
  });
});

describe('maxReachableStep', () => {
  it('is 1 initially', () => expect(maxReachableStep(initialWizardState())).toBe(1));
  it('advances as prior steps become valid', () => {
    expect(maxReachableStep(withSetup())).toBe(2); // setup valid → step 2 reachable
    expect(maxReachableStep(withSetup({ bundle }))).toBe(3);
    expect(maxReachableStep(withSetup({ bundle, anonBundle: bundle, confirmed: true }))).toBe(5);
  });
});
