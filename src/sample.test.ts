// Validates the bundled demo fixture (samples/northwind-demo) end-to-end through ingest + detect,
// so a reader who tries the sample gets the documented behavior (and the sample can't silently rot).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ingestAsync } from './ingest/ingest';
import { BINARY_EXTRACTORS } from './ingest/binary';
import { detectCandidates } from './anon/detect';
import { triage } from './classify/triage';
import { buildSufficiencyReport } from './classify/sufficiency';
import { MONGODB_PROFILE } from './profile/mongodb';
import type { TablePrimitive } from './ingest/types';

function load(name: string): { name: string; bytes: Uint8Array } {
  const path = fileURLToPath(new URL(`../samples/northwind-demo/${name}`, import.meta.url));
  return { name, bytes: new Uint8Array(readFileSync(path)) };
}

describe('northwind-demo sample fixture', () => {
  it('ingests the CSVs to tables and the email to text', async () => {
    const bundle = await ingestAsync([load('topology.csv'), load('cpu-utilization.csv'), load('customer-email.txt')], BINARY_EXTRACTORS);
    expect(bundle.files.every((f) => f.ok)).toBe(true);
    const tables = bundle.primitives.filter((p): p is TablePrimitive => p.kind === 'table');
    expect(tables).toHaveLength(2);
    expect(bundle.primitives.some((p) => p.kind === 'text')).toBe(true);
    const topo = tables.find((t) => t.source.includes('topology'))!;
    expect(topo.rows.some((r) => r[0] === 'shards' && r[1] === '3')).toBe(true);
  });

  it('detects the sensitive phrases the demo is meant to exercise', async () => {
    const bundle = await ingestAsync([load('customer-email.txt'), load('topology.csv')], BINARY_EXTRACTORS);
    const found = detectCandidates(bundle, 'Northwind Mutual Insurance');
    const has = (p: string): boolean => found.some((d) => d.phrase.toLowerCase() === p.toLowerCase());
    expect(found.find((d) => d.phrase === 'Northwind Mutual Insurance')?.type).toBe('org');
    expect(has('Jane Okafor')).toBe(true);
    expect(has('jane.okafor@northwind.com')).toBe(true);
    expect(has('10.20.30.40')).toBe(true);
    expect(has('db-prod-01.nw.local')).toBe(true);
  });

  it('binds the required sizing signals from the metric/value topology + utilization (not blocked)', async () => {
    // Reproduces the rep flow: the long-format topology.csv must bind shards/vCPU (heuristics, no LLM).
    const bundle = await ingestAsync([load('topology.csv'), load('cpu-utilization.csv'), load('customer-email.txt')], BINARY_EXTRACTORS);
    const { result } = await triage(bundle, MONGODB_PROFILE);
    const report = buildSufficiencyReport(result, bundle.files, MONGODB_PROFILE);
    const value = (id: string): unknown => report.coverage.find((c) => c.signalId === id)?.value;
    expect(value('cluster.shardCount')).toBe(3);
    expect(value('node.hoVcpu')).toBe(32);
    expect(value('node.drVcpu')).toBe(16);
    expect(report.verdict.tier).not.toBe('blocked');
  });
});
