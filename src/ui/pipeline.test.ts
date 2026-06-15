import { describe, it, expect } from 'vitest';
import { buildRunConfig, tcoProfileFromState, DEFAULT_TCO_INPUTS } from './pipeline';
import { initialWizardState, type WizardState } from './state';
import type { TriageResult } from '../classify/types';
import type { EvidenceBundle } from '../ingest/types';

const anonBundle: EvidenceBundle = { files: [], primitives: [{ kind: 'text', source: 'a', text: 'CF_ORG_01 migration' }] };

const triage = {
  profileId: 'mongodb',
  inventory: [],
  bindings: [
    { signalId: 'cluster.shardCount', value: 3, method: 'keyvalue', confidence: 1, evidence: [] },
    { signalId: 'node.hoVcpu', value: 32, method: 'keyvalue', confidence: 1, evidence: [] },
    { signalId: 'node.drVcpu', value: 16, method: 'keyvalue', confidence: 1, evidence: [] },
    { signalId: 'util.primary', value: { avgPct: 0.18, peakPct: 0.45 }, method: 'numeric-series', confidence: 0.95, evidence: [] },
    { signalId: 'util.hoSec', value: { avgPct: 0.12, peakPct: 0.35 }, method: 'numeric-series', confidence: 0.95, evidence: [] },
    { signalId: 'util.dr', value: { avgPct: 0.08, peakPct: 0.2 }, method: 'numeric-series', confidence: 0.95, evidence: [] },
    { signalId: 'data.storageSizeGb', value: 2000, method: 'numeric-series', confidence: 1, evidence: [] },
    // Marked compressed (on-disk) so effective == raw — this fixture pins the storage threading, not the
    // compression factor (toSizingInputs divides an uncompressed figure; its goldens live in triage.test).
    { signalId: 'data.storageCompressionState', value: 'compressed', method: 'keyvalue', confidence: 1, evidence: [] },
  ],
} as unknown as TriageResult;

function stateWith(over: Partial<WizardState> = {}): WizardState {
  return {
    ...initialWizardState(),
    config: { provider: 'claude', companyName: 'Northwind Mutual', tokenBudget: 250_000, discountPct: 0 },
    hasApiKey: true,
    bundle: anonBundle,
    anonBundle,
    triage,
    ...over,
  };
}

describe('tcoProfileFromState', () => {
  it('builds a TcoProfile from the post-gate bound signals (no fabricated topology)', () => {
    const p = tcoProfileFromState(stateWith());
    expect(p).toMatchObject({ dbType: 'mongodb', shards: 3, hoVcpu: 32, drVcpu: 16, dataCompressedGb: 2000 });
    expect(p.drPosture).toBeUndefined(); // dr.posture not bound -> omitted, not fabricated 'warm'
  });
});

describe('buildRunConfig', () => {
  it('assembles a RunConfig: anonymized bundle, REAL company name, cached triage, budget, rates from triage', () => {
    const cfg = buildRunConfig({ state: stateWith(), apiKey: 'sk', tcoInputs: DEFAULT_TCO_INPUTS, claims: [], preparedDate: '2026-06-06' });
    expect(cfg.bundle).toBe(anonBundle);
    expect(cfg.companyName).toBe('Northwind Mutual'); // real name (safe — not in the LLM prose context)
    expect(cfg.triage).toBe(triage); // reused, no re-classify
    expect(cfg.budgetLimit).toEqual({ tokens: 250_000 });
    expect('dataCompressedGb' in cfg.rates).toBe(false); // storage threads from the gate, not the rates
    expect(cfg.profile.id).toBe('mongodb');
    expect(typeof cfg.llm!.complete).toBe('function');
    expect(cfg.model).toBe('claude-opus-4-8'); // provider=claude → Claude model id
  });

  it('sets the OpenAI model id when the provider is openai', () => {
    const cfg = buildRunConfig({
      state: stateWith({ config: { provider: 'openai', companyName: 'Northwind Mutual', tokenBudget: 250_000, discountPct: 0 } }),
      apiKey: 'sk-proj-x',
      tcoInputs: DEFAULT_TCO_INPUTS,
      claims: [],
      preparedDate: '2026-06-06',
    });
    expect(cfg.model).toBe('gpt-5.5'); // provider=openai → OpenAI model id
  });

  it('throws if the prerequisites are missing', () => {
    expect(() => buildRunConfig({ state: stateWith({ triage: null }), apiKey: 'sk', tcoInputs: DEFAULT_TCO_INPUTS, claims: [], preparedDate: '2026-06-06' })).toThrow(/classification/);
  });

  it('forwards the current discount and a refine instruction into the RunConfig', () => {
    const cfg = buildRunConfig({
      state: stateWith({ config: { provider: 'claude', companyName: 'Northwind Mutual', tokenBudget: 250_000, discountPct: 20 } }),
      apiKey: 'sk',
      tcoInputs: DEFAULT_TCO_INPUTS,
      claims: [],
      preparedDate: '2026-06-06',
      proseInstruction: 'tighten the exec summary',
    });
    expect(cfg.discountPct).toBe(20); // current discount → recomputed every regenerate
    expect(cfg.proseInstruction).toBe('tighten the exec summary');
  });
});
