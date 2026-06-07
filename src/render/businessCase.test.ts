import { describe, it, expect } from 'vitest';
import { renderBusinessCase } from './businessCase';
import { buildCostChart } from '../charts/costChart';
import { buildFiveYearChart } from '../charts/fiveYearChart';
import { withinFrame, noCollisions } from '../charts/svg';
import { NORTHWIND_DOCMODEL } from './fixtures/northwind-docmodel';

const out = renderBusinessCase(NORTHWIND_DOCMODEL);

describe('renderBusinessCase', () => {
  it('is deterministic', () => {
    expect(renderBusinessCase(NORTHWIND_DOCMODEL).html).toBe(out.html);
  });

  it('emits a slugged filename and a self-contained HTML document', () => {
    expect(out.filename).toBe('business-case-northwind.html');
    expect(out.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out.html).toContain('<style>');
  });

  it('has the headline structure (1 h1, 4 stat cards, 2 charts, 2 DR cards, pull-quote)', () => {
    expect((out.html.match(/<h1>/g) || []).length).toBe(1);
    expect((out.html.match(/class="stat[ "]/g) || []).length).toBe(4); // stat cards, not .stats/.status
    expect((out.html.match(/<svg/g) || []).length).toBe(2);
    expect((out.html.match(/class="card/g) || []).length).toBe(2);
    expect(out.html).toContain('class="pull"');
  });

  it('shows the headline numbers read verbatim from the DocModel', () => {
    expect(out.html).toContain('$450K'); // on-prem total
    expect(out.html).toContain('$214K'); // ADB warm
    expect(out.html).toContain('52%'); // saving pct (read, not recomputed)
    expect(out.html).toContain('~Yr 2'); // payback
  });

  it('escapes prose (no XSS)', () => {
    const evil = structuredClone(NORTHWIND_DOCMODEL);
    evil.prose.businessCase.execSummary = '<script>alert(1)</script>';
    expect(renderBusinessCase(evil).html).not.toContain('<script>alert(1)</script>');
  });

  it('renders the h1 with a correctly-encoded apostrophe (not double-escaped)', () => {
    expect(out.html).toContain('Halve Northwind&#39;s Database TCO');
    expect(out.html).not.toContain('&amp;#39;');
  });

  it('embeds a cost chart that respects the house-style invariants', () => {
    const s = buildCostChart(NORTHWIND_DOCMODEL.charts.cost);
    expect(withinFrame(s, 16)).toBe(true);
    expect(noCollisions(s)).toBe(true);
    expect(s.hasNonFinite()).toBe(false);
  });

  it('embeds a five-year chart that respects the house-style invariants on the actual fixture data', () => {
    const s = buildFiveYearChart(NORTHWIND_DOCMODEL.charts.fiveYear);
    expect(withinFrame(s, 16)).toBe(true);
    expect(noCollisions(s)).toBe(true);
    expect(s.hasNonFinite()).toBe(false);
  });

  it('shows list-vs-your-price + a discount note when a customer discount applies', () => {
    const dm = structuredClone(NORTHWIND_DOCMODEL);
    dm.discountPct = 20;
    dm.listAdbAnnual = { warm: 213649, cold: 107746 };
    dm.tco.adbWarmAnnual.central = Math.round(213649 * 0.8); // 170919 — the discounted "your price"
    const html = renderBusinessCase(dm).html;
    expect(html).toContain('class="list"'); // struck-through list price element
    expect(html).toContain('$214K'); // list (213649)
    expect(html).toContain('$171K'); // your price (170919)
    expect(html).toContain('20% customer discount'); // stat-card sublabel
    expect(html.toLowerCase()).toContain('customer discount off list'); // footer wording
  });

  it('shows no discount framing at 0% (default)', () => {
    expect(out.html).not.toContain('class="list"');
    expect(out.html).not.toContain('customer discount');
  });
});
