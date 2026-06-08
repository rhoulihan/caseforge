import { describe, it, expect } from 'vitest';
import { triage, toSizingInputs } from './triage';
import { buildSufficiencyReport } from './sufficiency';
import { MONGODB_PROFILE } from '../profile/mongodb';
import { NORTHWIND_SIZING } from '../engine/fixtures/northwind-sizing';
import { consumedEcpu, baseFor, ceilings } from '../engine/sizing';
import type { LLM } from '../provider';
import type { EvidenceBundle, ImagePrimitive, KeyValuePrimitive, TablePrimitive, TextPrimitive } from '../ingest/types';

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

// A vision LLM that reads each chart (now ARTIFACT_SCHEMA shape) to the matching util signal. The role
// is taken from the panelLabel (primary/secondary/dr), so assignRoles honors it without the heuristic.
function queuedVisionMock(): LLM {
  const responses = [
    JSON.stringify({ panels: [{ kind: 'avgPeak', panelLabel: 'System CPU — primary', signalId: 'util.primary', avgPct: 0.18, peakPct: 0.45, numericValue: null, strValue: null, confidence: 0.85 }], qualContext: [] }),
    JSON.stringify({ panels: [{ kind: 'avgPeak', panelLabel: 'Secondary CPU', signalId: 'util.hoSec', avgPct: 0.12, peakPct: 0.35, numericValue: null, strValue: null, confidence: 0.85 }], qualContext: [] }),
    JSON.stringify({ panels: [{ kind: 'avgPeak', panelLabel: 'DR CPU', signalId: 'util.dr', avgPct: 0.08, peakPct: 0.2, numericValue: null, strValue: null, confidence: 0.85 }], qualContext: [] }),
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
  it('chart screenshots (vision) -> engineering-grade (a confident vision read clears the 0.70 floor)', async () => {
    const bundle: EvidenceBundle = {
      primitives: [topology, img('primary-cpu.png'), img('secondary-cpu.png'), img('dr-cpu.png')],
      files: [
        { name: 'topology.txt', type: 'text', ok: true },
        { name: 'primary-cpu.png', type: 'png', ok: true },
        { name: 'secondary-cpu.png', type: 'png', ok: true },
        { name: 'dr-cpu.png', type: 'png', ok: true },
      ],
    };
    const { result } = await triage(bundle, MONGODB_PROFILE, queuedVisionMock(), 'claude-opus-4-8');
    const report = buildSufficiencyReport(result, bundle.files, MONGODB_PROFILE);

    expect(report.verdict.tier).toBe('engineering-grade'); // vision reads (cap 0.70) clear the engineering floor
    expect(report.whatToCollect.filter((w) => w.severity === 'upgrade')).toHaveLength(0);
    expect(report.whatToCollect.filter((w) => w.severity === 'blocking')).toHaveLength(0);
    // The numbers assemble identically to the native run.
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
    const { result } = await triage(bundle, MONGODB_PROFILE); // no llm — the heuristics-only core path
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

  it('the motivating case: a single .msg whose data is ONLY in embedded images + email text -> engineering-grade, not BLOCKED', async () => {
    // One artifact image carries the intake-form scalars (shards, tier) AND a 3-node CPU dashboard; the
    // email body carries a customer concern. Vision reads the image; classifyText reads the (slugged) body.
    const emailBody: TextPrimitive = { kind: 'text', source: 'thread.msg', text: 'CF_ORG_01 needs payback under two years' };
    const llm: LLM = {
      async complete(opts) {
        const isImage = opts.messages.some((m) => (m.images?.length ?? 0) > 0);
        if (isImage) {
          return {
            text: JSON.stringify({
              panels: [
                { kind: 'scalar', panelLabel: 'Number of shards', signalId: 'cluster.shardCount', numericValue: 3, strValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
                { kind: 'enum', panelLabel: 'Cluster tier', signalId: 'node.atlasTier', strValue: 'M80', numericValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
                { kind: 'avgPeak', panelLabel: 'System CPU node-1', signalId: 'util.primary', avgPct: 0.35, peakPct: 0.9, numericValue: null, strValue: null, confidence: 0.85 },
                { kind: 'avgPeak', panelLabel: 'System CPU node-2', signalId: 'util.primary', avgPct: 0.2, peakPct: 0.5, numericValue: null, strValue: null, confidence: 0.85 },
                { kind: 'avgPeak', panelLabel: 'System CPU node-3', signalId: 'util.primary', avgPct: 0.1, peakPct: 0.3, numericValue: null, strValue: null, confidence: 0.85 },
              ],
              qualContext: [{ text: 'CF_ORG_01 needs payback under two years', category: 'concern' }],
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
            raw: {},
          };
        }
        return { text: JSON.stringify({ bindings: [], qualContext: [{ text: 'CF_ORG_01 needs payback under two years', category: 'concern' }] }), usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
      },
    };
    const bundle: EvidenceBundle = {
      primitives: [img('embedded-0.png'), emailBody],
      files: [
        { name: 'embedded-0.png', type: 'png', ok: true },
        { name: 'thread.msg', type: 'msg', ok: true },
      ],
    };
    const { result } = await triage(bundle, MONGODB_PROFILE, llm, 'claude-opus-4-8');
    const report = buildSufficiencyReport(result, bundle.files, MONGODB_PROFILE);

    expect(report.verdict.tier).toBe('engineering-grade'); // was BLOCKED (5/6 missing); vision reads now clear the 0.70 floor
    const { inputs, missing } = toSizingInputs(result.bindings, MONGODB_PROFILE);
    expect(missing).toEqual([]);
    expect(inputs!.shards).toBe(3);
    expect(inputs!.hoVcpu).toBe(32); // M80 -> 32 via the engine tier table (NOT emitted by the LLM)
    expect(inputs!.drVcpu).toBe(32); // assumed same tier as home
    expect(inputs!.util.primary).toEqual({ avgPct: 0.35, peakPct: 0.9 }); // highest-load node -> primary
    // qualitative context captured (and slugged) for the deliverables
    expect(result.qualContext!.items.some((i) => /payback/.test(i.text))).toBe(true);
    expect(result.roleWarning).toBeTruthy(); // node-labeled panels were role-assigned by load
  });
});
