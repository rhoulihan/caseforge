// Deterministic numeric-series statistics — the SINGLE source of avg/peak/P95 (spec §7:
// reading numbers off structured data is more accurate than reading a chart). Pure, total
// functions: no LLM, no I/O, no Date.now. The LLM never computes any of these.

export interface SeriesStats {
  avg: number;
  peak: number;
  p95: number;
  min: number;
  n: number;
}

/** Parse a column of strings into numbers: strip thousands commas, %, and trailing units; drop blanks/non-numerics. */
export function parseNumericColumn(values: string[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const cleaned = v.replace(/,/g, '').replace(/%/g, '').trim();
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** avg=mean, peak=max, p95=nearest-rank, min, n. Empty series -> all zero. */
export function seriesStats(xs: number[]): SeriesStats {
  const n = xs.length;
  if (n === 0) return { avg: 0, peak: 0, p95: 0, min: 0, n: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  const rank = Math.ceil(0.95 * n); // nearest-rank P95
  return {
    avg: sum / n,
    peak: sorted[n - 1]!,
    p95: sorted[Math.min(rank, n) - 1]!,
    min: sorted[0]!,
    n,
  };
}

function looksLikeTimestamp(s: string): boolean {
  const t = s.trim();
  if (/^\d{10,13}$/.test(t)) return true; // epoch seconds / millis
  if (!/[-/:T]/.test(t)) return false; // a timestamp needs a date/time separator
  return !Number.isNaN(Date.parse(t)); // deterministic given the input (no current-time dependency)
}

/** True when >=80% of the values parse as timestamps (ISO/epoch) — i.e. this is a time axis. */
export function isTimestampColumn(values: string[]): boolean {
  if (values.length === 0) return false;
  const hits = values.filter(looksLikeTimestamp).length;
  return hits / values.length >= 0.8;
}

/**
 * Decide whether a CPU-utilization series is 0-100 percent (vs a 0-1 fraction). Driven by the
 * matched header/unit token, with a numeric-range fallback. This is the input to the 100x guard:
 * the engine multiplies shards*vcpu*pct directly, so a 45 read as a fraction inflates ECPU 100x.
 */
export function detectPercentScale(header: string, values: number[]): boolean {
  // Numeric range is the authority — a misleading header must not override it (a "percent"-headed
  // column whose values are already 0-1 fractions must NOT be divided again; that was a 100x bug).
  if (values.length > 0) {
    const max = Math.max(...values);
    if (max > 1.5) return true; // a 0-1 fraction never exceeds ~1; >1.5 is definitely percent-scaled
    if (max <= 1.0) return false; // already a fraction — never divide, regardless of the header
  }
  // ambiguous band (1.0, 1.5] or no values: fall back to the header/unit token
  const h = header.toLowerCase();
  return h.includes('%') || h.includes('percent');
}

/** Normalize avg/peak to a 0-1 fraction, dividing by 100 when the series is percent-scaled. */
export function asUtilFraction(s: { avg: number; peak: number }, percentScaled: boolean): { avgPct: number; peakPct: number } {
  const f = percentScaled ? 100 : 1;
  return { avgPct: s.avg / f, peakPct: s.peak / f };
}
