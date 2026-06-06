import { describe, it, expect } from 'vitest';
import { parseNumericColumn, seriesStats, isTimestampColumn, detectPercentScale, asUtilFraction } from './stats';

describe('parseNumericColumn', () => {
  it('strips %, thousands commas, and trailing units; drops blanks and non-numerics', () => {
    expect(parseNumericColumn(['45%', '1,200', '32 vCPU', '', 'x'])).toEqual([45, 1200, 32]);
  });
});

describe('seriesStats', () => {
  it('computes avg/peak/p95/min/n', () => {
    expect(seriesStats([10, 20, 30, 40])).toEqual({ avg: 25, peak: 40, p95: 40, min: 10, n: 4 });
  });
  it('handles a single-value series', () => {
    expect(seriesStats([42])).toEqual({ avg: 42, peak: 42, p95: 42, min: 42, n: 1 });
  });
  it('computes a P95 distinct from the peak on a larger series (nearest-rank)', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    const s = seriesStats(xs);
    expect(s.p95).toBe(19);
    expect(s.peak).toBe(20);
  });
});

describe('isTimestampColumn', () => {
  it('is true for ISO/epoch columns and false for plain value columns', () => {
    expect(isTimestampColumn(['2026-01-01T00:00Z', '2026-01-01T01:00Z', '2026-01-01T02:00Z'])).toBe(true);
    expect(isTimestampColumn(['1735689600', '1735693200', '1735696800'])).toBe(true);
    expect(isTimestampColumn(['18', '22', '45'])).toBe(false);
  });
});

describe('detectPercentScale (the 100x guard input)', () => {
  it('treats clearly percent-ranged values as percent (max > 1.5)', () => {
    expect(detectPercentScale('System CPU %', [18, 22, 45])).toBe(true);
    expect(detectPercentScale('cpu', [18, 22, 45])).toBe(true); // unitless but max > 1.5
  });
  it('treats already-fraction values as a fraction even when the header says percent (the 100x-bug fix)', () => {
    expect(detectPercentScale('CPU percent', [0.2, 0.3])).toBe(false);
    expect(detectPercentScale('System CPU Percent', [0.18, 0.22, 0.45])).toBe(false);
    expect(detectPercentScale('util', [0.18, 0.45])).toBe(false);
  });
  it('uses the header only in the ambiguous (1.0, 1.5] band, and decides the 1.5 boundary by range', () => {
    expect(detectPercentScale('cpu', [1.49])).toBe(false); // <= 1.5, no percent header -> fraction
    expect(detectPercentScale('cpu', [1.51])).toBe(true); // > 1.5 -> percent
    expect(detectPercentScale('cpu %', [1.2])).toBe(true); // ambiguous band, header says percent
  });
});

describe('asUtilFraction', () => {
  it('divides a percent-scaled series by 100', () => {
    const f = asUtilFraction({ avg: 18, peak: 45 }, true);
    expect(f.avgPct).toBeCloseTo(0.18, 10);
    expect(f.peakPct).toBeCloseTo(0.45, 10);
  });
  it('leaves a fraction series untouched', () => {
    expect(asUtilFraction({ avg: 0.18, peak: 0.45 }, false)).toEqual({ avgPct: 0.18, peakPct: 0.45 });
  });
});
