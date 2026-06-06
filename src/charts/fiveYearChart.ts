import { Svg, PALETTE } from './svg';

export interface FiveYearChartData {
  title: string;
  subtitle: string;
  maxM: number;
  years: string[];
  statusQuo: number[];
  migrateWarm: number[];
  migrateCold?: number[];
  paybackYear: number;
  netSavingsLabel: string;
}

const W = 720;
const H = 440;

/** Spread y-positions to a minimum gap, preserving order (anti-collision for stacked labels). */
function declutter(ys: number[], minGap: number): number[] {
  const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < idx.length; k++) {
    if (idx[k]!.y - idx[k - 1]!.y < minGap) idx[k]!.y = idx[k - 1]!.y + minGap;
  }
  const out = ys.slice();
  for (const o of idx) out[o.i] = o.y;
  return out;
}

export function buildFiveYearChart(d: FiveYearChartData): Svg {
  if (!(d.maxM > 0)) throw new RangeError('fiveYearChart: maxM must be > 0');
  if (d.years.length < 1) throw new RangeError('fiveYearChart: need at least one year');
  const s = new Svg(W, H);
  const x0 = 92;
  const xr = 600;
  const ytop = 80;
  const ybase = 336;
  const sc = (ybase - ytop) / (d.maxM * 1_000_000); // px per dollar
  const n = d.years.length;
  const xs = d.years.map((_, i) => (n === 1 ? (x0 + xr) / 2 : x0 + (i * (xr - x0)) / (n - 1)));
  const y = (dollars: number): number => ybase - dollars * sc;

  s.text(20, 30, d.title, { size: 13, fill: PALETTE.red, weight: 700 });
  s.text(20, 46, d.subtitle, { size: 10, fill: PALETTE.muted });

  for (let v = 0; v <= d.maxM + 1e-9; v += 0.5) {
    const yy = ybase - v * 1_000_000 * sc;
    s.line(x0, yy, xr, yy, PALETTE.grid, { sw: 1 });
    s.text(x0 - 8, yy + 3.5, `$${v.toFixed(1)}M`, { size: 9, fill: PALETTE.muted, anchor: 'end' });
  }
  s.line(x0, ytop, x0, ybase, PALETTE.faint, { sw: 1.4 });
  s.line(x0, ybase, xr, ybase, PALETTE.faint, { sw: 1.4 });
  d.years.forEach((yr, i) =>
    s.text(xs[i]!, ybase + 16, yr, { size: 9.5, fill: PALETTE.ink, weight: 700, anchor: 'middle' })
  );

  const pts = (cum: number[]): [number, number][] => cum.map((c, i) => [xs[i]!, y(c)]);
  s.polyline(pts(d.statusQuo), PALETTE.red, { sw: 2.8 });
  s.polyline(pts(d.migrateWarm), PALETTE.green, { sw: 2.8 });
  if (d.migrateCold) s.polyline(pts(d.migrateCold), PALETTE.green, { sw: 2.2, dash: '6 4' });
  d.statusQuo.forEach((c, i) => s.circle(xs[i]!, y(c), 3.2, PALETTE.red, { stroke: PALETTE.white, sw: 1.5 }));
  d.migrateWarm.forEach((c, i) => s.circle(xs[i]!, y(c), 3.2, PALETTE.green, { stroke: PALETTE.white, sw: 1.5 }));

  // payback crossover marker (only when the payback year is in range)
  const pj = d.paybackYear - 1;
  if (Number.isInteger(d.paybackYear) && d.paybackYear >= 2 && d.paybackYear <= n) {
    const i0 = Math.max(0, pj - 1);
    const d0 = d.migrateWarm[i0]! - d.statusQuo[i0]!;
    const d1 = d.statusQuo[pj]! - d.migrateWarm[pj]!;
    const f = d0 + d1 === 0 ? 0 : d0 / (d0 + d1);
    const xc = xs[i0]! + f * (xs[pj]! - xs[i0]!);
    const yc = y(d.statusQuo[i0]! + f * (d.statusQuo[pj]! - d.statusQuo[i0]!));
    s.line(xc, yc, xc, ytop + 6, PALETTE.red, { sw: 1, dash: '3 4' });
    s.circle(xc, yc, 4.5, PALETTE.red, { stroke: PALETTE.white, sw: 1.8 });
    s.text(xc + 5, ytop + 16, `payback ≈ Year ${d.paybackYear}`, { size: 8.6, fill: PALETTE.red, weight: 700 });
  }

  // end labels, de-collided so converging series can't overlap
  const last = n - 1;
  const labels: { text: string; y: number; fill: string; weight?: number }[] = [
    { text: 'Status quo — keep MongoDB', y: y(d.statusQuo[last]!) - 9, fill: PALETTE.red, weight: 700 },
    { text: 'Migrate to ADB (warm DR)', y: y(d.migrateWarm[last]!) - 9, fill: PALETTE.green, weight: 700 },
  ];
  if (d.migrateCold) labels.push({ text: 'ADB (cold DR)', y: y(d.migrateCold[last]!) + 15, fill: PALETTE.green });
  const ys = declutter(
    labels.map((l) => l.y),
    12
  );
  labels.forEach((l, i) =>
    s.text(xs[last]!, ys[i]!, l.text, { size: 9, fill: l.fill, weight: l.weight, anchor: 'end' })
  );

  // net-savings callout in the open lower-right area
  s.rect(352, 290, 248, 40, '#fdf6f5', { stroke: PALETTE.red, sw: 1, rx: 6 });
  s.text(476, 314, d.netSavingsLabel, { size: 8.6, fill: PALETTE.red, weight: 700, anchor: 'middle' });
  return s;
}

export function renderFiveYearChart(d: FiveYearChartData): string {
  return buildFiveYearChart(d).toString();
}
