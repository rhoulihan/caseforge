// The classify orchestrator (spec §7): heuristics first; escalate ONLY the unresolved
// (images -> vision, ambiguous prose -> llm-text) to the injected LLM; merge to one binding per
// signal by deterministic trust-rank. Deterministic given a deterministic LLM (omit llm = the
// no-LLM core path). toSizingInputs assembles the engine's SizingInputs via engineSlot, and NEVER
// invents a value — a missing required signal yields no inputs.

import type { EvidenceBundle } from '../ingest/types';
import type { SourceProfile, DerivationMethod } from '../profile/types';
import type { SizingInputs, RoleUtil } from '../engine/types';
import type { LLM } from '../provider';
import type { BindingResult, PrimitiveClassification, TriageResult } from './types';
import { classifyTable, bindNumericSeries, bindTableScalars, bindKeyValueTable, bindKeyValue, isNoise } from './heuristics';
import { readChartImage, classifyProse } from './llm';

// Higher = more trusted. manual = rep-confirmed measurement; assumption-default = a guess.
const TRUST: Record<DerivationMethod, number> = {
  manual: 7,
  'numeric-series': 6,
  keyvalue: 5,
  'table-lookup': 4,
  vision: 3,
  'llm-text': 2,
  heuristic: 1,
  'assumption-default': 0,
};

/** Pick one binding for a signal: highest trust-rank, tie-broken by raw confidence. */
export function mergeBindings(candidates: BindingResult[]): BindingResult {
  // Deterministic regardless of candidate input order: trust-rank, then confidence, then a content
  // tie-break (evidence source, then serialized value) so the same set always merges the same way.
  return [...candidates].sort(
    (a, b) =>
      TRUST[b.method] - TRUST[a.method] ||
      b.confidence - a.confidence ||
      (a.evidence[0]?.source ?? '').localeCompare(b.evidence[0]?.source ?? '') ||
      JSON.stringify(a.value).localeCompare(JSON.stringify(b.value)),
  )[0]!;
}

export async function triage(
  bundle: EvidenceBundle,
  profile: SourceProfile,
  llm?: LLM,
  model = 'claude-opus-4-8',
): Promise<TriageResult> {
  const schema = profile.signalSchema;
  const candidates: BindingResult[] = [];
  const inventory: PrimitiveClassification[] = [];

  for (const p of bundle.primitives) {
    if (isNoise(p)) {
      inventory.push({ source: p.source, kind: p.kind, role: 'noise', boundSignals: [], ignored: true });
      continue;
    }
    const got: BindingResult[] = [];
    let role = 'unknown';
    if (p.kind === 'table') {
      role = classifyTable(p).role;
      got.push(...bindNumericSeries(p, schema), ...bindTableScalars(p, schema), ...bindKeyValueTable(p, schema));
    } else if (p.kind === 'keyvalue') {
      role = 'topology';
      got.push(...bindKeyValue(p, schema));
    } else if (p.kind === 'text') {
      role = 'prose';
      if (llm) got.push(...(await classifyProse(llm, p, schema, model)));
    } else if (p.kind === 'image') {
      role = 'chart';
      if (llm) got.push(...(await readChartImage(llm, p, schema, model)));
    }
    candidates.push(...got);
    inventory.push({
      source: p.source,
      kind: p.kind,
      role,
      boundSignals: [...new Set(got.map((g) => g.signalId))],
      ignored: false,
    });
  }

  const bySignal = new Map<string, BindingResult[]>();
  for (const c of candidates) {
    const list = bySignal.get(c.signalId);
    if (list) list.push(c);
    else bySignal.set(c.signalId, [c]);
  }
  const bindings = [...bySignal.values()].map(mergeBindings);
  return { profileId: profile.id, inventory, bindings };
}

/** Assemble SizingInputs from required-signal bindings via engineSlot. Never invents — missing required => no inputs. */
export function toSizingInputs(
  bindings: BindingResult[],
  profile: SourceProfile,
): { inputs?: SizingInputs; missing: string[] } {
  const by = new Map(bindings.map((b) => [b.signalId, b]));
  const required = profile.signalSchema.signals.filter((s) => s.criticality === 'required');
  const missing = required.filter((s) => by.get(s.id)?.value === undefined).map((s) => s.id);
  if (missing.length > 0) return { missing };

  const num = (id: string): number => by.get(id)!.value as number;
  const ap = (id: string): RoleUtil => by.get(id)!.value as RoleUtil;
  const inputs: SizingInputs = {
    shards: num('cluster.shardCount'),
    hoVcpu: num('node.hoVcpu'),
    drVcpu: num('node.drVcpu'),
    util: { primary: ap('util.primary'), hoSec: ap('util.hoSec'), dr: ap('util.dr') },
  };
  return { inputs, missing: [] };
}
