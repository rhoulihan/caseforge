import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeProse, fmtUsd, fmtPct, slug, buildHeader, table } from './shared';
import { LAYOUT_CSS } from './layout.css';

describe('shared helpers', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml("a & b ' c")).toBe('a &amp; b &#39; c');
  });
  it('escapeProse escapes, passes plain text, and tolerates undefined', () => {
    expect(escapeProse('<b>')).toBe('&lt;b&gt;');
    expect(escapeProse('plain')).toBe('plain');
    expect(escapeProse(undefined)).toBe('');
  });
  it('formats currency in K and M', () => {
    expect(fmtUsd(450000)).toBe('$450K');
    expect(fmtUsd(214000)).toBe('$214K');
    expect(fmtUsd(1_140_000)).toBe('$1.14M');
  });
  it('formats percent', () => {
    expect(fmtPct(52)).toBe('52%');
  });
  it('makes filename-safe slugs', () => {
    expect(slug('Northwind Mutual, Inc.')).toBe('northwind-mutual-inc');
  });
  it('buildHeader includes company, date, and status', () => {
    const h = buildHeader({ companyName: 'Northwind', preparedDate: '2026-06-05', documentStatus: 'preliminary', title: 'Business Case' });
    expect(h).toContain('Northwind');
    expect(h).toContain('2026-06-05');
    expect(h).toContain('preliminary');
  });
  it('builds a table with headers and rows', () => {
    const t = table(['A', 'B'], [['1', '2']]);
    expect(t).toContain('<th>A</th>');
    expect(t).toContain('<td>1</td>');
  });
});

describe('layout CSS', () => {
  it('includes print rules', () => {
    expect(LAYOUT_CSS).toContain('@page');
    expect(LAYOUT_CSS).toContain('@media print');
  });
});
