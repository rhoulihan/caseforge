import { describe, it, expect } from 'vitest';
import { Svg, withinFrame, noCollisions, textWidth } from './svg';

describe('Svg builder bounds', () => {
  it('tracks the bounding box of a rect', () => {
    const s = new Svg(100, 100).rect(10, 20, 30, 40, '#fff');
    expect(s.bounds()).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 });
  });
  it('tracks line endpoints', () => {
    const s = new Svg(100, 100).line(10, 10, 90, 50, '#000');
    expect(s.bounds()).toEqual({ minX: 10, minY: 10, maxX: 90, maxY: 50 });
  });
  it('grows for a middle-anchored text box', () => {
    const s = new Svg(200, 100).text(100, 50, 'hello', { size: 10, anchor: 'middle' });
    const b = s.bounds();
    expect(b.minX).toBeLessThan(100);
    expect(b.maxX).toBeGreaterThan(100);
    expect(b.maxY).toBeCloseTo(50, 0);
  });
});

describe('step-over (hop)', () => {
  it('emits a semicircular arc when crossing a vertical', () => {
    const s = new Svg(200, 100).hop(10, 50, 190, [100], '#000');
    expect(s.toString()).toMatch(/A \d/); // arc command present
  });
  it('emits no arc when there are no crossings', () => {
    const s = new Svg(200, 100).hop(10, 50, 190, [], '#000');
    expect(s.toString()).not.toMatch(/A \d/);
  });
});

describe('withinFrame invariant', () => {
  it('true when content respects padding', () => {
    const s = new Svg(100, 100).rect(20, 20, 60, 60, '#fff');
    expect(withinFrame(s, 16)).toBe(true);
  });
  it('false when content breaches padding', () => {
    const s = new Svg(100, 100).rect(2, 2, 96, 96, '#fff');
    expect(withinFrame(s, 16)).toBe(false);
  });
});

describe('toString', () => {
  it('includes viewBox, white background, and the arrow marker', () => {
    const out = new Svg(120, 80).marker().toString();
    expect(out).toContain('viewBox="0 0 120 80"');
    expect(out).toContain('fill="#ffffff"');
    expect(out).toContain('context-stroke');
  });
});

describe('textWidth', () => {
  it('estimates ~0.6em per char', () => {
    expect(textWidth('abcd', 10)).toBeCloseTo(24, 5);
  });
});

describe('noCollisions (rule #2)', () => {
  it('true when text boxes do not overlap', () => {
    const s = new Svg(200, 100).text(10, 20, 'a', { size: 10 }).text(10, 60, 'b', { size: 10 });
    expect(noCollisions(s)).toBe(true);
  });
  it('false when two text boxes overlap', () => {
    const s = new Svg(200, 100).text(10, 20, 'hello', { size: 10 }).text(12, 22, 'world', { size: 10 });
    expect(noCollisions(s)).toBe(false);
  });
  it('ignores non-text elements (bars/grid are intentional layers)', () => {
    const s = new Svg(200, 100).rect(0, 0, 200, 100, '#eee').text(10, 20, 'x', { size: 10 });
    expect(noCollisions(s)).toBe(true);
  });
});

describe('withinFrame robustness', () => {
  it('true when nothing drawn', () => {
    expect(withinFrame(new Svg(100, 100), 16)).toBe(true);
  });
  it('false when content is non-finite (NaN coordinate)', () => {
    const s = new Svg(100, 100).rect(NaN, 10, 20, 20, '#fff');
    expect(withinFrame(s, 16)).toBe(false);
  });
});

describe('hop right-to-left', () => {
  it('emits a sweep-0 arc when crossing right-to-left', () => {
    const out = new Svg(200, 100).hop(190, 50, 10, [100], '#000').toString();
    expect(out).toMatch(/A 6,6 0 0 0/);
  });
});

describe('esc and element options', () => {
  it('escapes quotes and angle brackets in text content', () => {
    const out = new Svg(120, 50).text(10, 20, 'a "b" <c>', { size: 10 }).toString();
    expect(out).toContain('&quot;');
    expect(out).toContain('&lt;c&gt;');
  });
  it('renders dashed/marked line, circle stroke, rounded rect, and marker def', () => {
    const out = new Svg(100, 100)
      .line(0, 0, 50, 0, '#000', { dash: '4 4', marker: true })
      .circle(50, 50, 5, '#000', { stroke: '#fff', sw: 2 })
      .rect(10, 10, 20, 20, '#000', { rx: 6, stroke: '#111', sw: 1 })
      .marker()
      .toString();
    expect(out).toContain('stroke-dasharray="4 4"');
    expect(out).toContain('marker-end="url(#ar)"');
    expect(out).toContain('<circle');
    expect(out).toContain('rx="6"');
    expect(out).toContain('<defs>');
  });
});
