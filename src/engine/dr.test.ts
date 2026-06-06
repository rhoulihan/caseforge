import { describe, it, expect } from 'vitest';
import { coldRtoHours } from './dr';

describe('coldRtoHours', () => {
  it('is a 1-hour base + 1 hour per 5 TB, rounded up', () => {
    expect(coldRtoHours(45.8)).toBe(Math.ceil(1 + 45.8 / 5)); // ~11h for the Northwind footprint
    expect(coldRtoHours(0)).toBe(1);
    expect(coldRtoHours(5)).toBe(2);
    expect(coldRtoHours(10)).toBe(3);
  });
  it('rejects a negative data size', () => {
    expect(() => coldRtoHours(-1)).toThrow();
  });
});
