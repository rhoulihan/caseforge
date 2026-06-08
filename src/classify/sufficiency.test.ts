import { describe, it, expect } from 'vitest';
import { buildSufficiencyReport } from './sufficiency';
import { MONGODB_PROFILE } from '../profile/mongodb';
import type { BindingResult, TriageResult, SignalValue } from './types';
import type { DerivationMethod } from '../profile/types';
import type { FileReport } from '../ingest/types';

const T = MONGODB_PROFILE.thresholds;

function mk(signalId: string, value: SignalValue, confidence: number, method: DerivationMethod, source = 'src'): BindingResult {
  return { signalId, value, confidence, method, evidence: [{ source, primitiveKind: 'table' }] };
}
function triageOf(bindings: BindingResult[]): TriageResult {
  return { profileId: 'mongodb', inventory: [], bindings };
}
const REQUIRED = ['cluster.shardCount', 'node.hoVcpu', 'node.drVcpu', 'util.primary', 'util.hoSec', 'util.dr'];
const scalarsSatisfied = (): BindingResult[] => [
  mk('cluster.shardCount', 3, 1, 'keyvalue'),
  mk('node.hoVcpu', 32, 1, 'keyvalue'),
  mk('node.drVcpu', 16, 1, 'keyvalue'),
];
const utilNative = (): BindingResult[] => [
  mk('util.primary', { avgPct: 0.18, peakPct: 0.45 }, 0.95, 'numeric-series'),
  mk('util.hoSec', { avgPct: 0.12, peakPct: 0.35 }, 0.95, 'numeric-series'),
  mk('util.dr', { avgPct: 0.08, peakPct: 0.2 }, 0.95, 'numeric-series'),
];
const allRequiredSatisfied = (): BindingResult[] => [...scalarsSatisfied(), ...utilNative()];
const storageSatisfied = (): BindingResult[] => [
  mk('data.logicalSizeGb', 1000, 0.95, 'keyvalue'),
  mk('data.storageSizeGb', 300, 0.95, 'keyvalue'),
];

describe('buildSufficiencyReport — verdict tiers', () => {
  it('(1) empty evidence -> blocked, every required becomes a blocking ask', () => {
    const r = buildSufficiencyReport(triageOf([]), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('blocked');
    const blocking = r.whatToCollect.filter((w) => w.severity === 'blocking');
    expect(blocking.map((w) => w.signalId).sort()).toEqual([...REQUIRED].sort());
  });

  it('(2) all required + storage native high-confidence -> engineering-grade, nothing to collect', () => {
    const r = buildSufficiencyReport(triageOf([...allRequiredSatisfied(), ...storageSatisfied()]), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('engineering-grade');
    expect(r.verdict.requiredPartial).toBe(0);
    expect(r.whatToCollect).toHaveLength(0);
  });

  it('(3) Northwind vision util (capped 0.70) -> engineering-grade (a confident vision read clears the 0.70 floor), nothing to collect', () => {
    const utilVision = utilNative().map((b) => ({ ...b, confidence: 0.85, method: 'vision' as const }));
    const r = buildSufficiencyReport(triageOf([...scalarsSatisfied(), ...utilVision, ...storageSatisfied()]), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('engineering-grade'); // vision cap 0.70 == engFloor → satisfied, not a perpetual directional
    expect(r.whatToCollect.filter((w) => w.severity === 'blocking')).toHaveLength(0);
    expect(r.whatToCollect.filter((w) => w.severity === 'upgrade')).toHaveLength(0);
    expect(r.verdict.limitingSignals).toEqual([]);
  });

  it('(3b) all-vision required signals -> engineering-grade (an entirely image-sourced sizing still qualifies)', () => {
    const visionAll = allRequiredSatisfied().map((b) => ({ ...b, confidence: 0.85, method: 'vision' as const }));
    const r = buildSufficiencyReport(triageOf([...visionAll, ...storageSatisfied()]), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('engineering-grade'); // mean of six 0.70s must clear engMean (guards the float cliff)
    expect(r.verdict.requiredPartial).toBe(0);
  });

  it('(4) one required missing among satisfied -> blocked with that lone limiting signal', () => {
    const b = allRequiredSatisfied().filter((x) => x.signalId !== 'util.primary');
    const r = buildSufficiencyReport(triageOf([...b, ...storageSatisfied()]), [], MONGODB_PROFILE);
    expect(r.verdict.tier).toBe('blocked');
    expect(r.verdict.limitingSignals).toEqual(['util.primary']);
  });

  it('(5) an assumption-default required signal is capped to partial and can never reach engineering-grade; a manual rep-confirmed one can', () => {
    const base = allRequiredSatisfied().filter((x) => x.signalId !== 'util.hoSec');
    const assumed = buildSufficiencyReport(
      triageOf([...base, mk('util.hoSec', { avgPct: 0.12, peakPct: 0.35 }, 1, 'assumption-default'), ...storageSatisfied()]),
      [],
      MONGODB_PROFILE,
    );
    expect(assumed.verdict.tier).toBe('directional-estimate');
    const manual = buildSufficiencyReport(
      triageOf([...base, mk('util.hoSec', { avgPct: 0.12, peakPct: 0.35 }, 1, 'manual'), ...storageSatisfied()]),
      [],
      MONGODB_PROFILE,
    );
    expect(manual.verdict.tier).toBe('engineering-grade');
  });

  it('(6) an exact key-value scalar reaches satisfied (cap 1.0, not the heuristic 0.6)', () => {
    const r = buildSufficiencyReport(triageOf([mk('cluster.shardCount', 3, 1, 'keyvalue')]), [], MONGODB_PROFILE);
    const cov = r.coverage.find((c) => c.signalId === 'cluster.shardCount')!;
    expect(cov.status).toBe('satisfied');
    expect(cov.effectiveConfidence).toBeGreaterThanOrEqual(T.engFloor);
  });

  it('(6b) a single required signal just below the engineering floor caps the tier at directional', () => {
    const base = allRequiredSatisfied().filter((x) => x.signalId !== 'util.primary');
    const r = buildSufficiencyReport(
      triageOf([...base, mk('util.primary', { avgPct: 0.18, peakPct: 0.45 }, 0.6, 'numeric-series'), ...storageSatisfied()]),
      [],
      MONGODB_PROFILE,
    );
    expect(r.verdict.tier).toBe('directional-estimate'); // eff 0.60 < engFloor 0.70 -> partial
    expect(r.verdict.limitingSignals).toEqual(['util.primary']);
  });
});

describe('buildSufficiencyReport — inventory & coverage left-joins', () => {
  it('(7) classifies files as evidence / noise / unrecognized', () => {
    const files: FileReport[] = [
      { name: 'cpu.csv', type: 'csv', ok: true },
      { name: 'notes.txt', type: 'text', ok: true },
      { name: 'mystery.bin', type: 'unknown', ok: false },
    ];
    const bindings = [mk('util.primary', { avgPct: 0.18, peakPct: 0.45 }, 0.95, 'numeric-series', 'cpu.csv')];
    const r = buildSufficiencyReport(triageOf(bindings), files, MONGODB_PROFILE);
    const role = (n: string) => r.inventory.find((i) => i.name === n)!.role;
    expect(role('cpu.csv')).toBe('evidence');
    expect(role('notes.txt')).toBe('noise');
    expect(role('mystery.bin')).toBe('unrecognized');
  });

  it('(8) coverage left-joins the schema so a never-bound required signal shows as missing', () => {
    const r = buildSufficiencyReport(triageOf([]), [], MONGODB_PROFILE);
    expect(r.coverage.find((c) => c.signalId === 'util.primary')?.status).toBe('missing');
  });

  it('(9) a missing dominant cost driver (tcoCritical) produces an upgrade ask and a cost flag in the rationale', () => {
    const r = buildSufficiencyReport(triageOf(allRequiredSatisfied()), [], MONGODB_PROFILE);
    const ask = r.whatToCollect.find((w) => w.signalId === 'data.logicalSizeGb');
    expect(ask?.severity).toBe('upgrade');
    expect(r.verdict.rationale.toLowerCase()).toContain('cost');
  });
});

describe('buildSufficiencyReport — whatToCollect ordering', () => {
  it('(10) lists blocking before upgrade, then ascending effective confidence', () => {
    const r = buildSufficiencyReport(triageOf([]), [], MONGODB_PROFILE);
    const sev = r.whatToCollect.map((w) => w.severity);
    expect(sev.lastIndexOf('blocking')).toBeLessThan(sev.indexOf('upgrade'));

    // two partials with different effective confidence -> the lower one is asked first
    const base = scalarsSatisfied();
    const r2 = buildSufficiencyReport(
      triageOf([
        ...base,
        mk('util.primary', { avgPct: 0.18, peakPct: 0.45 }, 0.85, 'vision'), // cap 0.70
        mk('util.hoSec', { avgPct: 0.12, peakPct: 0.35 }, 0.65, 'heuristic'), // cap 0.60
        mk('util.dr', { avgPct: 0.08, peakPct: 0.2 }, 0.85, 'vision'),
        ...storageSatisfied(),
      ]),
      [],
      MONGODB_PROFILE,
    );
    const upgrades = r2.whatToCollect.filter((w) => w.severity === 'upgrade');
    expect(upgrades[0]!.signalId).toBe('util.hoSec'); // eff 0.60 < the 0.70 visions
  });
});
