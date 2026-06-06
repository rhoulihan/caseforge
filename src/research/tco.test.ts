import { describe, it, expect } from 'vitest';
import { ProviderError } from '../provider';
import type { LLM, CompleteOptions, CompleteResult } from '../provider';
import { newBudget } from '../orchestrate/budget';
import {
  validateTcoProfile,
  normalizeAndValidate,
  researchTcoCosts,
  sourcesToClaims,
  TcoResearchValidationError,
  type TcoProfile,
  type TcoResearchResult,
  type CostSourceRow,
} from './tco';
import { NORTHWIND } from '../engine/fixtures/northwind';

const RATES = { inputPer1k: 0.005, outputPer1k: 0.025 };
const NOW = Date.UTC(2026, 5, 5); // 2026-06-05
const PROFILE: TcoProfile = { dbType: 'mongodb', shards: 3, hoVcpu: 16, drVcpu: 8, dataCompressedGb: 500, licenseModel: 'enterprise', drPosture: 'warm' };

class MockLLM implements LLM {
  calls: CompleteOptions[] = [];
  constructor(private readonly responses: Array<CompleteResult | Error>) {}
  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    this.calls.push(opts);
    const r = this.responses[this.calls.length - 1];
    if (r === undefined) throw new Error(`MockLLM: no response for call ${this.calls.length}`);
    if (r instanceof Error) throw r;
    return r;
  }
}

function freshSources(): CostSourceRow[] {
  return [
    { component: 'license', source: 'Vendor price list', url: 'https://ex.com/a', asOfDate: '2026-05-01', sourceQuality: 'published' },
    { component: 'adbPrimary', source: 'Oracle pricing', url: 'https://oracle.com/p', asOfDate: '2026-05-01', sourceQuality: 'published' },
  ];
}

function responseFrom(inputs = NORTHWIND, sources: CostSourceRow[] = freshSources(), usage = { inputTokens: 1800, outputTokens: 900 }): CompleteResult {
  const payload = {
    onpremComponents: inputs.onpremComponents,
    adbPrimary: inputs.adbPrimary,
    coldDrAdd: inputs.coldDrAdd,
    warmDrAdd: inputs.warmDrAdd,
    migrationPs: inputs.migrationPs,
    sources,
  };
  return { text: JSON.stringify(payload), usage, raw: {} };
}

describe('validateTcoProfile', () => {
  it('accepts a valid profile', () => expect(() => validateTcoProfile(PROFILE)).not.toThrow());
  it('rejects a bad dbType', () => expect(() => validateTcoProfile({ ...PROFILE, dbType: 'oracle' as never })).toThrow(TcoResearchValidationError));
  it('rejects non-positive shards', () => expect(() => validateTcoProfile({ ...PROFILE, shards: 0 })).toThrow(/shards/));
  it('rejects non-positive dataCompressedGb', () => expect(() => validateTcoProfile({ ...PROFILE, dataCompressedGb: -1 })).toThrow(/dataCompressedGb/));
  it('rejects a bad licenseModel', () => expect(() => validateTcoProfile({ ...PROFILE, licenseModel: 'free' as never })).toThrow(/licenseModel/));
  it('rejects a bad drPosture', () => expect(() => validateTcoProfile({ ...PROFILE, drPosture: 'hot' as never })).toThrow(/drPosture/));
  it('allows drVcpu of 0 (no DR)', () => expect(() => validateTcoProfile({ ...PROFILE, drVcpu: 0, drPosture: 'none' })).not.toThrow());
});

describe('normalizeAndValidate', () => {
  it('keeps an ordered range unchanged', () => {
    const { inputs } = normalizeAndValidate(JSON.parse(responseFrom().text));
    expect(inputs.onpremComponents.license).toEqual(NORTHWIND.onpremComponents.license);
  });
  it('expands a point-estimate to ±20%', () => {
    const { inputs } = normalizeAndValidate(JSON.parse(responseFrom({ ...NORTHWIND, migrationPs: { low: 100, central: 100, high: 100 } }).text));
    expect(inputs.migrationPs).toEqual({ low: 80, central: 100, high: 120 });
  });
  it('rejects an inverted range', () => {
    expect(() => normalizeAndValidate(JSON.parse(responseFrom({ ...NORTHWIND, adbPrimary: { low: 200, central: 100, high: 50 } }).text))).toThrow(/monotonic/);
  });
  it('rejects a tight-spread range whose central is outside [low, high] (no silent fix)', () => {
    // high>=low and a tight low/high spread, but central is way outside — must NOT expand+accept.
    expect(() => normalizeAndValidate(JSON.parse(responseFrom({ ...NORTHWIND, adbPrimary: { low: 99, central: 200, high: 100 } }).text))).toThrow(/monotonic/);
  });
  it('rejects a negative number', () => {
    expect(() => normalizeAndValidate(JSON.parse(responseFrom({ ...NORTHWIND, coldDrAdd: { low: -1, central: 10, high: 20 } }).text))).toThrow(TcoResearchValidationError);
  });
  it('rejects a missing component', () => {
    const bad = JSON.parse(responseFrom().text);
    delete bad.onpremComponents.storage;
    expect(() => normalizeAndValidate(bad)).toThrow(/storage/);
  });
  it('rejects an impossible asOfDate', () => {
    const r = responseFrom(NORTHWIND, [{ component: 'license', source: 'x', url: 'https://x', asOfDate: '2026-13-01', sourceQuality: 'published' }]);
    expect(() => normalizeAndValidate(JSON.parse(r.text))).toThrow(/asOfDate/);
  });
  it('requires a url for published but not for training-cutoff', () => {
    const pub = responseFrom(NORTHWIND, [{ component: 'license', source: 'x', url: '', asOfDate: '2026-05-01', sourceQuality: 'published' }]);
    expect(() => normalizeAndValidate(JSON.parse(pub.text))).toThrow(/url/);
    const tc = responseFrom(NORTHWIND, [{ component: 'license', source: 'training data', url: '', asOfDate: '2025-02-01', sourceQuality: 'training-cutoff' }]);
    expect(() => normalizeAndValidate(JSON.parse(tc.text))).not.toThrow();
  });
});

describe('researchTcoCosts', () => {
  it('parses + validates a fresh web-search response (published -> 0.75)', async () => {
    const llm = new MockLLM([responseFrom()]);
    const r = await researchTcoCosts(llm, 'm', PROFILE, { now: NOW });
    expect(r.inputs).toEqual(NORTHWIND);
    expect(r.confidence).toBe(0.75);
    expect(r.usage).toEqual({ inputTokens: 1800, outputTokens: 900 });
    expect(llm.calls[0]!.webSearch).toBe(true);
    expect(llm.calls[0]!.jsonSchema?.name).toBe('tco_cost_research');
  });

  it('retries without web-search on ProviderError and marks sources training-cutoff (-> 0.5)', async () => {
    const err = new ProviderError({ kind: 'invalid_request', provider: 'claude', message: 'web_search unsupported', retryable: false, status: 400 });
    const llm = new MockLLM([err, responseFrom()]);
    const r = await researchTcoCosts(llm, 'm', PROFILE, { now: NOW });
    expect(r.confidence).toBe(0.5);
    expect(r.sourcing.every((s) => s.sourceQuality === 'training-cutoff')).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.webSearch).toBeFalsy();
    expect(r.warnings.join(' ')).toMatch(/training-cutoff/);
  });

  it('surfaces a transient overload (529) clearly WITHOUT a wasteful knowledge-only retry', async () => {
    const overloaded = new ProviderError({ kind: 'server', provider: 'claude', message: 'Overloaded', retryable: true, status: 529 });
    const llm = new MockLLM([overloaded, responseFrom()]); // second response must NOT be used
    await expect(researchTcoCosts(llm, 'm', PROFILE, { now: NOW })).rejects.toThrow(/overloaded/i);
    expect(llm.calls).toHaveLength(1); // no second (still-overloaded) call
  });

  it('wraps a retry-call ProviderError as TcoResearchValidationError and records a skip', async () => {
    const err1 = new ProviderError({ kind: 'invalid_request', provider: 'claude', message: 'web_search unsupported', retryable: false, status: 400 });
    const err2 = new ProviderError({ kind: 'rate_limit', provider: 'claude', message: 'slow down', retryable: true, status: 429 });
    const budget = newBudget('m', RATES, { tokens: 1_000_000 });
    const llm = new MockLLM([err1, err2]);
    await expect(researchTcoCosts(llm, 'm', PROFILE, { now: NOW, budget })).rejects.toThrow(TcoResearchValidationError);
    expect(llm.calls).toHaveLength(2);
    expect(budget.checkpoints.at(-1)?.skipped).toBe(true);
    expect(budget.checkpoints.at(-1)?.stage).toBe('research-retry');
  });

  it('surfaces the web-search failure in warnings on fallback (observability)', async () => {
    const err = new ProviderError({ kind: 'invalid_request', provider: 'claude', message: 'web_search unsupported', retryable: false, status: 400 });
    const r = await researchTcoCosts(new MockLLM([err, responseFrom()]), 'm', PROFILE, { now: NOW });
    expect(r.warnings.join(' ')).toMatch(/web search unavailable/);
  });

  it('takes the weakest-link confidence (0.5) when web sources mix with a training-cutoff one', async () => {
    const mixed: CostSourceRow[] = [
      { component: 'license', source: 'Vendor list', url: 'https://x', asOfDate: '2026-05-01', sourceQuality: 'published' },
      { component: 'storage', source: 'training', url: '', asOfDate: '2025-02-01', sourceQuality: 'training-cutoff' },
    ];
    const r = await researchTcoCosts(new MockLLM([responseFrom(NORTHWIND, mixed)]), 'm', PROFILE, { now: NOW });
    expect(r.confidence).toBe(0.5);
  });

  it('treats a source exactly 180 days old as fresh, 181 days as stale', async () => {
    const iso = (days: number): string => {
      const d = new Date(NOW - days * 86_400_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    };
    const fresh: CostSourceRow[] = [{ component: 'license', source: 'p', url: 'https://x', asOfDate: iso(180), sourceQuality: 'published' }];
    const stale: CostSourceRow[] = [{ component: 'license', source: 'p', url: 'https://x', asOfDate: iso(181), sourceQuality: 'published' }];
    expect((await researchTcoCosts(new MockLLM([responseFrom(NORTHWIND, fresh)]), 'm', PROFILE, { now: NOW })).confidence).toBe(0.75);
    expect((await researchTcoCosts(new MockLLM([responseFrom(NORTHWIND, stale)]), 'm', PROFILE, { now: NOW })).confidence).toBe(0.6);
  });

  it('throws on non-JSON WITHOUT retrying', async () => {
    const llm = new MockLLM([{ text: 'not json at all', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} }]);
    await expect(researchTcoCosts(llm, 'm', PROFILE, { now: NOW })).rejects.toThrow(TcoResearchValidationError);
    expect(llm.calls).toHaveLength(1);
  });

  it('blocks on an exhausted budget and records a skip (no LLM call)', async () => {
    const budget = newBudget('m', RATES, { tokens: 100 });
    const llm = new MockLLM([responseFrom()]);
    await expect(researchTcoCosts(llm, 'm', PROFILE, { now: NOW, budget })).rejects.toThrow(TcoResearchValidationError);
    expect(llm.calls).toHaveLength(0);
    expect(budget.checkpoints.at(-1)?.skipped).toBe(true);
    expect(budget.checkpoints.at(-1)?.stage).toBe('research');
  });

  it('records usage on a generous budget', async () => {
    const budget = newBudget('m', RATES, { tokens: 1_000_000 });
    await researchTcoCosts(new MockLLM([responseFrom()]), 'm', PROFILE, { now: NOW, budget });
    const cp = budget.checkpoints.find((c) => c.stage === 'research');
    expect(cp?.inputTokens).toBe(1800);
    expect(cp?.skipped).toBeFalsy();
  });

  it('caps confidence at 0.6 when all web sources are stale', async () => {
    const stale: CostSourceRow[] = [{ component: 'license', source: 'old list', url: 'https://x', asOfDate: '2025-01-01', sourceQuality: 'published' }];
    const r = await researchTcoCosts(new MockLLM([responseFrom(NORTHWIND, stale)]), 'm', PROFILE, { now: NOW });
    expect(r.confidence).toBe(0.6);
  });

  it('caps confidence at 0.5 when all sources are training-cutoff', async () => {
    const tc: CostSourceRow[] = [{ component: 'license', source: 'training', url: '', asOfDate: '2025-02-01', sourceQuality: 'training-cutoff' }];
    const r = await researchTcoCosts(new MockLLM([responseFrom(NORTHWIND, tc)]), 'm', PROFILE, { now: NOW });
    expect(r.confidence).toBe(0.5);
  });
});

describe('sourcesToClaims', () => {
  it('emits one claim per component and is NEVER high confidence', async () => {
    const result = await researchTcoCosts(new MockLLM([responseFrom()]), 'm', PROFILE, { now: NOW });
    const claims = sourcesToClaims(result);
    expect(claims).toHaveLength(10);
    expect(new Set(claims.map((c) => c.id)).size).toBe(10);
    expect(claims.every((c) => c.section === 'D')).toBe(true);
    expect(claims.every((c) => c.declaredSource?.confidence !== 'high')).toBe(true);
    const license = claims.find((c) => c.id === 'research:license')!;
    expect(license.value).toBe(NORTHWIND.onpremComponents.license!.central);
    expect(license.declaredSource?.confidence).toBe('medium'); // 0.75 -> medium
    expect(license.declaredSource?.label).toContain('2026-05-01');
    const mig = claims.find((c) => c.id === 'research:migrationPs')!;
    expect(mig.unit).toBe('USD');
    expect(mig.value).toBe(NORTHWIND.migrationPs.central);
  });

  it('maps low confidence to the low tier and returns a fresh array each call', () => {
    const result: TcoResearchResult = { inputs: NORTHWIND, sourcing: [], confidence: 0.5, usage: { inputTokens: 0, outputTokens: 0 }, warnings: [] };
    const a = sourcesToClaims(result);
    const b = sourcesToClaims(result);
    expect(a).not.toBe(b);
    expect(a.every((c) => c.declaredSource?.confidence === 'low')).toBe(true);
  });

  it('clamps an out-of-contract confidence (>0.75) so a researched claim is NEVER high', () => {
    const rogue: TcoResearchResult = { inputs: NORTHWIND, sourcing: [], confidence: 0.99, usage: { inputTokens: 0, outputTokens: 0 }, warnings: [] };
    expect(sourcesToClaims(rogue).every((c) => c.declaredSource?.confidence === 'medium')).toBe(true);
  });
});
