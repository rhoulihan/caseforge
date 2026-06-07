import { describe, it, expect } from 'vitest';
import { tierToVcpu, KNOWN_TIERS } from './tier-lookup';
import { ENGINE_CONFIG } from '../engine/config';

describe('tier-lookup', () => {
  it('maps every known Atlas tier to its vCPU count', () => {
    expect(tierToVcpu('M10')).toBe(2);
    expect(tierToVcpu('M40')).toBe(4);
    expect(tierToVcpu('M50')).toBe(8);
    expect(tierToVcpu('M60')).toBe(16);
    expect(tierToVcpu('M80')).toBe(32); // anchor — matches the original hand sizing (hoVcpu = 32)
    expect(tierToVcpu('M140')).toBe(48);
    expect(tierToVcpu('M200')).toBe(64);
    expect(tierToVcpu('M300')).toBe(96);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(tierToVcpu('  m80 ')).toBe(32);
  });

  it('returns undefined for an unknown or low-CPU-variant tier (never guesses)', () => {
    expect(tierToVcpu('M999')).toBeUndefined();
    expect(tierToVcpu('M30_LOW_CPU')).toBeUndefined();
    expect(tierToVcpu('')).toBeUndefined();
  });

  it('KNOWN_TIERS lists exactly the configured tiers', () => {
    expect(KNOWN_TIERS).toContain('M80');
    expect([...KNOWN_TIERS].sort()).toEqual(Object.keys(ENGINE_CONFIG.atlasTierVcpu).sort());
  });

  it('respects an injected config override (does not hardcode the table)', () => {
    const cfg = { ...ENGINE_CONFIG, atlasTierVcpu: { M80: 999 } };
    expect(tierToVcpu('M80', cfg)).toBe(999);
    expect(tierToVcpu('M10', cfg)).toBeUndefined();
  });
});
