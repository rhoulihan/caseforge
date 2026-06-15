import { describe, it, expect } from 'vitest';
import type { LLM, CompleteResult } from '../provider';
import { researchTcoCosts, type TcoProfile } from './tco';
import { NORTHWIND } from '../engine/fixtures/northwind';
import { onpremTotal } from '../engine/tco';

const NOW = Date.UTC(2026, 5, 5); // 2026-06-05
const PROFILE: TcoProfile = { dbType: 'mongodb', shards: 3, hoVcpu: 16, drVcpu: 8, dataCompressedGb: 500, drPosture: 'warm' };

class OneShot implements LLM {
  constructor(private readonly res: CompleteResult) {}
  async complete(): Promise<CompleteResult> {
    return this.res;
  }
}

// Research now covers only the on-prem build-up + one-time migration; the Oracle cost is engine-derived
// in assembleDocModel (not researched), so the payload carries no adbPrimary/coldDrAdd/warmDrAdd ranges.
const PAYLOAD = {
  onpremComponents: NORTHWIND.onpremComponents,
  migrationPs: NORTHWIND.migrationPs,
  sources: [
    { component: 'license', source: 'Vendor list', url: 'https://v.com', asOfDate: '2026-05-01', sourceQuality: 'published' },
    { component: 'migrationPs', source: 'SI rate card', url: 'https://si.com', asOfDate: '2026-05-01', sourceQuality: 'published' },
  ],
};
const RES: CompleteResult = { text: JSON.stringify(PAYLOAD), usage: { inputTokens: 2000, outputTokens: 1000 }, raw: {} };

describe('cost research golden (Northwind)', () => {
  it('reproduces the researched NORTHWIND on-prem + migration at 0.75 confidence', async () => {
    const r = await researchTcoCosts(new OneShot(RES), 'm', PROFILE, { now: NOW });
    expect(r.inputs.onpremComponents).toEqual(NORTHWIND.onpremComponents);
    expect(r.inputs.migrationPs).toEqual(NORTHWIND.migrationPs);
    // Oracle ranges are zero placeholders (engine-derived in assembleDocModel; not researched).
    expect(r.inputs.adbPrimary).toEqual({ low: 0, central: 0, high: 0 });
    expect(r.inputs.warmDrAdd).toEqual({ low: 0, central: 0, high: 0 });
    expect(r.inputs.coldDrAdd).toEqual({ low: 0, central: 0, high: 0 });
    expect(r.confidence).toBe(0.75);
  });

  it('researched on-prem inputs flow through the deterministic engine to the known golden', async () => {
    const r = await researchTcoCosts(new OneShot(RES), 'm', PROFILE, { now: NOW });
    expect(onpremTotal(r.inputs, 'central')).toBe(449500); // headline on-prem golden
  });
});
