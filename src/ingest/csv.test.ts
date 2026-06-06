import { describe, it, expect } from 'vitest';
import { parseDelimited } from './csv';

describe('parseDelimited', () => {
  it('parses a simple CSV with a header row', () => {
    expect(parseDelimited('a,b\n1,2\n3,4', ',')).toEqual({
      headers: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });
  it('handles quoted fields containing the delimiter', () => {
    expect(parseDelimited('a,b\n"x,y",2', ',')).toEqual({ headers: ['a', 'b'], rows: [['x,y', '2']] });
  });
  it('handles escaped double-quotes', () => {
    expect(parseDelimited('a\n"he said ""hi"""', ',')).toEqual({ headers: ['a'], rows: [['he said "hi"']] });
  });
  it('handles embedded newlines in quoted fields', () => {
    expect(parseDelimited('a,b\n"line1\nline2",2', ',')).toEqual({
      headers: ['a', 'b'],
      rows: [['line1\nline2', '2']],
    });
  });
  it('parses TSV with a tab delimiter', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual({ headers: ['a', 'b'], rows: [['1', '2']] });
  });
  it('ignores a trailing newline', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual({ headers: ['a', 'b'], rows: [['1', '2']] });
  });
});
