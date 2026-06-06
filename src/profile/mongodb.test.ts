import { describe, it, expect } from 'vitest';
import { MONGODB_PROFILE } from './mongodb';

const signals = MONGODB_PROFILE.signalSchema.signals;
const required = signals.filter((s) => s.criticality === 'required');

describe('MONGODB_PROFILE signal schema', () => {
  it('has exactly 6 required signals mapping 1:1 to every SizingInputs field', () => {
    expect(required).toHaveLength(6);
    const slots = required.map((s) => s.engineSlot).sort();
    expect(slots).toEqual(
      ['hoVcpu', 'drVcpu', 'shards', 'util.dr', 'util.hoSec', 'util.primary'].sort(),
    );
  });

  it('marks defaultable:false only on the three signals whose absence makes any ECPU number impossible', () => {
    const hardGap = signals.filter((s) => s.criticality === 'required' && !s.defaultable).map((s) => s.id);
    expect(hardGap.sort()).toEqual(['cluster.shardCount', 'node.hoVcpu', 'util.primary'].sort());
  });

  it('models the three util signals as avgPeak', () => {
    for (const id of ['util.primary', 'util.hoSec', 'util.dr']) {
      const s = signals.find((x) => x.id === id);
      expect(s?.valueKind).toBe('avgPeak');
    }
  });

  it('flags the dominant storage cost drivers as tcoCritical', () => {
    expect(signals.find((s) => s.id === 'data.logicalSizeGb')?.tcoCritical).toBe(true);
    expect(signals.find((s) => s.id === 'data.storageSizeGb')?.tcoCritical).toBe(true);
  });

  it('gives every signal a non-empty collectRequest and collectWhy', () => {
    for (const s of signals) {
      expect(s.collectRequest.length).toBeGreaterThan(0);
      expect(s.collectWhy.length).toBeGreaterThan(0);
    }
  });

  it('uses lowercase, globally-unique aliases', () => {
    const all: string[] = [];
    for (const s of signals) {
      for (const a of s.aliases) {
        expect(a).toBe(a.toLowerCase());
        all.push(a);
      }
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives every required signal at least one engineSlot and ids are unique', () => {
    expect(required.every((s) => typeof s.engineSlot === 'string' && s.engineSlot.length > 0)).toBe(true);
    const ids = signals.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defines a full set of method caps and tier floors', () => {
    const t = MONGODB_PROFILE.thresholds;
    expect(t.methodCap['numeric-series']).toBe(1);
    expect(t.methodCap['vision']).toBeLessThan(t.engFloor);
    expect(t.methodCap['assumption-default']).toBeLessThan(t.engFloor);
    expect(t.engFloor).toBeGreaterThan(t.missingFloor);
  });
});
