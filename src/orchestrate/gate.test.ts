import { describe, it, expect } from 'vitest';
import { buildGateData, applyGateAnswers } from './gate';
import { MONGODB_PROFILE } from '../profile/mongodb';
import { buildSufficiencyReport } from '../classify/sufficiency';
import type { TriageResult, BindingResult } from '../classify/types';
import type { DerivationMethod } from '../profile/types';
import type { FileReport } from '../ingest/types';

const files: FileReport[] = [];
const triageOf = (bindings: BindingResult[]): TriageResult => ({ profileId: 'mongodb', inventory: [], bindings });
const num = (signalId: string, value: number): BindingResult => ({ signalId, value, confidence: 1, method: 'keyvalue', evidence: [] });
const util = (signalId: string, method: DerivationMethod = 'numeric-series'): BindingResult => ({
  signalId,
  value: { avgPct: 0.18, peakPct: 0.45 },
  confidence: 0.95,
  method,
  evidence: [],
});

// All required satisfied EXCEPT util.primary (missing). Storage (data.storageSizeGb) is included as required.
const partial = [num('cluster.shardCount', 3), num('node.hoVcpu', 32), num('node.drVcpu', 16), util('util.hoSec'), util('util.dr'), num('data.storageSizeGb', 300)];

describe('buildGateData', () => {
  it('produces no items when all required signals are satisfied', () => {
    const suff = buildSufficiencyReport(triageOf([...partial, util('util.primary')]), files, MONGODB_PROFILE);
    const gate = buildGateData(suff, MONGODB_PROFILE);
    expect(gate.verdict).toBe('satisfied');
    expect(gate.items).toHaveLength(0);
  });

  it('produces a gate item for a missing required signal with a copy-pasteable request', () => {
    const suff = buildSufficiencyReport(triageOf(partial), files, MONGODB_PROFILE);
    const gate = buildGateData(suff, MONGODB_PROFILE);
    const item = gate.items.find((i) => i.signalId === 'util.primary');
    expect(item).toBeDefined();
    expect(item!.collectRequest.length).toBeGreaterThan(0);
  });
});

describe('applyGateAnswers', () => {
  it('a confirmed measurement unblocks and can keep an engineering-grade tier', () => {
    const r = applyGateAnswers(
      triageOf(partial),
      [{ signalId: 'util.primary', value: { avgPct: 0.18, peakPct: 0.45 }, confirmed: true }],
      files,
      MONGODB_PROFILE,
    );
    expect(r.blocked).toBe(false);
    expect(r.inputs).toBeDefined();
    expect(r.sufficiency.coverage.find((c) => c.signalId === 'util.primary')?.method).toBe('manual');
    expect(r.sufficiency.verdict.tier).toBe('engineering-grade');
  });

  it('an unconfirmed assumption unblocks the number but caps the tier below engineering-grade', () => {
    const r = applyGateAnswers(
      triageOf(partial),
      [{ signalId: 'util.primary', value: { avgPct: 0.18, peakPct: 0.45 }, confirmed: false }],
      files,
      MONGODB_PROFILE,
    );
    expect(r.blocked).toBe(false);
    expect(r.inputs).toBeDefined();
    expect(r.sufficiency.coverage.find((c) => c.signalId === 'util.primary')?.method).toBe('assumption-default');
    expect(r.sufficiency.verdict.tier).toBe('directional-estimate');
  });

  it('keeps a still-missing required signal blocked', () => {
    const r = applyGateAnswers(triageOf(partial), [], files, MONGODB_PROFILE);
    expect(r.blocked).toBe(true);
    expect(r.reasons.join(' ')).toContain('util.primary');
  });
});
