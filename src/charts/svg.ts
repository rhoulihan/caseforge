// Pure, dependency-free SVG builder in the Oracle house style (see ~/.claude/svg-guidelines.md).
// Tracks per-element bounding boxes so `withinFrame` (rule #1) and `noCollisions` (rule #2) are testable.

export const PALETTE = {
  red: '#C74634',
  green: '#16a34a',
  greenLt: '#9fd4b8',
  blue: '#2563eb',
  ink: '#1a1a1a',
  slate: '#334155',
  mid: '#64748b',
  lite: '#94a3b8',
  muted: '#5b6570',
  faint: '#8a929b',
  grid: '#e9edf0',
  white: '#ffffff',
} as const;

export const FONT = "'Segoe UI',system-ui,-apple-system,sans-serif";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type BoxKind = 'text' | 'rect' | 'line' | 'circle' | 'path';
export interface Box extends Bounds {
  kind: BoxKind;
}

/** Approximate rendered width of a string at a given font size (~0.6em per char for Segoe UI). */
export function textWidth(s: string, size: number): number {
  return s.length * size * 0.6;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Anchor = 'start' | 'middle' | 'end';

export class Svg {
  private parts: string[] = [];
  private defs: string[] = [];
  private boxList: Box[] = [];
  private bad = false;
  private b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  constructor(
    public readonly w: number,
    public readonly h: number
  ) {}

  private box(kind: BoxKind, x0: number, y0: number, x1: number, y1: number): void {
    if (![x0, y0, x1, y1].every(Number.isFinite)) this.bad = true;
    const minX = Math.min(x0, x1);
    const minY = Math.min(y0, y1);
    const maxX = Math.max(x0, x1);
    const maxY = Math.max(y0, y1);
    if (minX < this.b.minX) this.b.minX = minX;
    if (minY < this.b.minY) this.b.minY = minY;
    if (maxX > this.b.maxX) this.b.maxX = maxX;
    if (maxY > this.b.maxY) this.b.maxY = maxY;
    this.boxList.push({ kind, minX, minY, maxX, maxY });
  }

  bounds(): Bounds {
    return { ...this.b };
  }
  boxes(): Box[] {
    return this.boxList.slice();
  }
  hasNonFinite(): boolean {
    return this.bad;
  }

  marker(): this {
    this.defs.push(
      '<marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" ' +
        'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="context-stroke"/></marker>'
    );
    return this;
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
    opts: { stroke?: string; sw?: number; rx?: number } = {}
  ): this {
    const stroke = opts.stroke ? ` stroke="${opts.stroke}" stroke-width="${opts.sw ?? 1}"` : '';
    this.parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${opts.rx ?? 0}" fill="${fill}"${stroke}/>`
    );
    this.box('rect', x, y, x + w, y + h);
    return this;
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    stroke: string,
    opts: { sw?: number; dash?: string; marker?: boolean } = {}
  ): this {
    const dash = opts.dash ? ` stroke-dasharray="${opts.dash}"` : '';
    const m = opts.marker ? ' marker-end="url(#ar)"' : '';
    this.parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${opts.sw ?? 1.4}"${dash}${m}/>`
    );
    this.box('line', x1, y1, x2, y2);
    return this;
  }

  circle(cx: number, cy: number, r: number, fill: string, opts: { stroke?: string; sw?: number } = {}): this {
    const stroke = opts.stroke ? ` stroke="${opts.stroke}" stroke-width="${opts.sw ?? 1}"` : '';
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${stroke}/>`);
    this.box('circle', cx - r, cy - r, cx + r, cy + r);
    return this;
  }

  text(
    x: number,
    y: number,
    s: string,
    opts: { size?: number; fill?: string; anchor?: Anchor; weight?: number; italic?: boolean } = {}
  ): this {
    const size = opts.size ?? 11;
    const anchor: Anchor = opts.anchor ?? 'start';
    const w = textWidth(s, size);
    let x0 = x;
    let x1 = x + w;
    if (anchor === 'middle') {
      x0 = x - w / 2;
      x1 = x + w / 2;
    } else if (anchor === 'end') {
      x0 = x - w;
      x1 = x;
    }
    const weight = opts.weight ? ` font-weight="${opts.weight}"` : '';
    const italic = opts.italic ? ' font-style="italic"' : '';
    this.parts.push(
      `<text x="${x}" y="${y}" font-size="${size}" fill="${opts.fill ?? PALETTE.ink}" ` +
        `text-anchor="${anchor}"${weight}${italic}>${esc(s)}</text>`
    );
    this.box('text', x0, y - size, x1, y);
    return this;
  }

  polyline(pts: [number, number][], stroke: string, opts: { sw?: number; dash?: string } = {}): this {
    const dash = opts.dash ? ` stroke-dasharray="${opts.dash}"` : '';
    const p = pts.map(([x, y]) => `${x},${y}`).join(' ');
    this.parts.push(
      `<polyline points="${p}" fill="none" stroke="${stroke}" stroke-width="${opts.sw ?? 2.4}"${dash} stroke-linejoin="round"/>`
    );
    for (const [x, y] of pts) this.box('path', x, y, x, y);
    return this;
  }

  /** Horizontal connector x1→x2 at y that steps over each vertical x in `hops` with a semicircular bridge. */
  hop(
    x1: number,
    y: number,
    x2: number,
    hops: number[],
    stroke: string,
    opts: { r?: number; sw?: number; marker?: boolean } = {}
  ): this {
    const r = opts.r ?? 6;
    const ltr = x2 >= x1;
    const sweep = ltr ? 1 : 0;
    const ordered = [...hops].sort((a, b) => (ltr ? a - b : b - a));
    let d = `M ${x1},${y} `;
    for (const hx of ordered) {
      const before = ltr ? hx - r : hx + r;
      const after = ltr ? hx + r : hx - r;
      d += `L ${before},${y} A ${r},${r} 0 0 ${sweep} ${after},${y} `;
      this.box('path', hx - r, y - r, hx + r, y);
    }
    d += `L ${x2},${y}`;
    const m = opts.marker ? ' marker-end="url(#ar)"' : '';
    this.parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${opts.sw ?? 1.8}"${m}/>`);
    this.box('path', x1, y, x2, y);
    return this;
  }

  toString(): string {
    const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" ` +
      `viewBox="0 0 ${this.w} ${this.h}" font-family="${FONT}">` +
      defs +
      `<rect width="100%" height="100%" fill="${PALETTE.white}"/>` +
      this.parts.join('') +
      `</svg>`
    );
  }
}

/** SVG guideline rule #1: all drawn content stays within `pad` of the frame. Non-finite content fails. */
export function withinFrame(svg: Svg, pad: number): boolean {
  if (svg.hasNonFinite()) return false; // NaN/Infinity content (e.g. bad scale or single point)
  const b = svg.bounds();
  if (!isFinite(b.minX)) return true; // nothing drawn
  return b.minX >= pad && b.minY >= pad && b.maxX <= svg.w - pad && b.maxY <= svg.h - pad;
}

/** SVG guideline rule #2: no two label (text) boxes overlap (expanded by `gap`). */
export function noCollisions(svg: Svg, gap = 0): boolean {
  const texts = svg.boxes().filter((b) => b.kind === 'text');
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const c = texts[j]!;
      const overlap =
        a.minX < c.maxX + gap && c.minX < a.maxX + gap && a.minY < c.maxY + gap && c.minY < a.maxY + gap;
      if (overlap) return false;
    }
  }
  return true;
}
