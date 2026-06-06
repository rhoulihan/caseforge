// Disaster-recovery metrics that are pure formulas (kept out of the renderer so the numbers are
// computed once, deterministically, and read verbatim downstream).

/** Backup-based (cold) DR restore time: a 1-hour base + 1 hour per 5 TB, rounded up. */
export function coldRtoHours(dataTb: number): number {
  if (!(dataTb >= 0)) throw new RangeError('coldRtoHours: dataTb must be >= 0');
  return Math.ceil(1 + dataTb / 5);
}
