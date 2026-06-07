import { describe, it, expect } from 'vitest';
import { emptyQualContext, mergeQualContexts, type QualContext } from './qual-context';

describe('qual-context', () => {
  it('emptyQualContext returns an empty items list', () => {
    expect(emptyQualContext()).toEqual({ items: [] });
  });

  it('concatenates items from both operands (duplicates across sources are preserved)', () => {
    const a: QualContext = { items: [{ text: 'cost is a concern', source: 'a.msg', category: 'concern' }] };
    const b: QualContext = { items: [{ text: 'go-live by Q3', source: 'b.eml', category: 'timeline' }] };
    expect(mergeQualContexts(a, b)).toEqual({
      items: [
        { text: 'cost is a concern', source: 'a.msg', category: 'concern' },
        { text: 'go-live by Q3', source: 'b.eml', category: 'timeline' },
      ],
    });
  });

  it('tolerates undefined operands', () => {
    expect(mergeQualContexts(undefined, undefined)).toEqual({ items: [] });
    const a: QualContext = { items: [{ text: 'x', source: 's', category: 'objection' }] };
    expect(mergeQualContexts(a, undefined)).toEqual(a);
    expect(mergeQualContexts(undefined, a)).toEqual(a);
  });

  it('does not mutate its operands', () => {
    const a: QualContext = { items: [{ text: 'x', source: 's', category: 'positioning' }] };
    const b: QualContext = { items: [{ text: 'y', source: 't', category: 'concern' }] };
    mergeQualContexts(a, b);
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
  });
});
