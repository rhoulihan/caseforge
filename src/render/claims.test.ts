import { describe, it, expect } from 'vitest';
import { buildChecklist } from './claims';
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
