import { describe, it, expect } from 'vitest';
import { runPipeline, type RunConfig } from './index';
import { triage } from '../classify/triage';
import { MONGODB_PROFILE } from '../profile/mongodb';
import { NORTHWIND } from '../engine/fixtures/northwind';
import { NORTHWIND_DOCMODEL } from '../render/fixtures/northwind-docmodel';
import type { EvidenceBundle, TablePrimitive, KeyValuePrimitive, FileReport } from '../ingest/types';
import type { LLM } from '../provider';

const topology: KeyValuePrimitive = {
  kind: 'keyvalue',
  source: 'topology.txt',
  pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16' },
};
// Engineered so seriesStats mean=avg, max=peak (then /100 -> the Northwind fractions).
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
const files: FileReport[] = [
  { name: 'topology.txt', type: 'text', ok: true },
  { name: 'metrics.csv', type: 'csv', ok: true },
];
const fullBundle: EvidenceBundle = { primitives: [topology, utilTable], files };
const topologyOnly: EvidenceBundle = { primitives: [topology], files: [files[0]!] };

function mockLLM(): LLM {
  return {
    async complete() {
      return { text: JSON.stringify(NORTHWIND_DOCMODEL.prose), usage: { inputTokens: 2500, outputTokens: 1200 }, raw: {} };
    },
  };
}

const baseConfig = (): RunConfig => ({
  bundle: fullBundle,
  profile: MONGODB_PROFILE,
  companyName: 'Northwind',
  targetPlatform: 'Oracle Autonomous Database',
  preparedDate: '2026-06-05',
  tcoInputs: NORTHWIND,
  rates: { ecpuPerHr: 0.0807, storagePerGbMo: 0.1156, dataCompressedGb: 45_800 },
  assumptions: ['32 vCPU per home node (to confirm)'],
  claims: NORTHWIND_DOCMODEL.claims,
  llm: mockLLM(),
  model: 'claude-opus-4-8',
});

describe('runPipeline', () => {
  it('runs end-to-end (Northwind) → a complete DocModel + rendered deliverables', async () => {
    const out = await runPipeline(baseConfig());
    expect(out.error).toBeUndefined();
    expect(out.gate.blocked).toBe(false);
    expect(out.docModel).toBeDefined();
    expect(out.docModel!.sizing.scenarios[0]!.base).toBe(22);
    expect(out.docModel!.tco.adbWarmAnnual.central).toBe(213649);
    expect(out.docModel!.prose.businessCase.execSummary.length).toBeGreaterThan(0);
    expect(out.rendered).toHaveLength(4);
    for (const r of out.rendered) {
      expect(r.filename.endsWith('.html')).toBe(true);
      expect(r.html.length).toBeGreaterThan(0);
    }
    expect(out.usage.inputTokens).toBeGreaterThan(0);
    expect(out.budgetLog.length).toBeGreaterThanOrEqual(1);
  });

  it('blocks at the gate when a required signal is missing (no docModel)', async () => {
    const out = await runPipeline({ ...baseConfig(), bundle: topologyOnly, llm: undefined });
    expect(out.gate.blocked).toBe(true);
    expect(out.gate.items.length).toBeGreaterThan(0);
    expect(out.gate.items.some((i) => i.signalId === 'util.primary')).toBe(true);
    expect(out.docModel).toBeUndefined();
  });

  it('errors when prose generation is reached without an LLM', async () => {
    const out = await runPipeline({ ...baseConfig(), llm: undefined });
    expect(out.gate.blocked).toBe(false); // all required satisfied by heuristics
    expect(out.error).toMatch(/no LLM/i);
    expect(out.docModel).toBeUndefined();
  });

  it('enforces the budget limit before the generate call', async () => {
    const out = await runPipeline({ ...baseConfig(), budgetLimit: { tokens: 100 } });
    expect(out.docModel).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.budgetLog.some((c) => c.skipped)).toBe(true);
  });

  it('fires onCheckpoint for each recorded budget checkpoint (live ticker)', async () => {
    const seen: string[] = [];
    const out = await runPipeline({ ...baseConfig(), onCheckpoint: (cp) => seen.push(cp.stage) });
    expect(out.docModel).toBeDefined();
    expect(seen).toContain('classify');
    expect(seen).toContain('generate');
    expect(seen).toEqual(out.budgetLog.map((c) => c.stage)); // one fire per checkpoint, in order
  });

  it('reuses a caller-precomputed triage instead of re-running it', async () => {
    const precomputed = await triage(fullBundle, MONGODB_PROFILE); // heuristics-only, no llm
    const out = await runPipeline({ ...baseConfig(), triage: precomputed });
    expect(out.error).toBeUndefined();
    expect(out.docModel).toBeDefined();
    expect(out.budgetLog.some((c) => c.stage === 'classify' && /reused/.test(c.reason ?? ''))).toBe(true);
  });
});
