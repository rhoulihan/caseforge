import { describe, it, expect } from 'vitest';
import { ingest } from './ingest';
import type { TablePrimitive, ImagePrimitive } from './types';

const txt = (s: string) => new TextEncoder().encode(s);
const u8 = (...b: number[]) => new Uint8Array(b);

describe('ingest', () => {
  it('routes a CSV to a table primitive and reports the file', () => {
    const b = ingest([{ name: 'metrics.csv', bytes: txt('host,cpu\na,0.2\nb,0.3') }]);
    const table = b.primitives.find((p) => p.kind === 'table') as TablePrimitive;
    expect(table.headers).toEqual(['host', 'cpu']);
    expect(table.rows).toEqual([
      ['a', '0.2'],
      ['b', '0.3'],
    ]);
    expect(b.files[0]).toMatchObject({ type: 'csv', ok: true });
  });

  it('routes a PNG to an image primitive', () => {
    const b = ingest([{ name: 'chart', bytes: u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2) }]);
    const img = b.primitives.find((p) => p.kind === 'image') as ImagePrimitive;
    expect(img.mime).toBe('image/png');
    expect(b.files[0]!.ok).toBe(true);
  });

  it('routes text and JSON to text primitives', () => {
    const b = ingest([
      { name: 'notes', bytes: txt('Just prose without delimiters here.') },
      { name: 'cfg', bytes: txt('{"shards":3}') },
    ]);
    expect(b.primitives.filter((p) => p.kind === 'text')).toHaveLength(2);
  });

  it('records a recognized-but-not-yet-extracted binary (pdf) without producing a primitive', () => {
    const b = ingest([{ name: 'deck', bytes: txt('%PDF-1.7 ...') }]);
    expect(b.files[0]).toMatchObject({ type: 'pdf', ok: false });
    expect(b.primitives).toHaveLength(0);
  });

  it('records unknown binary as not ok', () => {
    const b = ingest([{ name: 'blob', bytes: u8(0, 1, 2, 3) }]);
    expect(b.files[0]).toMatchObject({ type: 'unknown', ok: false });
  });

  it('uses a supplied extractor for an otherwise-unhandled type (registry seam)', () => {
    const b = ingest([{ name: 'deck', bytes: txt('%PDF-1.7 ...') }], {
      pdf: (name) => [{ kind: 'text', source: name, text: 'extracted pdf text' }],
    });
    expect(b.files[0]!.ok).toBe(true);
    expect(b.primitives[0]).toMatchObject({ kind: 'text', text: 'extracted pdf text' });
  });
});
