import { describe, it, expect } from 'vitest';
import { prepareRefineInstruction } from './refine';
import type { WizardState } from './state';
import type { LauncherClient } from '../launcher/client';

// Launcher that slugs a known phrase (mirrors the real literal replace over the map).
const launcher = {
  anonymize: async (_m: unknown, text: string) => ({ text: text.replace(/Acme Mutual/g, 'CF_ORG_01'), count: 1 }),
} as unknown as LauncherClient;

function stateWith(over: Partial<WizardState> = {}): WizardState {
  return {
    config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 0 },
    // Step 3 maps both the company and its salient token, so the detector finds nothing unmapped here.
    map: [
      { phrase: 'Acme Mutual', slug: 'CF_ORG_01' },
      { phrase: 'Acme', slug: 'CF_ORG_02' },
    ],
    refinementHistory: [],
    ...over,
  } as unknown as WizardState;
}

describe('prepareRefineInstruction', () => {
  it('slug-anonymizes a mapped name before the LLM', async () => {
    const r = await prepareRefineInstruction("emphasize Acme Mutual's resilience", stateWith(), launcher);
    expect('blocked' in r).toBe(false);
    if ('blocked' in r) throw new Error('unexpected block');
    expect(r.effective).toContain('CF_ORG_01');
    expect(r.effective).not.toContain('Acme Mutual');
    expect(r.slugged).toContain('CF_ORG_01');
  });

  it('blocks (fail-closed) when the instruction names someone NOT in the map', async () => {
    const r = await prepareRefineInstruction('mention our partner Globex Corporation', stateWith(), launcher);
    expect('blocked' in r).toBe(true);
    if (!('blocked' in r)) throw new Error('expected block');
    expect(r.blocked.some((n) => /Globex/.test(n))).toBe(true);
  });

  it('replays prior (already-slugged) refinements before the new one', async () => {
    const r = await prepareRefineInstruction('add a risk section', stateWith({ refinementHistory: [{ ts: 't', instruction: 'be concise', slugged: 'be concise', versionId: '001' }] } as Partial<WizardState>), launcher);
    if ('blocked' in r) throw new Error('unexpected block');
    expect(r.effective).toBe('be concise Then: add a risk section'); // prior replayed, then the new one
  });

  it('an empty instruction replays only prior history (or undefined)', async () => {
    expect((await prepareRefineInstruction('   ', stateWith(), launcher) as { effective?: string }).effective).toBeUndefined();
    const r = await prepareRefineInstruction('', stateWith({ refinementHistory: [{ ts: 't', instruction: 'be concise', slugged: 'be concise', versionId: '001' }] } as Partial<WizardState>), launcher);
    expect((r as { effective?: string }).effective).toBe('be concise');
  });
});
