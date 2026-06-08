import { describe, it, expect } from 'vitest';
import { buildChecklist, buildSizingClaims } from './claims';
import { NORTHWIND_DOCMODEL } from './fixtures/northwind-docmodel';

const cl = buildChecklist(NORTHWIND_DOCMODEL);

describe('buildChecklist', () => {
  it('derives a sizing claim confidence from signal coverage (not a constant)', () => {
    const c1 = cl.rows.find((r) => r.id === 'C1')!; // peak ECPU — backed by util/node/shard signals (eff >= 0.95)
    expect(c1.confidence).toBe('high');
    expect(c1.source).toContain('util.primary');
  });

  it('uses the declared research source for a cost claim', () => {
    const b1 = cl.rows.find((r) => r.id === 'B1')!; // MongoDB EA — dossier, medium
    expect(b1.confidence).toBe('medium');
    expect(b1.source.toLowerCase()).toContain('dossier');
  });

  it('downgrades a derived declared claim one tier', () => {
    const a3 = cl.rows.find((r) => r.id === 'A3')!; // saving % — declared medium + derived -> low
    expect(a3.confidence).toBe('low');
  });

  it('summary counts equal the row tallies and flag the non-high claims', () => {
    const { high, medium, low } = cl.summary.byConfidence;
    expect(high + medium + low).toBe(cl.summary.total);
    expect(cl.summary.total).toBe(NORTHWIND_DOCMODEL.claims.length);
    expect(cl.summary.lowestConfidence).toContain('B1');
    expect(cl.summary.lowestConfidence).not.toContain('C1'); // C1 is high
  });
});

describe('buildSizingClaims', () => {
  const dm = NORTHWIND_DOCMODEL;
  const claims = buildSizingClaims({ basis: dm.sizing.basis, consumed: dm.sizing.consumed, scenarios: dm.sizing.scenarios, tco: dm.tco });

  it('synthesizes the authoritative sizing + TCO claims from the engine numbers', () => {
    const byId = new Map(claims.map((c) => [c.id, c]));
    expect(byId.get('sz-shards')!.value).toBe(dm.sizing.basis.shards); // 3
    expect(byId.get('sz-shards')!.dependsOnSignals).toEqual(['cluster.shardCount']);
    expect(byId.get('sz-hovcpu')!.dependsOnSignals).toEqual(['node.hoVcpu']);
    expect(byId.get('sz-base-conservative')!.value).toBe(dm.sizing.scenarios[0]!.base); // 22
    expect(byId.has('tco-onprem')).toBe(true);
    expect(byId.get('tco-adb-warm')!.declaredSource?.confidence).toBe('high');
  });

  it('the checklist built from synthesized claims is non-empty and derives sizing confidence from coverage', () => {
    // Reproduce the bug fix: a docModel whose ONLY claims are the synthesized ones still yields a full checklist.
    const checklist = buildChecklist({ ...dm, claims });
    expect(checklist.rows.length).toBe(claims.length);
    expect(checklist.rows.length).toBeGreaterThan(0);
    const shard = checklist.rows.find((r) => r.id === 'sz-shards')!;
    expect(shard.confidence).toBe('high'); // cluster.shardCount coverage is high in the fixture
  });
});
