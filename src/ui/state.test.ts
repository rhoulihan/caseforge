import { describe, it, expect } from 'vitest';
import { initialWizardState, stepValidity, maxReachableStep, type WizardState } from './state';
import type { EvidenceBundle } from '../ingest/types';

const bundle: EvidenceBundle = { files: [], primitives: [{ kind: 'text', source: 'a', text: 'hi' }] };

function withSetup(over: Partial<WizardState> = {}): WizardState {
  return { ...initialWizardState(), config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, ...over };
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
    expect(stepValidity(withSetup({ config: { provider: 'claude', companyName: '  ', tokenBudget: 1, discountPct: 0 } }))[1]).toBe(false);
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
  it('image gate fails closed: an anonBundle with an image requires imagesReviewed + imagesVerifiedClean', () => {
    const withImage: EvidenceBundle = { files: [], primitives: [{ kind: 'image', source: 'c.png', mime: 'image/png', bytes: new Uint8Array([1]) }] };
    // both flags required when images are present
    expect(stepValidity(withSetup({ bundle, anonBundle: withImage, imagesReviewed: false, imagesVerifiedClean: false }))[3]).toBe(false);
    expect(stepValidity(withSetup({ bundle, anonBundle: withImage, imagesReviewed: true, imagesVerifiedClean: false }))[3]).toBe(false); // reviewed but not verified clean
    expect(stepValidity(withSetup({ bundle, anonBundle: withImage, imagesReviewed: true, imagesVerifiedClean: true }))[3]).toBe(true); // both set → unblocked
    // text-only anonBundle needs no image review at all
    expect(stepValidity(withSetup({ bundle, anonBundle: bundle, imagesReviewed: false, imagesVerifiedClean: false }))[3]).toBe(true);
  });
  it('single verified-clean gate: step 3 is invalid until imagesVerifiedClean is true (with image in anonBundle)', () => {
    const withImage: EvidenceBundle = { files: [], primitives: [{ kind: 'image', source: 'c.png', mime: 'image/png', bytes: new Uint8Array([1]) }] };
    expect(stepValidity(withSetup({ bundle, anonBundle: withImage, imagesReviewed: true, imagesVerifiedClean: false }))[3]).toBe(false);
    expect(stepValidity(withSetup({ bundle, anonBundle: withImage, imagesReviewed: true, imagesVerifiedClean: true }))[3]).toBe(true);
    // no images in anonBundle (all excluded) → valid without the checkbox
    expect(stepValidity(withSetup({ bundle, anonBundle: bundle, imagesReviewed: true, imagesVerifiedClean: false }))[3]).toBe(true);
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
