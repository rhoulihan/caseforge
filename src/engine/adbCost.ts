// Derive the Oracle (proposed) side of the TCO from the engine sizing x Oracle list rates -- the
// single place the ADB primary + warm/cold DR costs are computed. Keeps the determinism boundary: the
// engine computes the quantity (provisioned ECPU + storage GB); the rates are Oracle list pricing.
// Replaces the former researched/DEFAULT lump sums so adjusting the sizing moves the business case.

import type { SizingInputs, Range } from './types';
import type { EngineConfig } from './config';
import { ENGINE_CONFIG } from './config';
import { consumedEcpu, baseFor } from './sizing';

export interface OracleRates {
  ecpuPerHr: number;
  storagePerGbMo: number;
  hoursPerMonth?: number;
}

export interface OracleCost {
  adbPrimary: Range;
  coldDrAdd: Range;
  warmDrAdd: Range;
}

/** Provisioned ADB primary + DR add-on annual costs (USD/yr) derived from the workload sizing.
 *  low/central/high = aggressive (Peak÷3) / conservative (Peak÷2) / peak-provisioned (Peak÷1). */
export function deriveOracleCost(
  inputs: SizingInputs,
  dataCompressedGb: number,
  rates: OracleRates,
  cfg: EngineConfig = ENGINE_CONFIG,
): OracleCost {
  if (!Number.isFinite(dataCompressedGb) || dataCompressedGb <= 0) {
    throw new RangeError(`dataCompressedGb must be a positive number (got ${dataCompressedGb})`);
  }
  const hrs = rates.hoursPerMonth ?? cfg.adb.hoursPerMonth;
  const { peak, avg } = consumedEcpu(inputs, 'workload');
  const computeAnnual = (n: number): number => baseFor(peak, avg, n) * rates.ecpuPerHr * hrs * 12;
  const dbStorageAnnual = dataCompressedGb * rates.storagePerGbMo * 12;
  const backupStoreAnnual = dataCompressedGb * cfg.adb.backupStoragePerGbMo * 12;
  // Postures: aggressive (÷3) cheaper, conservative (÷2) recommended/central, peak (÷1) dearest.
  const { aggressiveDivisor: lo, conservativeDivisor: mid } = cfg.sizing;
  const primary = (n: number): number => Math.round(computeAnnual(n) + dbStorageAnnual);
  const warm = (n: number): number => Math.round(computeAnnual(n) + cfg.adb.warmStandbyStorageMult * dbStorageAnnual);
  const cold = Math.round(cfg.adb.coldBackupStorageMult * backupStoreAnnual); // storage-only → posture-invariant
  return {
    adbPrimary: { low: primary(lo), central: primary(mid), high: primary(1) },
    warmDrAdd: { low: warm(lo), central: warm(mid), high: warm(1) },
    coldDrAdd: { low: cold, central: cold, high: cold },
  };
}
