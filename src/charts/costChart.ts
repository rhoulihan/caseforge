import { Svg, PALETTE } from './svg';

export interface CostSegment {
  value: number;
  color: string;
  name: string;
}
export interface CostBar {
  lines: [string, string];
  segments: CostSegment[];
  total: number;
  rtoRpo: string;
  savePct?: number;
}
export interface CostChartData {
  title: string;
  subtitle: string;
  maxK: number;
  bars: CostBar[];
  note: string;
}

const W = 720;
const H = 460;

export function buildCostChart(d: CostChartData): Svg {
  if (!(d.maxK > 0)) throw new RangeError('costChart: maxK must be > 0');
  const s = new Svg(W, H);
  const x0 = 84;
  const x1 = 556;
  const ytop = 92;
  const ybase = 360;
  const sc = (ybase - ytop) / d.maxK;

  s.text(20, 30, d.title, { size: 13, fill: PALETTE.red, weight: 700 });
  s.text(20, 46, d.subtitle, { size: 10, fill: PALETTE.muted });

  for (let v = 0; v <= d.maxK; v += 100) {
    const y = ybase - v * sc;
    s.line(x0, y, x1, y, PALETTE.grid, { sw: 1 });
    s.text(x0 - 8, y + 3.5, `$${v}K`, { size: 9, fill: PALETTE.muted, anchor: 'end' });
  }
  s.line(x0, ybase, x1, ybase, PALETTE.faint, { sw: 1.4 });

  // bar centers distributed across the plot, so any bar count works (not hard-coded to 3).
  // Wide spread (matches the validated 3-bar layout) so adjacent sub-labels keep clearance.
  const n = d.bars.length;
  const plotL = x0 + 15;
  const plotR = x1 + 5;
  const step = n > 0 ? (plotR - plotL) / n : 0;
  const bw = Math.min(86, step * 0.72);
  const centers = d.bars.map((_, i) => plotL + step * (i + 0.5));

  d.bars.forEach((bar, i) => {
    const cx = centers[i]!;
    let y = ybase;
    for (const seg of bar.segments) {
      const h = seg.value * sc;
      y -= h;
      s.rect(cx - bw / 2, y, bw, h, seg.color);
      if (h >= 19) {
        s.text(cx, y + h / 2 + 3.5, `$${seg.value}K`, {
          size: 9.5,
          fill: PALETTE.white,
          weight: 700,
          anchor: 'middle',
        });
        s.text(cx, y + h / 2 + 15, seg.name, { size: 7.6, fill: '#eef2f5', anchor: 'middle' });
      } else {
        s.text(cx + bw / 2 + 6, y + h / 2 + 3.5, `${seg.name} $${seg.value}K`, {
          size: 8.2,
          fill: PALETTE.muted,
        });
      }
    }
    const topY = ybase - bar.total * sc;
    s.text(cx, topY - 9, `$${bar.total}K`, { size: 13, fill: PALETTE.ink, weight: 800, anchor: 'middle' });
    if (bar.savePct !== undefined) {
      s.text(cx, topY - 26, `−${bar.savePct}%`, {
        size: 12,
        fill: PALETTE.red,
        weight: 800,
        anchor: 'middle',
      });
    }
    s.text(cx, ybase + 16, bar.lines[0], { size: 9.5, fill: PALETTE.ink, weight: 700, anchor: 'middle' });
    s.text(cx, ybase + 29, bar.lines[1], { size: 8.4, fill: PALETTE.muted, anchor: 'middle' });
    s.text(cx, ybase + 44, bar.rtoRpo, { size: 7.6, fill: PALETTE.muted, anchor: 'middle' });
  });

  // on-prem reference line across the other bars
  if (d.bars.length > 0) {
    const refY = ybase - d.bars[0]!.total * sc;
    s.line(centers[0]! + bw / 2, refY, centers[n - 1]! + bw / 2 + 4, refY, PALETTE.red, {
      sw: 1,
      dash: '4 4',
    });
  }

  s.text(W / 2, 442, d.note, { size: 7.6, fill: PALETTE.faint, anchor: 'middle', italic: true });
  return s;
}

export function renderCostChart(d: CostChartData): string {
  return buildCostChart(d).toString();
}
