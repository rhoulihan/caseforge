import { describe, it, expect } from 'vitest';
import {
  matchSignalByAlias,
  roleTokenOf,
  classifyTable,
  bindKeyValue,
  bindNumericSeries,
  bindTableScalars,
  bindKeyValueTable,
  isNoise,
} from './heuristics';
import { MONGODB_PROFILE } from '../profile/mongodb';
import type { TablePrimitive, KeyValuePrimitive, TextPrimitive } from '../ingest/types';

const schema = MONGODB_PROFILE.signalSchema;

describe('matchSignalByAlias', () => {
  it('resolves a generic CPU header to the primary util signal, case-insensitively', () => {
    expect(matchSignalByAlias('System CPU', schema)?.id).toBe('util.primary');
    expect(matchSignalByAlias('system cpu %', schema)?.id).toBe('util.primary');
  });
  it('resolves a role-qualified header to that role (longest-alias wins)', () => {
    expect(matchSignalByAlias('Secondary CPU', schema)?.id).toBe('util.hoSec');
    expect(matchSignalByAlias('DR CPU', schema)?.id).toBe('util.dr');
  });
  it('returns null when nothing matches', () => {
    expect(matchSignalByAlias('quarterly revenue', schema)).toBeNull();
  });
});

describe('roleTokenOf', () => {
  it('detects role tokens', () => {
    expect(roleTokenOf('Secondary node CPU')).toBe('secondary');
    expect(roleTokenOf('DR region')).toBe('dr');
    expect(roleTokenOf('primary cpu')).toBe('primary');
    expect(roleTokenOf('System CPU')).toBeNull();
  });
});

const tsRow = (t: string, ...vals: string[]): string[] => [t, ...vals];

describe('classifyTable', () => {
  it('labels a timestamp + numeric table a metric-time-series', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'cpu.csv',
      headers: ['timestamp', 'System CPU %'],
      rows: [tsRow('2026-01-01T00:00Z', '18'), tsRow('2026-01-01T01:00Z', '45')],
    };
    expect(classifyTable(t).role).toBe('metric-time-series');
  });
  it('labels a currency-bearing table a cost-model', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'bom.xlsx',
      headers: ['Component', 'Annual Cost ($)'],
      rows: [['Servers', '120,000']],
    };
    expect(classifyTable(t).role).toBe('cost-model');
  });
});

describe('bindKeyValue', () => {
  it('binds exact scalar values from key-value pairs', () => {
    const kv: KeyValuePrimitive = { kind: 'keyvalue', source: 'topology.txt', pairs: { 'cores per node': '32', shards: '3' } };
    const binds = bindKeyValue(kv, schema);
    const cores = binds.find((b) => b.signalId === 'node.hoVcpu');
    const shards = binds.find((b) => b.signalId === 'cluster.shardCount');
    expect(cores?.value).toBe(32);
    expect(cores?.method).toBe('keyvalue');
    expect(shards?.value).toBe(3);
  });
});

describe('bindTableScalars (per-column cost-model routing)', () => {
  it('binds a scalar column from a BOM table while ignoring the currency column', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'bom.xlsx',
      headers: ['vCPU per node', 'Annual Cost ($)'],
      rows: [['32', '120,000']],
    };
    const binds = bindTableScalars(t, schema);
    expect(binds.find((b) => b.signalId === 'node.hoVcpu')?.value).toBe(32);
    // The currency column must not produce a sizing binding (e.g. no value 120000).
    expect(binds.some((b) => b.value === 120000)).toBe(false);
  });
});

describe('bindKeyValueTable (long / metric,value tables)', () => {
  it('binds scalars from a metric,value CSV (label in column 0, value in column 1)', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'topology.csv',
      headers: ['metric', 'value'],
      rows: [
        ['shards', '3'],
        ['cores per node', '32'],
        ['dr cores', '16'],
      ],
    };
    const binds = bindKeyValueTable(t, schema);
    expect(binds.find((b) => b.signalId === 'cluster.shardCount')?.value).toBe(3);
    expect(binds.find((b) => b.signalId === 'node.hoVcpu')?.value).toBe(32);
    expect(binds.find((b) => b.signalId === 'node.drVcpu')?.value).toBe(16);
  });

  it('does not touch timestamped series tables (left to bindNumericSeries)', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'metrics.csv',
      headers: ['timestamp', 'System CPU'],
      rows: [['2026-01-01T00:00Z', '40'], ['2026-01-01T01:00Z', '60']],
    };
    expect(bindKeyValueTable(t, schema)).toEqual([]);
  });
});

describe('bindNumericSeries (role disambiguation + percent scaling)', () => {
  it('binds primary and secondary CPU series to different util signals — never both to primary', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'metrics.csv',
      headers: ['timestamp', 'System CPU', 'Secondary CPU'],
      rows: [
        ['2026-01-01T00:00Z', '18', '12'],
        ['2026-01-01T01:00Z', '45', '35'],
      ],
    };
    const binds = bindNumericSeries(t, schema);
    const ids = binds.map((b) => b.signalId).sort();
    expect(ids).toEqual(['util.hoSec', 'util.primary']);
    const primary = binds.find((b) => b.signalId === 'util.primary')!;
    expect(primary.method).toBe('numeric-series');
    // percent-scaled (max 45 > 1.5) => divided by 100
    expect((primary.value as { avgPct: number; peakPct: number }).peakPct).toBeCloseTo(0.45, 10);
  });

  it('drops negative glitch samples before computing util stats', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'metrics.csv',
      headers: ['timestamp', 'System CPU'],
      rows: [
        ['2026-01-01T00:00Z', '-10'],
        ['2026-01-01T01:00Z', '50'],
      ],
    };
    const b = bindNumericSeries(t, schema).find((x) => x.signalId === 'util.primary')!;
    // -10 is dropped, so the series is just [50] -> 0.50/0.50, not a corrupted 0.20 average
    expect(b.value).toEqual({ avgPct: 0.5, peakPct: 0.5 });
  });

  it('binds a duplicated metric column only once, from the first occurrence', () => {
    const t: TablePrimitive = {
      kind: 'table',
      source: 'metrics.csv',
      headers: ['timestamp', 'System CPU', 'System CPU'],
      rows: [
        ['2026-01-01T00:00Z', '4', '90'],
        ['2026-01-01T01:00Z', '5', '90'],
        ['2026-01-01T02:00Z', '45', '90'],
      ],
    };
    const primary = bindNumericSeries(t, schema).filter((x) => x.signalId === 'util.primary');
    expect(primary).toHaveLength(1);
    expect((primary[0]!.value as { avgPct: number; peakPct: number }).peakPct).toBeCloseTo(0.45, 10); // first column wins
  });
});

describe('isNoise', () => {
  it('flags empty tables and signature footers, not real evidence', () => {
    const empty: TablePrimitive = { kind: 'table', source: 'x', headers: [], rows: [] };
    const sig: TextPrimitive = { kind: 'text', source: 'sig', text: 'Sincerely,\nJane Doe\nSent from my iPhone' };
    const cpu: TablePrimitive = {
      kind: 'table',
      source: 'cpu.csv',
      headers: ['timestamp', 'System CPU %'],
      rows: [['2026-01-01T00:00Z', '18']],
    };
    expect(isNoise(empty)).toBe(true);
    expect(isNoise(sig)).toBe(true);
    expect(isNoise(cpu)).toBe(false);
  });
});
