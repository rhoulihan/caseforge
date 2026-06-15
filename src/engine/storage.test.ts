import { describe, it, expect } from 'vitest';
import { effectiveCompressedGb } from './storage';
import { ENGINE_CONFIG } from './config';

describe('effectiveCompressedGb', () => {
  it('returns the raw value when already compressed', () => {
    expect(effectiveCompressedGb(45_800, true)).toBe(45_800);
  });
  it('divides an uncompressed value by the 3x ratio', () => {
    expect(effectiveCompressedGb(45_000, false)).toBe(15_000);
    expect(effectiveCompressedGb(45_000, false, 3)).toBe(15_000);
  });
  it('honors an override ratio', () => {
    expect(effectiveCompressedGb(40_000, false, 4)).toBe(10_000);
  });
  it('rejects non-positive / NaN raw sizes and ratios', () => {
    expect(() => effectiveCompressedGb(0, false)).toThrow();
    expect(() => effectiveCompressedGb(Number.NaN, true)).toThrow();
    expect(() => effectiveCompressedGb(1000, false, 0)).toThrow();
  });
  it('defaults to the config ratio (3)', () => {
    expect(ENGINE_CONFIG.adb.compressionRatio).toBe(3);
  });
});
