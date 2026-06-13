// On-disk storage estimate handling. A customer's "database size" is usually the LOGICAL/uncompressed
// figure; the ADB storage cost needs the COMPRESSED on-disk footprint Oracle would store. An uncompressed
// estimate is divided by the assumed Oracle compression ratio (ENGINE_CONFIG.adb.compressionRatio).
import { ENGINE_CONFIG } from './config';

/** Effective on-disk (compressed) GB for the ADB storage cost / cold-DR RTO / cost-research prompt.
 * A compressed figure is used as-is; an uncompressed one is divided by the Oracle compression ratio. */
export function effectiveCompressedGb(
  rawGb: number,
  compressed: boolean,
  ratio: number = ENGINE_CONFIG.adb.compressionRatio,
): number {
  if (!(rawGb > 0)) throw new RangeError('effectiveCompressedGb: rawGb must be > 0');
  if (!(ratio > 0)) throw new RangeError('effectiveCompressedGb: ratio must be > 0');
  return compressed ? rawGb : rawGb / ratio;
}
