// No-LLM binding rules — structural/lexical heuristics, pure functions over (Primitive, schema).
// These run FIRST; only what they cannot resolve escalates to the LLM seam (llm.ts). Aliases are
// matched as tokens found WITHIN a header/key (text.includes(alias)), longest-alias wins — so a
// role-qualified header ('Secondary CPU') beats the generic one ('System CPU' -> primary).

import type { Primitive, TablePrimitive, KeyValuePrimitive } from '../ingest/types';
import type { SignalSchema, SignalSpec } from '../profile/types';
import type { BindingResult, EvidenceRef } from './types';
import { parseNumericColumn, seriesStats, isTimestampColumn, detectPercentScale, asUtilFraction } from './stats';

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Resolve a header/key to a signal by the longest alias that appears within it; null if none. */
export function matchSignalByAlias(text: string, schema: SignalSchema): SignalSpec | null {
  const t = norm(text);
  let best: SignalSpec | null = null;
  let bestLen = 0;
  for (const sig of schema.signals) {
    for (const alias of sig.aliases) {
      if (t.includes(alias) && alias.length > bestLen) {
        best = sig;
        bestLen = alias.length;
      }
    }
  }
  return best;
}

export type RoleToken = 'primary' | 'secondary' | 'dr';

/** Detect a replica-role token in a header/source string. */
export function roleTokenOf(text: string): RoleToken | null {
  const t = norm(text);
  if (/\b(dr|disaster|standby|recovery)\b/.test(t)) return 'dr';
  if (/\b(secondary|analytics|electable|replica)\b/.test(t)) return 'secondary';
  if (/\bprimary\b/.test(t)) return 'primary';
  return null;
}

function column(t: TablePrimitive, i: number): string[] {
  return t.rows.map((r) => r[i] ?? '');
}

function isCurrencyColumn(header: string, values: string[]): boolean {
  if (/\$|cost|price|usd|amount/i.test(header)) return true;
  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (nonEmpty.length === 0) return false;
  const dollarish = nonEmpty.filter((v) => /^\s*\$/.test(v)).length;
  return dollarish / nonEmpty.length >= 0.5;
}

/** Label a table for the inventory: metric-time-series / cost-model / data-table / noise. */
export function classifyTable(t: TablePrimitive): { role: string } {
  if (t.rows.length === 0 || t.headers.length === 0) return { role: 'noise' };
  const timeIdx = t.headers.findIndex((_, i) => isTimestampColumn(column(t, i)));
  if (timeIdx >= 0) {
    const hasValueCol = t.headers.some((_, i) => i !== timeIdx && parseNumericColumn(column(t, i)).length > 0);
    if (hasValueCol) return { role: 'metric-time-series' };
  }
  const hasCurrency = t.headers.some((h, i) => isCurrencyColumn(h, column(t, i)));
  if (hasCurrency) return { role: 'cost-model' };
  return { role: 'data-table' };
}

const ref = (source: string, kind: Primitive['kind'], locator: string): EvidenceRef => ({ source, primitiveKind: kind, locator });

/** Bind exact scalar/enum values from key-value pairs (method 'keyvalue', exact -> cap 1.0). */
export function bindKeyValue(kv: KeyValuePrimitive, schema: SignalSchema): BindingResult[] {
  const out: BindingResult[] = [];
  for (const [k, v] of Object.entries(kv.pairs)) {
    const sig = matchSignalByAlias(k, schema);
    if (!sig) continue;
    if (sig.valueKind === 'scalar') {
      const nums = parseNumericColumn([v]);
      if (nums.length === 0) continue;
      out.push({ signalId: sig.id, value: nums[0]!, confidence: 1, method: 'keyvalue', evidence: [ref(kv.source, 'keyvalue', k)] });
    } else if (sig.valueKind === 'enum') {
      const val = v.trim();
      if (val.length === 0) continue;
      out.push({ signalId: sig.id, value: val, confidence: 0.9, method: 'keyvalue', evidence: [ref(kv.source, 'keyvalue', k)] });
    }
    // avgPeak can't come from a single key-value — skip.
  }
  return out;
}

/** Bind scalar/enum signals from a non-series table column, ignoring currency columns. */
export function bindTableScalars(t: TablePrimitive, schema: SignalSchema): BindingResult[] {
  const timeIdx = t.headers.findIndex((_, i) => isTimestampColumn(column(t, i)));
  if (timeIdx >= 0) return []; // series tables are handled by bindNumericSeries
  const out: BindingResult[] = [];
  t.headers.forEach((h, i) => {
    const vals = column(t, i);
    if (isCurrencyColumn(h, vals)) return; // ignored for sizing
    const sig = matchSignalByAlias(h, schema);
    if (!sig) return;
    if (sig.valueKind === 'scalar') {
      const nums = parseNumericColumn(vals);
      if (nums.length === 0) return;
      out.push({ signalId: sig.id, value: nums[0]!, confidence: 0.95, method: 'table-lookup', evidence: [ref(t.source, 'table', h)] });
    } else if (sig.valueKind === 'enum') {
      const first = vals.find((v) => v.trim().length > 0);
      if (!first) return;
      out.push({ signalId: sig.id, value: first.trim(), confidence: 0.9, method: 'table-lookup', evidence: [ref(t.source, 'table', h)] });
    }
  });
  return out;
}

/**
 * Bind scalars/enums from a LONG (key/value) table — the first column is the label and a later
 * column holds the value (e.g. a `metric,value` CSV). Complements bindTableScalars, which handles
 * the WIDE shape (signal alias in the header). Series tables are left to bindNumericSeries.
 */
export function bindKeyValueTable(t: TablePrimitive, schema: SignalSchema): BindingResult[] {
  const timeIdx = t.headers.findIndex((_, i) => isTimestampColumn(column(t, i)));
  if (timeIdx >= 0 || t.headers.length < 2) return [];
  const out: BindingResult[] = [];
  for (const row of t.rows) {
    const label = row[0] ?? '';
    const sig = matchSignalByAlias(label, schema);
    if (!sig) continue;
    const rest = row.slice(1);
    if (sig.valueKind === 'scalar') {
      const nums = parseNumericColumn(rest);
      if (nums.length === 0) continue;
      out.push({ signalId: sig.id, value: nums[0]!, confidence: 0.95, method: 'table-lookup', evidence: [ref(t.source, 'table', label)] });
    } else if (sig.valueKind === 'enum') {
      const val = rest.find((v) => v.trim().length > 0);
      if (!val) continue;
      out.push({ signalId: sig.id, value: val.trim(), confidence: 0.9, method: 'table-lookup', evidence: [ref(t.source, 'table', label)] });
    }
  }
  return out;
}

/** Bind avgPeak signals (util/iops/ops/concurrency) from a timestamped series. One binding per signal. */
export function bindNumericSeries(t: TablePrimitive, schema: SignalSchema): BindingResult[] {
  const timeIdx = t.headers.findIndex((_, i) => isTimestampColumn(column(t, i)));
  if (timeIdx < 0) return [];
  const out: BindingResult[] = [];
  const bound = new Set<string>();
  t.headers.forEach((h, i) => {
    if (i === timeIdx) return;
    const sig = matchSignalByAlias(h, schema);
    if (!sig || sig.valueKind !== 'avgPeak') return;
    if (bound.has(sig.id)) return; // a same-signal duplicate column is ambiguous — leave for the LLM role-labeler
    const nums = parseNumericColumn(column(t, i)).filter((n) => n >= 0); // drop negative glitch samples — util/iops/ops are non-negative
    if (nums.length === 0) return;
    const stats = seriesStats(nums);
    const value = sig.id.startsWith('util.')
      ? asUtilFraction(stats, detectPercentScale(h, nums))
      : { avgPct: stats.avg, peakPct: stats.peak }; // iops/ops/concurrency: raw avg & peak
    out.push({ signalId: sig.id, value, confidence: 0.95, method: 'numeric-series', evidence: [ref(t.source, 'table', h)] });
    bound.add(sig.id);
  });
  return out;
}

/** True when a primitive is noise to be inventoried-but-ignored (empty tables, signatures/footers, blanks). */
export function isNoise(p: Primitive): boolean {
  if (p.kind === 'table') return p.rows.length === 0 || p.headers.length === 0;
  if (p.kind === 'text') {
    const t = p.text.trim();
    if (t.length === 0) return true;
    return /^(--\s*$|regards|sincerely|best regards|thanks|thank you|sent from my|confidential|this email|disclaimer)/i.test(t);
  }
  return false;
}
