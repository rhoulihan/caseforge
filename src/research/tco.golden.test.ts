import { describe, it, expect } from 'vitest';
import type { LLM, CompleteResult } from '../provider';
import { researchTcoCosts, type TcoProfile } from './tco';
import { NORTHWIND } from '../engine/fixtures/northwind';
import { onpremTotal, adbTotal, net5 } from '../engine/tco';

const NOW = Date.UTC(2026, 5, 5); // 2026-06-05
const PROFILE: TcoProfile = { dbType: 'mongodb', shards: 3, hoVcpu: 16, drVcpu: 8, dataCompressedGb: 500, drPosture: 'warm' };

class OneShot implements LLM {
  constructor(private readonly res: CompleteResult) {}
  async complete(): Promise<CompleteResult> {
    return this.res;
  }
}

const PAYLOAD = {
  onpremComponents: NORTHWIND.onpremComponents,
  adbPrimary: NORTHWIND.adbPrimary,
  coldDrAdd: NORTHWIND.coldDrAdd,
  warmDrAdd: NORTHWIND.warmDrAdd,
  migrationPs: NORTHWIND.migrationPs,
  sources: [
    { component: 'license', source: 'Vendor list', url: 'https://v.com', asOfDate: '2026-05-01', sourceQuality: 'published' },
    { component: 'adbPrimary', source: 'Oracle pricing', url: 'https://oracle.com', asOfDate: '2026-05-01', sourceQuality: 'published' },
  ],
};
const RES: CompleteResult = { text: JSON.stringify(PAYLOAD), usage: { inputTokens: 2000, outputTokens: 1000 }, raw: {} };

describe('cost research golden (Northwind)', () => {
  it('reproduces the NORTHWIND inputs at 0.75 confidence', async () => {
    const r = await researchTcoCosts(new OneShot(RES), 'm', PROFILE, { now: NOW });
    expect(r.inputs).toEqual(NORTHWIND);
    expect(r.confidence).toBe(0.75);
  });

  it('researched inputs flow through the deterministic engine to the known goldens', async () => {
    const r = await researchTcoCosts(new OneShot(RES), 'm', PROFILE, { now: NOW });
    expect(onpremTotal(r.inputs, 'central')).toBe(449500); // headline on-prem golden
    expect(adbTotal(r.inputs, 'warm', 'central')).toBe(adbTotal(NORTHWIND, 'warm', 'central'));
    expect(net5(r.inputs, 'warm')).toBe(net5(NORTHWIND, 'warm'));
  });
});
