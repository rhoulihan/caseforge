import { describe, it, expect } from 'vitest';
import { renderTechnicalReview } from './technicalReview';
import { NORTHWIND_DOCMODEL } from './fixtures/northwind-docmodel';

const out = renderTechnicalReview(NORTHWIND_DOCMODEL);
const s = NORTHWIND_DOCMODEL.sufficiency;

describe('renderTechnicalReview', () => {
  it('is deterministic', () => {
    expect(renderTechnicalReview(NORTHWIND_DOCMODEL).html).toBe(out.html);
  });

  it('embeds the sufficiency verdict tier', () => {
    expect(out.html).toContain('engineering-grade');
  });

  it('embeds an inventory row per file and a coverage row per signal', () => {
    for (const i of s.inventory) expect(out.html).toContain(i.name);
    for (const c of s.coverage) expect(out.html).toContain(c.signalId);
  });

  it('embeds the sizing sensitivity (base 22 and 18)', () => {
    expect(out.html).toContain('<td>22</td>');
    expect(out.html).toContain('<td>18</td>');
  });
});
