import { describe, it, expect } from 'vitest';
import { triage, toSizingInputs } from './triage';
import { buildSufficiencyReport } from './sufficiency';
import { MONGODB_PROFILE } from '../profile/mongodb';
import { NORTHWIND_SIZING } from '../engine/fixtures/northwind-sizing';
import { consumedEcpu, baseFor, ceilings } from '../engine/sizing';
import type { LLM } from '../provider';
import type { EvidenceBundle, ImagePrimitive, KeyValuePrimitive, TablePrimitive } from '../ingest/types';

// The rep supplied topology + storage as text, but only Ops-Manager chart SCREENSHOTS for CPU.
const topology: KeyValuePrimitive = {
  kind: 'keyvalue',
  source: 'topology.txt',
  pairs: {
    shards: '3',
    'cores per node': '32',
    'dr cores': '16',
    'logical data size': '1000',
    'storage size': '300',
  },
};
const img = (source: string): ImagePrimitive => ({ kind: 'image', source, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });

// A vision LLM that reads each chart in order to the matching util signal (mocked, deterministic).
function queuedVisionMock(): LLM {
  const responses = [
    JSON.stringify({ signalId: 'util.primary', avgPct: 0.18, peakPct: 0.45, confidence: 0.85 }),
    JSON.stringify({ signalId: 'util.hoSec', avgPct: 0.12, peakPct: 0.35, confidence: 0.85 }),
    JSON.stringify({ signalId: 'util.dr', avgPct: 0.08, peakPct: 0.2, confidence: 0.85 }),
  ];
  let i = 0;
  return {
    async complete() {
      return { text: responses[Math.min(i++, responses.length - 1)]!, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
    },
  };
}

// The SAME workload as native CPU series (mean=avg, max=peak -> the Northwind fractions after /100).
const utilTable: TablePrimitive = {
  kind: 'table',
  source: 'metrics.csv',
  headers: ['timestamp', 'System CPU', 'Secondary CPU', 'DR CPU'],
  rows: [
    ['2026-01-01T00:00Z', '4', '0', '1'],
    ['2026-01-01T01:00Z', '5', '1', '3'],
    ['2026-01-01T02:00Z', '45', '35', '20'],
  ],
};

describe('Northwind golden: classify -> size, determinism seam', () => {
  it('chart screenshots (vision) -> directional-estimate with the 3 util signals as upgrade asks', async () => {
    const bundle: EvidenceBundle = {
      primitives: [topology, img('primary-cpu.png'), img('secondary-cpu.png'), img('dr-cpu.png')],
      files: [
        { name: 'topology.txt', type: 'text', ok: true },
        { name: 'primary-cpu.png', type: 'png', ok: true },
        { name: 'secondary-cpu.png', type: 'png', ok: true },
        { name: 'dr-cpu.png', type: 'png', ok: true },
      ],
    };
    const result = await triage(bundle, MONGODB_PROFILE, queuedVisionMock(), 'claude-opus-4-8');
    const report = buildSufficiencyReport(result, bundle.files, MONGODB_PROFILE);

    expect(report.verdict.tier).toBe('directional-estimate');
    expect(report.whatToCollect.filter((w) => w.severity === 'upgrade').map((w) => w.signalId).sort()).toEqual([
      'util.dr',
      'util.hoSec',
      'util.primary',
    ]);
    expect(report.whatToCollect.filter((w) => w.severity === 'blocking')).toHaveLength(0);
    // The numbers still assemble — only the confidence/tier differ from the native run.
    expect(toSizingInputs(result.bindings, MONGODB_PROFILE).inputs).toEqual(NORTHWIND_SIZING);
  });

  it('native CPU series (no LLM) -> engineering-grade, and the numbers match the engine golden', async () => {
    const bundle: EvidenceBundle = {
      primitives: [topology, utilTable],
      files: [
        { name: 'topology.txt', type: 'text', ok: true },
        { name: 'metrics.csv', type: 'csv', ok: true },
      ],
    };
    const result = await triage(bundle, MONGODB_PROFILE); // no llm — the heuristics-only core path
    const report = buildSufficiencyReport(result, bundle.files, MONGODB_PROFILE);

    expect(report.verdict.tier).toBe('engineering-grade');
    expect(report.whatToCollect).toHaveLength(0);

    const { inputs } = toSizingInputs(result.bindings, MONGODB_PROFILE);
    expect(inputs).toEqual(NORTHWIND_SIZING);

    // feeds the existing engine golden (n=2 -> base 22, ceilings 44/66; n=3 -> base 18, 36/54)
    const { avg, peak, ratio } = consumedEcpu(inputs!, 'workload');
    expect(avg).toBeCloseTo(17.28, 10);
    expect(peak).toBeCloseTo(43.2, 10);
    expect(ratio).toBe(2.5);
    expect(baseFor(peak, avg, 2)).toBe(22);
    expect(ceilings(22)).toEqual({ x2: 44, x3: 66 });
    expect(baseFor(peak, avg, 3)).toBe(18);
    expect(ceilings(18)).toEqual({ x2: 36, x3: 54 });
  });
});
