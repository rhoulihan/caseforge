import { describe, it, expect } from 'vitest';
import { triage, mergeBindings, toSizingInputs } from './triage';
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
  pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16', 'storage size': '300' },
};
const northwindBundle: EvidenceBundle = { primitives: [topology, utilTable], files: [] };

describe('triage (heuristics-only, no LLM)', () => {
  it('binds shards/vcpu/util from native tables and key-values', async () => {
    const { result: res } = await triage(northwindBundle, MONGODB_PROFILE);
    const v = (id: string) => res.bindings.find((b) => b.signalId === id)?.value;
    expect(v('cluster.shardCount')).toBe(3);
    expect(v('node.hoVcpu')).toBe(32);
    expect(v('node.drVcpu')).toBe(16);
    expect(v('util.primary')).toEqual({ avgPct: 0.18, peakPct: 0.45 });
    expect(v('util.hoSec')).toEqual({ avgPct: 0.12, peakPct: 0.35 });
    expect(v('util.dr')).toEqual({ avgPct: 0.08, peakPct: 0.2 });
  });

  it('toSizingInputs reproduces NORTHWIND_SIZING and the 2.5 workload ratio', async () => {
    const { result: res } = await triage(northwindBundle, MONGODB_PROFILE);
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

  // Binding helpers for the storage-basis tests below (BindingResult shape).
  const kv = (signalId: string, value: number): BindingResult => ({ signalId, value, confidence: 1, method: 'keyvalue', evidence: [] });
  const avgPeak = (signalId: string, avgPct: number, peakPct: number): BindingResult => ({ signalId, value: { avgPct, peakPct }, confidence: 1, method: 'numeric-series', evidence: [] });
  const enumv = (signalId: string, value: string): BindingResult => ({ signalId, value, confidence: 1, method: 'keyvalue', evidence: [] });

  it('toSizingInputs divides an UNCOMPRESSED storage figure by the 3x factor and returns the basis', () => {
    const bindings = [
      kv('cluster.shardCount', 3), kv('node.hoVcpu', 32), kv('node.drVcpu', 16),
      avgPeak('util.primary', 0.18, 0.45), avgPeak('util.hoSec', 0.12, 0.35), avgPeak('util.dr', 0.08, 0.2),
      kv('data.storageSizeGb', 45_000),
      // no data.storageCompressionState bound -> default UNCOMPRESSED
    ];
    const out = toSizingInputs(bindings, MONGODB_PROFILE);
    expect(out.dataCompressedGb).toBe(15_000); // 45000 / 3
    expect(out.storageBasis).toEqual({ rawGb: 45_000, compressed: false, ratio: 3 });
  });

  it('toSizingInputs leaves a COMPRESSED storage figure unchanged', () => {
    const bindings = [
      kv('cluster.shardCount', 3), kv('node.hoVcpu', 32), kv('node.drVcpu', 16),
      avgPeak('util.primary', 0.18, 0.45), avgPeak('util.hoSec', 0.12, 0.35), avgPeak('util.dr', 0.08, 0.2),
      kv('data.storageSizeGb', 2000), enumv('data.storageCompressionState', 'compressed'),
    ];
    const out = toSizingInputs(bindings, MONGODB_PROFILE);
    expect(out.dataCompressedGb).toBe(2000);
    expect(out.storageBasis).toEqual({ rawGb: 2000, compressed: true, ratio: 3 });
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

// Mock returns the new ARTIFACT_SCHEMA / TEXT_SCHEMA shapes. 'DR CPU' label -> roleTokenOf -> util.dr.
function recordingMock(): { llm: LLM; calls: CompleteOptions[] } {
  const calls: CompleteOptions[] = [];
  const llm: LLM = {
    async complete(opts) {
      calls.push(opts);
      const hasImage = opts.messages.some((m) => (m.images?.length ?? 0) > 0);
      const text = hasImage
        ? JSON.stringify({ panels: [{ kind: 'avgPeak', panelLabel: 'DR CPU', signalId: 'util.dr', avgPct: 0.08, peakPct: 0.2, numericValue: null, strValue: null, confidence: 0.85 }], qualContext: [] })
        : JSON.stringify({ bindings: [{ signalId: 'mongo.edition', valueKind: 'enum', strValue: 'Enterprise Advanced', numericValue: null, avgPct: null, peakPct: null, confidence: 0.8 }], qualContext: [] });
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
    },
  };
  return { llm, calls };
}

const fixedLLM = (text: string): LLM => ({ async complete() { return { text, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} }; } });
const imageP = (source: string): ImagePrimitive => ({ kind: 'image', source, mime: 'image/png', bytes: new Uint8Array([1]) });

describe('triage LLM seam (mocked)', () => {
  it('escalates ONLY images and ambiguous prose to the LLM; numeric tables stay heuristic', async () => {
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
    const { result } = await triage({ primitives: [cpu, img, lic], files: [] }, MONGODB_PROFILE, llm, 'm');
    expect(calls).toHaveLength(2); // image + text only — the table stayed heuristic
    expect(result.bindings.find((b) => b.signalId === 'util.primary')?.method).toBe('numeric-series');
    expect(result.bindings.find((b) => b.signalId === 'util.dr')?.method).toBe('vision');
    expect(result.bindings.find((b) => b.signalId === 'mongo.edition')?.method).toBe('llm-text');
  });

  it('synthesizes hoVcpu/drVcpu from an Atlas tier read off an image (engine table-lookup, not the LLM)', async () => {
    const llm = fixedLLM(JSON.stringify({ panels: [{ kind: 'enum', panelLabel: 'Tier', signalId: 'node.atlasTier', strValue: 'M80', numericValue: null, avgPct: null, peakPct: null, confidence: 0.9 }], qualContext: [] }));
    const { result } = await triage({ primitives: [imageP('form.png')], files: [] }, MONGODB_PROFILE, llm, 'm');
    const ho = result.bindings.find((b) => b.signalId === 'node.hoVcpu');
    expect(ho?.value).toBe(32);
    expect(ho?.method).toBe('table-lookup');
    expect(result.bindings.find((b) => b.signalId === 'node.drVcpu')?.value).toBe(32);
  });

  it('drops a hallucinated vision hoVcpu when the tier provides the authoritative value', async () => {
    const llm = fixedLLM(JSON.stringify({
      panels: [
        { kind: 'enum', panelLabel: 'Tier', signalId: 'node.atlasTier', strValue: 'M80', numericValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
        { kind: 'scalar', panelLabel: 'vCPU', signalId: 'node.hoVcpu', numericValue: 999, strValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
      ],
      qualContext: [],
    }));
    const { result } = await triage({ primitives: [imageP('form.png')], files: [] }, MONGODB_PROFILE, llm, 'm');
    const ho = result.bindings.find((b) => b.signalId === 'node.hoVcpu');
    expect(ho?.value).toBe(32); // table-lookup wins; the hallucinated 999 is gone from the pool
    expect(ho?.method).toBe('table-lookup');
  });

  it('accumulates qual context and re-anonymizes image-derived context via the map (text is already slugged)', async () => {
    const llm: LLM = {
      async complete(opts) {
        const isImage = opts.messages.some((m) => (m.images?.length ?? 0) > 0);
        const text = isImage
          ? JSON.stringify({ panels: [], qualContext: [{ text: 'Acme is cost sensitive', category: 'concern' }] })
          : JSON.stringify({ bindings: [], qualContext: [{ text: 'go-live by Q3', category: 'timeline' }] });
        return { text, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
      },
    };
    const txt: TextPrimitive = { kind: 'text', source: 'body.txt', text: 'CF_ORG_01 plans a Q3 cutover' };
    const map = [{ phrase: 'Acme', slug: 'CF_ORG_01' }];
    const { result } = await triage({ primitives: [imageP('note.png'), txt], files: [] }, MONGODB_PROFILE, llm, 'm', map);
    const items = result.qualContext!.items;
    expect(items.some((i) => i.text === 'CF_ORG_01 is cost sensitive' && i.source === 'note.png')).toBe(true); // image text re-slugged
    expect(items.some((i) => i.text === 'go-live by Q3' && i.source === 'body.txt')).toBe(true);
  });

  it('sets roleWarning when dashboard panels are role-assigned by the load heuristic', async () => {
    const panels = [
      { kind: 'avgPeak', panelLabel: 'node-1', signalId: 'util.primary', avgPct: 0.3, peakPct: 0.6, numericValue: null, strValue: null, confidence: 0.85 },
      { kind: 'avgPeak', panelLabel: 'node-2', signalId: 'util.primary', avgPct: 0.2, peakPct: 0.4, numericValue: null, strValue: null, confidence: 0.85 },
      { kind: 'avgPeak', panelLabel: 'node-3', signalId: 'util.primary', avgPct: 0.1, peakPct: 0.2, numericValue: null, strValue: null, confidence: 0.85 },
    ];
    const { result } = await triage({ primitives: [imageP('dash.png')], files: [] }, MONGODB_PROFILE, fixedLLM(JSON.stringify({ panels, qualContext: [] })), 'm');
    expect(result.roleWarning).toBeTruthy();
    expect(result.bindings.find((b) => b.signalId === 'util.primary')?.value).toEqual({ avgPct: 0.3, peakPct: 0.6 }); // highest peak
    expect(result.bindings.find((b) => b.signalId === 'util.hoSec')).toBeTruthy();
    expect(result.bindings.find((b) => b.signalId === 'util.dr')).toBeTruthy();
  });

  it('returns the accumulated LLM usage', async () => {
    const { llm } = recordingMock();
    const lic: TextPrimitive = { kind: 'text', source: 'lic.txt', text: 'whatever' };
    const { usage } = await triage({ primitives: [imageP('a.png'), lic], files: [] }, MONGODB_PROFILE, llm, 'm');
    expect(usage).toEqual({ inputTokens: 2, outputTokens: 2 }); // one image call + one text call
  });
});
