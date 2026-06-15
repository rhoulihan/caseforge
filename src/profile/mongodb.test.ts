import { describe, it, expect } from 'vitest';
import { MONGODB_PROFILE } from './mongodb';

const signals = MONGODB_PROFILE.signalSchema.signals;
const required = signals.filter((s) => s.criticality === 'required');

describe('MONGODB_PROFILE signal schema', () => {
  it('has exactly 7 required signals: 6 mapping 1:1 to every SizingInputs field + data.storageSizeGb (no engineSlot)', () => {
    expect(required).toHaveLength(7);
    // The 6 compute-required signals each map to an engineSlot; storage drives TCO/cost but not ECPU.
    const slots = required.filter((s) => s.engineSlot !== undefined).map((s) => s.engineSlot).sort();
    expect(slots).toEqual(
      ['hoVcpu', 'drVcpu', 'shards', 'util.dr', 'util.hoSec', 'util.primary'].sort(),
    );
    expect(required.find((s) => s.id === 'data.storageSizeGb')?.engineSlot).toBeUndefined();
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

  it('gives every compute-required signal an engineSlot; storage (data.storageSizeGb) deliberately has none; ids are unique', () => {
    // data.storageSizeGb is required (blocks if missing) but feeds TCO, not ECPU — it has no engineSlot by design.
    const computeRequired = required.filter((s) => s.id !== 'data.storageSizeGb');
    expect(computeRequired.every((s) => typeof s.engineSlot === 'string' && s.engineSlot.length > 0)).toBe(true);
    const ids = signals.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('data.storageSizeGb derivableBy includes llm-text (Change 2: prose-stated data size is classifiable)', () => {
    const storage = signals.find((s) => s.id === 'data.storageSizeGb');
    expect(storage).toBeDefined();
    expect(storage!.derivableBy).toContain('llm-text');
  });

  it('has a storage compression-state companion signal (recommended enum, default uncompressed)', () => {
    const s = MONGODB_PROFILE.signalSchema.signals.find((x) => x.id === 'data.storageCompressionState')!;
    expect(s).toBeTruthy();
    expect(s.criticality).toBe('recommended');
    expect(s.valueKind).toBe('enum');
    expect(s.engineSlot).toBeUndefined();
  });

  it('defines a full set of method caps and tier floors', () => {
    const t = MONGODB_PROFILE.thresholds;
    expect(t.methodCap['numeric-series']).toBe(1);
    // A confident vision read IS engineering-grade: its cap meets the floor (not below it).
    expect(t.methodCap['vision']).toBeGreaterThanOrEqual(t.engFloor);
    // Heuristic + assumption-default stay below the floor → they read as needs-confirmation.
    expect(t.methodCap['heuristic']).toBeLessThan(t.engFloor);
    expect(t.methodCap['assumption-default']).toBeLessThan(t.engFloor);
    expect(t.engFloor).toBeGreaterThan(t.missingFloor);
    expect(t.engMean).toBeLessThanOrEqual(t.engFloor); // an all-at-the-floor sizing still reaches engineering-grade
  });
});
