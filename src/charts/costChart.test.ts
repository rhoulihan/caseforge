import { describe, it, expect } from 'vitest';
import { buildCostChart, renderCostChart, type CostChartData } from './costChart';
import { PALETTE, withinFrame, noCollisions } from './svg';

const data: CostChartData = {
  title: 'FULLY-LOADED ANNUAL COST',
  subtitle: 'on-prem MongoDB (with DR) vs Oracle Autonomous Database',
  maxK: 480,
  note: 'Central estimate · USD · list pricing before discounts',
  bars: [
    {
      lines: ['On-prem MongoDB', '(self-managed, with DR)'],
      total: 450,
      rtoRpo: 'RTO ~min · RPO ~sec (live replicas)',
      segments: [
        { value: 240, color: PALETTE.slate, name: 'MongoDB EA subscription' },
        { value: 140, color: PALETTE.mid, name: 'Hardware · storage · facility' },
        { value: 70, color: PALETTE.lite, name: 'DBA / ops labor' },
      ],
    },
    {
      lines: ['Oracle ADB', '+ warm pilot-light DR'],
      total: 214,
      rtoRpo: 'RTO < 10 min · RPO ≤ 1 min',
      savePct: 52,
      segments: [
        { value: 81, color: PALETTE.green, name: 'ADB primary' },
        { value: 133, color: PALETTE.greenLt, name: 'Autonomous Data Guard' },
      ],
    },
    {
      lines: ['Oracle ADB', '+ cold pilot-light DR'],
      total: 108,
      rtoRpo: 'RTO ~10 hrs · RPO ~1 min',
      savePct: 76,
      segments: [
        { value: 81, color: PALETTE.green, name: 'ADB primary' },
        { value: 27, color: PALETTE.greenLt, name: 'backup-based DR' },
      ],
    },
  ],
};

describe('renderCostChart', () => {
  it('renders the title, bar totals, savings, and RTO labels', () => {
    const out = renderCostChart(data);
    expect(out).toContain('FULLY-LOADED ANNUAL COST');
    expect(out).toContain('$450K');
    expect(out).toContain('$214K');
    expect(out).toContain('$108K');
    expect(out).toContain('RTO &lt; 10 min · RPO ≤ 1 min');
    expect(out).toContain('−52%');
    expect(out).toContain('−76%');
  });
  it('keeps all content within the frame (guideline rule #1)', () => {
    expect(withinFrame(buildCostChart(data), 16)).toBe(true);
  });
  it('has no overlapping labels (guideline rule #2)', () => {
    expect(noCollisions(buildCostChart(data))).toBe(true);
  });
});

describe('costChart degenerate inputs', () => {
  it('throws on non-positive maxK', () => {
    expect(() => buildCostChart({ ...data, maxK: 0 })).toThrow(/maxK/);
  });
  it('renders without crashing when there are no bars', () => {
    const s = buildCostChart({ ...data, bars: [] });
    expect(withinFrame(s, 16)).toBe(true);
  });
});
