import { describe, it, expect } from 'vitest';
import { deriveOracleCost } from './adbCost';
import { ENGINE_CONFIG } from './config';
import { NORTHWIND_SIZING } from './fixtures/northwind-sizing';
import type { SizingInputs } from './types';

const RATES = { ecpuPerHr: ENGINE_CONFIG.adb.ecpuPerHr, storagePerGbMo: ENGINE_CONFIG.adb.storagePerGbMo, hoursPerMonth: ENGINE_CONFIG.adb.hoursPerMonth };

describe('deriveOracleCost', () => {
  it('derives adbPrimary = base compute + db storage at each posture (central = Peak÷2)', () => {
    const r = deriveOracleCost(NORTHWIND_SIZING, 45_800, RATES);
    // base@2 = ceil(max(43.2/2, 17.28)) = 22; compute = 22*0.0807*730*12; storage = 45800*0.1156*12
    const compute2 = 22 * RATES.ecpuPerHr * RATES.hoursPerMonth * 12;
    const dbStore = 45_800 * RATES.storagePerGbMo * 12;
    expect(r.adbPrimary.central).toBe(Math.round(compute2 + dbStore));
    expect(r.adbPrimary.low).toBeLessThan(r.adbPrimary.central);   // aggressive (Peak÷3) cheaper
    expect(r.adbPrimary.high).toBeGreaterThan(r.adbPrimary.central); // peak-provisioned dearer
  });

  it('warm add = base compute + 2× db storage; cold add = 2× object-storage backup, posture-invariant', () => {
    const r = deriveOracleCost(NORTHWIND_SIZING, 45_800, RATES);
    const compute2 = 22 * RATES.ecpuPerHr * RATES.hoursPerMonth * 12;
    const dbStore = 45_800 * RATES.storagePerGbMo * 12;
    const backup = 45_800 * ENGINE_CONFIG.adb.backupStoragePerGbMo * 12;
    expect(r.warmDrAdd.central).toBe(Math.round(compute2 + 2 * dbStore));
    expect(r.coldDrAdd.central).toBe(Math.round(2 * backup));
    expect(r.coldDrAdd.low).toBe(r.coldDrAdd.central); // storage-only → posture-invariant
    expect(r.coldDrAdd.high).toBe(r.coldDrAdd.central);
    expect(r.coldDrAdd.central).toBeLessThan(r.warmDrAdd.central); // cold cheaper than warm
  });

  it('responds to sizing: more storage raises every line; more vCPU raises compute-bearing lines', () => {
    const base = deriveOracleCost(NORTHWIND_SIZING, 45_800, RATES);
    const moreStorage = deriveOracleCost(NORTHWIND_SIZING, 91_600, RATES);
    expect(moreStorage.adbPrimary.central).toBeGreaterThan(base.adbPrimary.central);
    expect(moreStorage.coldDrAdd.central).toBeGreaterThan(base.coldDrAdd.central);
    const biggerNodes: SizingInputs = { ...NORTHWIND_SIZING, hoVcpu: 64 };
    const moreCpu = deriveOracleCost(biggerNodes, 45_800, RATES);
    expect(moreCpu.adbPrimary.central).toBeGreaterThan(base.adbPrimary.central);
    expect(moreCpu.coldDrAdd.central).toBe(base.coldDrAdd.central); // cold has no compute term
  });

  it('throws on non-positive storage (mirrors effectiveCompressedGb)', () => {
    expect(() => deriveOracleCost(NORTHWIND_SIZING, 0, RATES)).toThrow(RangeError);
    expect(() => deriveOracleCost(NORTHWIND_SIZING, -5, RATES)).toThrow(RangeError);
  });
});
