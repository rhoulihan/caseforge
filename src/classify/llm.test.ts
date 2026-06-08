import { describe, it, expect } from 'vitest';
import { readArtifactImage, classifyText } from './llm';
import { MONGODB_PROFILE } from '../profile/mongodb';
import type { LLM } from '../provider';
import type { ImagePrimitive, TextPrimitive } from '../ingest/types';

const schema = MONGODB_PROFILE.signalSchema;
const img: ImagePrimitive = { kind: 'image', source: 'dash.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) };

/** An LLM that returns a fixed JSON string and records the request. */
function fixedLLM(text: string): LLM {
  return { async complete() { return { text, usage: { inputTokens: 7, outputTokens: 3 }, raw: {} }; } };
}

describe('readArtifactImage', () => {
  it('emits one binding per panel, assigns dashboard node-panels to util roles by peak, and reads scalars + enums', async () => {
    const llm = fixedLLM(
      JSON.stringify({
        panels: [
          { kind: 'avgPeak', panelLabel: 'System CPU node-1', signalId: 'util.primary', avgPct: 0.5, peakPct: 0.9, numericValue: null, strValue: null, confidence: 0.85 },
          { kind: 'avgPeak', panelLabel: 'System CPU node-2', signalId: 'util.primary', avgPct: 0.2, peakPct: 0.4, numericValue: null, strValue: null, confidence: 0.85 },
          { kind: 'avgPeak', panelLabel: 'System CPU node-3', signalId: 'util.primary', avgPct: 0.1, peakPct: 0.2, numericValue: null, strValue: null, confidence: 0.85 },
          { kind: 'scalar', panelLabel: 'Number of shards', signalId: 'cluster.shardCount', numericValue: 3, strValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
          { kind: 'enum', panelLabel: 'Tier', signalId: 'node.atlasTier', strValue: 'M80', numericValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
        ],
        qualContext: [],
      }),
    );
    const { bindings } = await readArtifactImage(llm, img, schema, 'm');
    const find = (id: string) => bindings.find((b) => b.signalId === id);
    expect(find('util.primary')!.value).toEqual({ avgPct: 0.5, peakPct: 0.9 }); // highest peak -> primary
    expect(find('util.hoSec')!.value).toEqual({ avgPct: 0.2, peakPct: 0.4 });
    expect(find('util.dr')!.value).toEqual({ avgPct: 0.1, peakPct: 0.2 });
    expect(find('cluster.shardCount')!.value).toBe(3);
    expect(find('node.atlasTier')!.value).toBe('M80');
    expect(bindings.every((b) => b.method === 'vision')).toBe(true);
    // node-labeled panels were role-assigned by heuristic -> each util binding carries a verify note
    expect(find('util.primary')!.note).toMatch(/heuristic/i);
  });

  it('drops invalid panels: inverted/out-of-range avgPeak and unknown signalIds', async () => {
    const llm = fixedLLM(
      JSON.stringify({
        panels: [
          { kind: 'avgPeak', panelLabel: 'a', signalId: 'disk.iops', avgPct: 0.9, peakPct: 0.3, numericValue: null, strValue: null, confidence: 0.8 }, // avg > peak
          { kind: 'avgPeak', panelLabel: 'b', signalId: 'disk.iops', avgPct: 2, peakPct: 3, numericValue: null, strValue: null, confidence: 0.8 }, // out of range
          { kind: 'avgPeak', panelLabel: 'c', signalId: 'not.a.signal', avgPct: 0.1, peakPct: 0.2, numericValue: null, strValue: null, confidence: 0.8 }, // unknown id
          { kind: 'avgPeak', panelLabel: 'd', signalId: 'disk.iops', avgPct: 0.1, peakPct: 0.2, numericValue: null, strValue: null, confidence: 0.8 }, // valid
        ],
        qualContext: [],
      }),
    );
    const { bindings } = await readArtifactImage(llm, img, schema, 'm');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.signalId).toBe('disk.iops');
    expect(bindings[0]!.value).toEqual({ avgPct: 0.1, peakPct: 0.2 });
  });

  it('re-anonymizes image-derived qualitative context through the injected slugger (F1 leak fix)', async () => {
    const llm = fixedLLM(
      JSON.stringify({
        panels: [],
        qualContext: [
          { text: 'Acme is worried about migration cost', category: 'concern' },
          { text: '', category: 'concern' }, // empty -> dropped
          { text: 'bad', category: 'not-a-category' }, // bad category -> dropped
        ],
      }),
    );
    const slugger = (s: string) => s.replace(/Acme/g, 'CF_ORG_01');
    const { qualContext } = await readArtifactImage(llm, img, schema, 'm', slugger);
    expect(qualContext.items).toHaveLength(1);
    expect(qualContext.items[0]).toEqual({ text: 'CF_ORG_01 is worried about migration cost', source: 'dash.png', category: 'concern' });
  });

  it('drops panels whose value field is null (Number(null) must not bind a {0,0} avgPeak or a 0 scalar)', async () => {
    const llm = fixedLLM(
      JSON.stringify({
        panels: [
          { kind: 'avgPeak', panelLabel: 'iops', signalId: 'disk.iops', avgPct: null, peakPct: null, numericValue: null, strValue: null, confidence: 0.8 },
          { kind: 'scalar', panelLabel: 'shards', signalId: 'cluster.shardCount', numericValue: null, strValue: null, avgPct: null, peakPct: null, confidence: 0.8 },
          { kind: 'scalar', panelLabel: 'CPU', signalId: 'util.primary', numericValue: 5, strValue: null, avgPct: null, peakPct: null, confidence: 0.8 }, // util panel with null avg/peak
        ],
        qualContext: [],
      }),
    );
    const { bindings } = await readArtifactImage(llm, img, schema, 'm');
    expect(bindings).toHaveLength(0); // all three dropped — no bogus zero-valued bindings
  });

  it('returns usage and survives a non-JSON response', async () => {
    const ok = await readArtifactImage(fixedLLM('{"panels":[],"qualContext":[]}'), img, schema, 'm');
    expect(ok.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    const bad = await readArtifactImage(fixedLLM('not json'), img, schema, 'm');
    expect(bad.bindings).toEqual([]);
    expect(bad.qualContext.items).toEqual([]);
    expect(bad.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('sends the base64 image to the model', async () => {
    let sent = '';
    const llm: LLM = {
      async complete(opts) {
        sent = opts.messages[0]!.images![0]!.dataBase64;
        return { text: '{"panels":[],"qualContext":[]}', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
      },
    };
    await readArtifactImage(llm, img, schema, 'm');
    expect(sent).toBe('AQID'); // base64 of 0x01 0x02 0x03
  });
});

describe('classifyText', () => {
  const p: TextPrimitive = { kind: 'text', source: 'email.txt', text: 'slugged body' };

  it('extracts scalars, enums, and avgPeak from text (method llm-text); drops unknown signalIds', async () => {
    const llm = fixedLLM(
      JSON.stringify({
        bindings: [
          { signalId: 'cluster.shardCount', valueKind: 'scalar', numericValue: 3, strValue: null, avgPct: null, peakPct: null, confidence: 0.7 },
          { signalId: 'mongo.edition', valueKind: 'enum', strValue: 'Enterprise Advanced', numericValue: null, avgPct: null, peakPct: null, confidence: 0.8 },
          { signalId: 'util.primary', valueKind: 'avgPeak', avgPct: 0.35, peakPct: 0.9, numericValue: null, strValue: null, confidence: 0.6 },
          { signalId: 'not.a.signal', valueKind: 'scalar', numericValue: 5, strValue: null, avgPct: null, peakPct: null, confidence: 0.9 },
        ],
        qualContext: [],
      }),
    );
    const { bindings } = await classifyText(llm, p, schema, 'm');
    const find = (id: string) => bindings.find((b) => b.signalId === id);
    expect(find('cluster.shardCount')!.value).toBe(3);
    expect(find('mongo.edition')!.value).toBe('Enterprise Advanced');
    expect(find('util.primary')!.value).toEqual({ avgPct: 0.35, peakPct: 0.9 });
    expect(find('not.a.signal')).toBeUndefined();
    expect(bindings.every((b) => b.method === 'llm-text')).toBe(true);
  });

  it('binds data.storageSizeGb from prose when LLM returns a numeric value (Change 3: llm-text-derivable storage)', async () => {
    // This test verifies that the parse/bind path accepts a prose storage binding now that
    // data.storageSizeGb has llm-text in its derivableBy (Change 2) and the LLM is instructed
    // to GB-normalize (Change 3). The mock simulates the LLM returning 45800 (45.8 TB * 1000).
    const llm = fixedLLM(
      JSON.stringify({
        bindings: [
          { signalId: 'data.storageSizeGb', valueKind: 'scalar', numericValue: 45800, strValue: null, avgPct: null, peakPct: null, confidence: 0.8 },
        ],
        qualContext: [],
      }),
    );
    const prose: TextPrimitive = { kind: 'text', source: 'email.txt', text: 'Data size 45.8 TB' };
    const { bindings } = await classifyText(llm, prose, schema, 'm');
    const storage = bindings.find((b) => b.signalId === 'data.storageSizeGb');
    expect(storage).toBeDefined();
    expect(storage!.value).toBe(45800);
    expect(storage!.method).toBe('llm-text');
  });

  it('captures qualitative context with the primitive source injected (not from the LLM)', async () => {
    const llm = fixedLLM(
      JSON.stringify({
        bindings: [],
        qualContext: [{ text: 'CFO needs payback under 2 years', category: 'concern', source: 'attacker-supplied' }],
      }),
    );
    const { qualContext } = await classifyText(llm, p, schema, 'm');
    expect(qualContext.items).toEqual([{ text: 'CFO needs payback under 2 years', source: 'email.txt', category: 'concern' }]);
  });
});
