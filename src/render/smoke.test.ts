import { describe, it, expect } from 'vitest';
import { renderBusinessCase, renderSizingBrief, renderTechnicalReview, renderClaimsChecklist } from './index';
import { NORTHWIND_DOCMODEL } from './fixtures/northwind-docmodel';

describe('render smoke', () => {
  const renderers = [renderBusinessCase, renderSizingBrief, renderTechnicalReview, renderClaimsChecklist];

  it('all four renderers produce valid, deterministic, self-contained HTML with print CSS', () => {
    for (const r of renderers) {
      const a = r(NORTHWIND_DOCMODEL);
      const b = r(NORTHWIND_DOCMODEL);
      expect(a.html).toBe(b.html); // deterministic
      expect(a.filename.endsWith('.html')).toBe(true);
      expect(a.html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(a.html).toContain('<style>');
      expect(a.html).toContain('@page'); // print CSS embedded
    }
  });
});
