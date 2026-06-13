// Central, adjustable configuration for the deterministic sizing + ADB/TCO cost model.
//
// These are the knobs most likely to change when Oracle revises list pricing or sizing guidance.
// Edit them HERE (one place) rather than hunting through the engine — every value carries its source.
// The engine functions default to ENGINE_CONFIG but accept an override argument, so tests and a future
// Atlas source profile can vary a single knob without forking the math. Documented for non-developers
// in docs/SIZING-METHODOLOGY.md §7.
//
// Changing a default here moves the golden-test numbers — that's intended: update the goldens in the
// same change and you have a clean, reviewable record of an Oracle pricing/guidance update.

/** Oracle Autonomous Database list rates + the month length used to annualize them. */
export interface AdbRates {
  /** ADB ECPU list rate, USD per ECPU-hour. Source: Oracle ADB list pricing. */
  ecpuPerHr: number;
  /** ADB storage list rate, USD per GB-month. Source: Oracle ADB list pricing. */
  storagePerGbMo: number;
  /** Billing hours per month used to annualize the ECPU rate (730 = 365×24/12). */
  hoursPerMonth: number;
  /** Assumed Oracle on-disk compression of an UNCOMPRESSED storage estimate (effective = uncompressed /
   * ratio). 3x = conservative midpoint of Advanced Row Compression (2-4x) and OSON (~2.7-3x vs BSON).
   * Source: Oracle Advanced Compression FAQ; Oracle JSON-vs-MongoDB (OSON). Tune here when guidance changes. */
  compressionRatio: number;
}

/** Compute-sizing knobs (the Peak÷N provisioning model + autoscale band). */
export interface SizingConfig {
  /** Peak-headroom divisor for the CONSERVATIVE provisioned base: ceil(max(Peak/n, Average)). */
  conservativeDivisor: number;
  /** Peak-headroom divisor for the AGGRESSIVE provisioned base. */
  aggressiveDivisor: number;
  /** Autoscale ceiling multipliers on the provisioned base, e.g. [2, 3] → 2× and 3× bands. */
  autoscaleMultipliers: readonly [number, number];
  /** Consumed vCPU → ADB ECPU ratio. Phase-1 = 1:1; a future phase may re-tune this. */
  ecpuPerVcpu: number;
}

/** Disaster-recovery formula knobs. */
export interface DrConfig {
  /** Cold (backup-based) DR restore: fixed base hours. */
  coldRtoBaseHours: number;
  /** Cold-DR restore: added hours per TB of data (0.2 h/TB = 1 hour per 5 TB). */
  coldRtoHoursPerTb: number;
}

export interface EngineConfig {
  adb: AdbRates;
  sizing: SizingConfig;
  dr: DrConfig;
  /**
   * MongoDB Atlas cluster tier -> vCPU per node. Lets the engine resolve a tier code the LLM merely
   * READS off an artifact ("M80") into the authoritative vCPU count — the LLM never emits the number,
   * preserving the determinism boundary. An unknown tier is intentionally absent (-> gate-ask, never a
   * guess). Source: docs/ATLAS-SOURCE-PROFILE.md §4 (AWS, illustrative).
   */
  atlasTierVcpu: Record<string, number>;
}

/**
 * Default engine configuration — the live values the deterministic engine uses.
 *
 * SOURCES (update these when the Oracle team revises pricing/guidance, then refresh the goldens):
 *  - adb.ecpuPerHr / adb.storagePerGbMo .... Oracle Autonomous Database public list pricing.
 *  - adb.hoursPerMonth = 730 ............... standard cloud-billing month (365×24/12).
 *  - adb.compressionRatio = 3 ............. uncompressed->on-disk; Oracle Advanced Compression 2-4x / OSON ~2.7-3x.
 *  - sizing divisors + autoscaleMultipliers  CaseForge Peak÷N provisioning model (SIZING-METHODOLOGY.md §1).
 *  - sizing.ecpuPerVcpu = 1 ................ Phase-1 maps consumed vCPU to ECPU 1:1.
 *  - dr.coldRto* ........................... Oracle backup-restore rule of thumb: 1 h + 1 h per 5 TB.
 *  - atlasTierVcpu ......................... MongoDB Atlas tier -> vCPU/node (AWS, illustrative;
 *                                            docs/ATLAS-SOURCE-PROFILE.md §4). M80=32 anchors to the
 *                                            original hand sizing. Low-CPU variants (half the vCPU) are
 *                                            intentionally omitted so an unknown tier becomes a gate ask.
 */
export const ENGINE_CONFIG: EngineConfig = {
  adb: { ecpuPerHr: 0.0807, storagePerGbMo: 0.1156, hoursPerMonth: 730, compressionRatio: 3 },
  sizing: { conservativeDivisor: 2, aggressiveDivisor: 3, autoscaleMultipliers: [2, 3], ecpuPerVcpu: 1 },
  dr: { coldRtoBaseHours: 1, coldRtoHoursPerTb: 0.2 },
  atlasTierVcpu: { M10: 2, M20: 2, M30: 2, M40: 4, M50: 8, M60: 16, M80: 32, M140: 48, M200: 64, M300: 96 },
};
