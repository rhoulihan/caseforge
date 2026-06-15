import { describe, it, expect } from 'vitest';
import { renderSizingBrief } from './sizingBrief';
import { NORTHWIND_DOCMODEL } from './fixtures/northwind-docmodel';

const out = renderSizingBrief(NORTHWIND_DOCMODEL);

describe('renderSizingBrief', () => {
  it('is deterministic', () => {
    expect(renderSizingBrief(NORTHWIND_DOCMODEL).html).toBe(out.html);
  });

  it('emits a slugged filename', () => {
    expect(out.filename).toBe('sizing-brief-northwind.html');
  });

  it('shows the scenario table with conservative base 22 and aggressive base 18 (read verbatim)', () => {
    expect(out.html).toContain('Conservative');
    expect(out.html).toContain('Aggressive');
    expect(out.html).toContain('<td>22</td>');
    expect(out.html).toContain('<td>18</td>');
  });

  it('shows the 2.5x average-to-peak ratio from the engine', () => {
    expect(out.html).toContain('2.5&times;');
  });

  it('shows the primary utilization as 18% avg / 45% peak', () => {
    expect(out.html).toContain('18%');
    expect(out.html).toContain('45%');
  });

  it('shows the compression assumption only when the storage figure was uncompressed', () => {
    // Northwind's figure is compressed (on-disk) -> no parenthetical.
    expect(out.html).not.toContain('uncompressed');
    // An uncompressed basis -> the effective figure is shown with its source figure + the assumed factor.
    const uncompressed = {
      ...NORTHWIND_DOCMODEL,
      sizing: { ...NORTHWIND_DOCMODEL.sizing, dataCompressedGb: 15000, storageRawGb: 45000, storageCompressed: false, storageCompressionRatio: 3 },
    };
    const html = renderSizingBrief(uncompressed).html;
    expect(html).toContain('45.0 TB uncompressed');
    expect(html).toContain('3&times; Oracle compression assumed');
  });
});
