import { describe, it, expect } from 'vitest';
import { ENGINE_CONFIG } from './config';
import { ceilings, consumedEcpu } from './sizing';
import { coldRtoHours } from './dr';
import type { SizingInputs } from './types';

describe('ENGINE_CONFIG — documented defaults (drift guard)', () => {
  it('holds the known-good Oracle list rates + sizing/DR constants', () => {
    expect(ENGINE_CONFIG.adb).toEqual({ ecpuPerHr: 0.0807, storagePerGbMo: 0.1156, hoursPerMonth: 730 });
    expect(ENGINE_CONFIG.sizing).toEqual({ conservativeDivisor: 2, aggressiveDivisor: 3, autoscaleMultipliers: [2, 3], ecpuPerVcpu: 1 });
    expect(ENGINE_CONFIG.dr).toEqual({ coldRtoBaseHours: 1, coldRtoHoursPerTb: 0.2 });
  });
});

describe('engine functions read config defaults and honor overrides', () => {
  it('ceilings: default 2×/3×, overridable via multipliers', () => {
    expect(ceilings(10)).toEqual({ x2: 20, x3: 30 });
    expect(ceilings(10, [4, 5])).toEqual({ x2: 40, x3: 50 });
  });

  it('coldRtoHours: default 1 h + 1 h/5 TB, overridable via cfg', () => {
    expect(coldRtoHours(10)).toBe(3); // ceil(1 + 10/5)
    expect(coldRtoHours(10, { coldRtoBaseHours: 2, coldRtoHoursPerTb: 1 })).toBe(12); // ceil(2 + 10×1)
  });

  it('consumedEcpu: ecpuPerVcpu scales consumed ECPU (default 1:1)', () => {
    const i: SizingInputs = {
      shards: 1,
      hoVcpu: 10,
      drVcpu: 10,
      util: { primary: { avgPct: 0.5, peakPct: 1.0 }, hoSec: { avgPct: 0, peakPct: 0 }, dr: { avgPct: 0, peakPct: 0 } },
    };
    expect(consumedEcpu(i, 'workload').peak).toBe(10); // 1 × 10 × 1.0 × 1
    expect(consumedEcpu(i, 'workload', 2).peak).toBe(20); // ecpuPerVcpu = 2 doubles it
  });
});
