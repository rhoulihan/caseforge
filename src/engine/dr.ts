// Disaster-recovery metrics that are pure formulas (kept out of the renderer so the numbers are
// computed once, deterministically, and read verbatim downstream).

import { ENGINE_CONFIG, type DrConfig } from './config';

/** Backup-based (cold) DR restore time: base hours + per-TB rate, rounded up (default 1 h + 1 h/5 TB). */
export function coldRtoHours(dataTb: number, cfg: DrConfig = ENGINE_CONFIG.dr): number {
  if (!(dataTb >= 0)) throw new RangeError('coldRtoHours: dataTb must be >= 0');
  return Math.ceil(cfg.coldRtoBaseHours + dataTb * cfg.coldRtoHoursPerTb);
}
