import { describe, it, expect } from 'vitest';
import { buildFiveYearChart, renderFiveYearChart, type FiveYearChartData } from './fiveYearChart';
import { withinFrame, noCollisions } from './svg';

const data: FiveYearChartData = {
  title: '5-YEAR CUMULATIVE TCO · MIGRATE vs STATUS QUO',
  subtitle: 'Renew MongoDB once → prove out on ADB → blue/green cutover by Jan 2027',
  maxM: 2.5,
  years: ['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5'],
  statusQuo: [449500, 899000, 1348500, 1798000, 2247500],
  migrateWarm: [680426, 894075, 1107724, 1321373, 1535022],
  migrateCold: [680426, 788172, 895918, 1003664, 1111410],
  paybackYear: 2,
  netSavingsLabel: '5-yr net savings: $712K (warm); up to $1,136K with cold DR',
};

describe('renderFiveYearChart', () => {
  it('renders the title, year axis, payback marker, and savings callout', () => {
    const out = renderFiveYearChart(data);
    expect(out).toContain('5-YEAR CUMULATIVE TCO');
    expect(out).toContain('Year 1');
    expect(out).toContain('Year 5');
    expect(out).toContain('payback ≈ Year 2');
    expect(out).toContain('5-yr net savings');
  });
  it('keeps all content within the frame (guideline rule #1)', () => {
    expect(withinFrame(buildFiveYearChart(data), 16)).toBe(true);
  });
  it('has no overlapping labels (guideline rule #2)', () => {
    expect(noCollisions(buildFiveYearChart(data))).toBe(true);
  });
});

describe('fiveYearChart degenerate & converging inputs', () => {
  it('throws on non-positive maxM', () => {
    expect(() => buildFiveYearChart({ ...data, maxM: 0 })).toThrow(/maxM/);
  });
  it('handles a single year without crashing or NaN', () => {
    const s = buildFiveYearChart({
      ...data,
      years: ['Year 1'],
      statusQuo: [449500],
      migrateWarm: [680426],
      migrateCold: [680426],
      paybackYear: 1,
    });
    expect(withinFrame(s, 16)).toBe(true);
  });
  it('de-collides end labels when status-quo and migrate converge (small savings)', () => {
    const converging = {
      ...data,
      statusQuo: [300000, 600000, 900000, 1200000, 1550000],
      migrateWarm: [500000, 760000, 1020000, 1280000, 1500000],
      migrateCold: [500000, 700000, 900000, 1100000, 1300000],
      paybackYear: 5,
    };
    const s = buildFiveYearChart(converging);
    expect(noCollisions(s)).toBe(true);
    expect(withinFrame(s, 16)).toBe(true);
  });
});
