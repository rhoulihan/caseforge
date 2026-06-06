import { describe, it, expect } from 'vitest';
import { triage, mergeBindings, toSizingInputs } from './triage';
import { readChartImage, classifyProse } from './llm';
import { MONGODB_PROFILE } from '../profile/mongodb';
import { NORTHWIND_SIZING } from '../engine/fixtures/northwind-sizing';
import { consumedEcpu } from '../engine/sizing';
import type { LLM, CompleteOptions } from '../provider';
import type {
  EvidenceBundle,
  TablePrimitive,
  ImagePrimitive,
  TextPrimitive,
  KeyValuePrimitive,
} from '../ingest/types';
import type { BindingResult } from './types';

const schema = MONGODB_PROFILE.signalSchema;

// Util series engineered so seriesStats gives mean=avg, max=peak (then /100 -> the Northwind fractions):
// primary [4,5,45] -> 18/45; hoSec [0,1,35] -> 12/35; dr [1,3,20] -> 8/20.
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
const topology: KeyValuePrimitive = {
  kind: 'keyvalue',
  source: 'topology.txt',
  pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16' },
};
const northwindBundle: EvidenceBundle = { primitives: [topology, utilTable], files: [] };

describe('triage (heuristics-only, no LLM)', () => {
  it('binds shards/vcpu/util from native tables and key-values', async () => {
    const res = await triage(northwindBundle, MONGODB_PROFILE);
    const v = (id: string) => res.bindings.find((b) => b.signalId === id)?.value;
    expect(v('cluster.shardCount')).toBe(3);
    expect(v('node.hoVcpu')).toBe(32);
    expect(v('node.drVcpu')).toBe(16);
    expect(v('util.primary')).toEqual({ avgPct: 0.18, peakPct: 0.45 });
    expect(v('util.hoSec')).toEqual({ avgPct: 0.12, peakPct: 0.35 });
    expect(v('util.dr')).toEqual({ avgPct: 0.08, peakPct: 0.2 });
  });

  it('toSizingInputs reproduces NORTHWIND_SIZING and the 2.5 workload ratio', async () => {
    const res = await triage(northwindBundle, MONGODB_PROFILE);
    const { inputs } = toSizingInputs(res.bindings, MONGODB_PROFILE);
    expect(inputs).toEqual(NORTHWIND_SIZING);
    expect(consumedEcpu(inputs!, 'workload').ratio).toBe(2.5);
  });

  it('toSizingInputs never invents — a missing required signal yields no inputs', () => {
    const partial: BindingResult[] = [
      { signalId: 'cluster.shardCount', value: 3, confidence: 1, method: 'keyvalue', evidence: [] },
      { signalId: 'node.hoVcpu', value: 32, confidence: 1, method: 'keyvalue', evidence: [] },
      { signalId: 'node.drVcpu', value: 16, confidence: 1, method: 'keyvalue', evidence: [] },
      { signalId: 'util.hoSec', value: { avgPct: 0.12, peakPct: 0.35 }, confidence: 0.9, method: 'numeric-series', evidence: [] },
      { signalId: 'util.dr', value: { avgPct: 0.08, peakPct: 0.2 }, confidence: 0.9, method: 'numeric-series', evidence: [] },
    ];
    const { inputs, missing } = toSizingInputs(partial, MONGODB_PROFILE);
    expect(inputs).toBeUndefined();
    expect(missing).toContain('util.primary');
  });
});

describe('mergeBindings', () => {
  it('prefers a numeric-series candidate over a vision candidate for the same signal', () => {
    const merged = mergeBindings([
      { signalId: 'util.primary', value: { avgPct: 0.2, peakPct: 0.5 }, confidence: 0.99, method: 'vision', evidence: [] },
      { signalId: 'util.primary', value: { avgPct: 0.18, peakPct: 0.45 }, confidence: 0.8, method: 'numeric-series', evidence: [] },
    ]);
    expect(merged.method).toBe('numeric-series');
  });

  it('breaks ties deterministically by evidence source, regardless of input order', () => {
    const a: BindingResult = { signalId: 'util.primary', value: { avgPct: 0.2, peakPct: 0.5 }, confidence: 0.8, method: 'vision', evidence: [{ source: 'a.png', primitiveKind: 'image' }] };
    const b: BindingResult = { signalId: 'util.primary', value: { avgPct: 0.3, peakPct: 0.6 }, confidence: 0.8, method: 'vision', evidence: [{ source: 'b.png', primitiveKind: 'image' }] };
    expect(mergeBindings([a, b]).evidence[0]!.source).toBe(mergeBindings([b, a]).evidence[0]!.source);
  });
});

function recordingMock(): { llm: LLM; calls: CompleteOptions[] } {
  const calls: CompleteOptions[] = [];
  const llm: LLM = {
    async complete(opts) {
      calls.push(opts);
      const hasImage = opts.messages.some((m) => (m.images?.length ?? 0) > 0);
      const text = hasImage
        ? JSON.stringify({ signalId: 'util.dr', avgPct: 0.08, peakPct: 0.2, confidence: 0.85 })
        : JSON.stringify({ bindings: [{ signalId: 'mongo.edition', value: 'Enterprise Advanced', confidence: 0.8 }] });
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
    },
  };
  return { llm, calls };
}

describe('LLM seam (mocked)', () => {
  it('readChartImage sends the base64 image and emits a vision binding with raw confidence', async () => {
    const { llm, calls } = recordingMock();
    const img: ImagePrimitive = { kind: 'image', source: 'cpu.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
    const binds = await readChartImage(llm, img, schema, 'm');
    expect(binds[0]!.signalId).toBe('util.dr');
    expect(binds[0]!.method).toBe('vision');
    expect(binds[0]!.confidence).toBe(0.85);
    expect(binds[0]!.value).toEqual({ avgPct: 0.08, peakPct: 0.2 });
    expect(calls[0]!.messages[0]!.images![0]!.dataBase64).toBe('AQID'); // base64 of bytes 0x01 0x02 0x03
  });

  it('classifyProse extracts enum binds with method llm-text', async () => {
    const llm: LLM = {
      async complete() {
        return {
          text: JSON.stringify({
            bindings: [
              { signalId: 'mongo.edition', value: 'Enterprise Advanced', confidence: 0.8 },
              { signalId: 'workload.readPreference', value: 'secondaryPreferred', confidence: 0.8 },
            ],
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
          raw: {},
        };
      },
    };
    const p: TextPrimitive = { kind: 'text', source: 'lic.txt', text: 'MongoDB Enterprise Advanced, reads to secondaries' };
    const binds = await classifyProse(llm, p, schema, 'm');
    expect(binds.map((b) => b.signalId).sort()).toEqual(['mongo.edition', 'workload.readPreference']);
    expect(binds.every((b) => b.method === 'llm-text')).toBe(true);
  });

  it('triage escalates ONLY images and ambiguous prose to the LLM; numeric tables stay heuristic', async () => {
    const { llm, calls } = recordingMock();
    const img: ImagePrimitive = { kind: 'image', source: 'dr.png', mime: 'image/png', bytes: new Uint8Array([9]) };
    const lic: TextPrimitive = { kind: 'text', source: 'lic.txt', text: 'MongoDB Enterprise Advanced cluster' };
    const cpu: TablePrimitive = {
      kind: 'table',
      source: 'cpu.csv',
      headers: ['timestamp', 'System CPU'],
      rows: [
        ['2026-01-01T00:00Z', '4'],
        ['2026-01-01T01:00Z', '5'],
        ['2026-01-01T02:00Z', '45'],
      ],
    };
    const res = await triage({ primitives: [cpu, img, lic], files: [] }, MONGODB_PROFILE, llm, 'm');
    expect(calls).toHaveLength(2); // image + text only — the table stayed heuristic
    expect(res.bindings.find((b) => b.signalId === 'util.primary')?.method).toBe('numeric-series');
    expect(res.bindings.find((b) => b.signalId === 'util.dr')?.method).toBe('vision');
    expect(res.bindings.find((b) => b.signalId === 'mongo.edition')?.method).toBe('llm-text');
  });

  it('readChartImage rejects NaN / out-of-range fractions and non-avgPeak signals', async () => {
    const bad = (text: string): LLM => ({
      async complete() {
        return { text, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
      },
    });
    const img: ImagePrimitive = { kind: 'image', source: 'x.png', mime: 'image/png', bytes: new Uint8Array([1]) };
    expect(await readChartImage(bad(JSON.stringify({ signalId: 'util.primary', avgPct: 'x', peakPct: 'y', confidence: 0.8 })), img, schema, 'm')).toEqual([]);
    expect(await readChartImage(bad(JSON.stringify({ signalId: 'util.primary', avgPct: -0.5, peakPct: 2, confidence: 0.8 })), img, schema, 'm')).toEqual([]);
    expect(await readChartImage(bad(JSON.stringify({ signalId: 'cluster.shardCount', avgPct: 0.5, peakPct: 0.6, confidence: 0.8 })), img, schema, 'm')).toEqual([]);
  });

  it('classifyProse ignores non-enum signal ids', async () => {
    const llm: LLM = {
      async complete() {
        return {
          text: JSON.stringify({
            bindings: [
              { signalId: 'util.primary', value: 'high', confidence: 0.8 },
              { signalId: 'mongo.edition', value: 'Community', confidence: 0.8 },
            ],
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
          raw: {},
        };
      },
    };
    const p: TextPrimitive = { kind: 'text', source: 'p.txt', text: 'whatever' };
    const binds = await classifyProse(llm, p, schema, 'm');
    expect(binds.map((b) => b.signalId)).toEqual(['mongo.edition']); // util.primary (avgPeak) filtered out
  });
});
