// The classify orchestrator (spec §7): heuristics first; escalate ONLY the unresolved
// (images -> readArtifactImage, text/ambiguous prose -> classifyText) to the injected LLM; merge to one
// binding per signal by deterministic trust-rank. Deterministic given a deterministic LLM (omit llm = the
// no-LLM core path). Also mines qualitative deliverable context alongside signals, synthesizes vCPU from an
// Atlas tier (engine table-lookup — the LLM only reads the tier string), and returns the LLM token usage so
// the orchestrator can budget the classify stage. toSizingInputs assembles SizingInputs via engineSlot and
// NEVER invents — a missing required signal yields no inputs.

import type { EvidenceBundle } from '../ingest/types';
import type { SourceProfile, DerivationMethod } from '../profile/types';
import type { SizingInputs, RoleUtil } from '../engine/types';
import type { LLM, Usage } from '../provider';
import type { BindingResult, PrimitiveClassification, TriageResult } from './types';
import { classifyTable, bindNumericSeries, bindTableScalars, bindKeyValueTable, bindKeyValue, isNoise } from './heuristics';
import { readArtifactImage, classifyText } from './llm';
import { emptyQualContext, mergeQualContexts, type QualContext } from './qual-context';
import { tierToVcpu } from './tier-lookup';
import { expandEntries, orderedForward, type MapEntry } from '../anon/mapping';

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

/** A synchronous, in-TS literal replacer mirroring the Go launcher (longest-phrase-first over expanded
 *  variants). Used to re-anonymize image-derived qualitative text before it can reach the LLM/output —
 *  the launcher remains authoritative; this is the best-effort backstop for vision-lifted strings. */
function makeSlugger(map: MapEntry[]): (s: string) => string {
  const entries = orderedForward(expandEntries(map)).filter((e) => e.phrase.length > 0);
  return (text: string): string => {
    let out = text;
    for (const e of entries) out = out.split(e.phrase).join(e.slug);
    return out;
  };
}

const isAuthoritative = (m: DerivationMethod): boolean => m === 'keyvalue' || m === 'numeric-series' || m === 'table-lookup' || m === 'manual';

/**
 * If an Atlas tier was read (signal `node.atlasTier`), resolve it to a vCPU count via the engine table and
 * synthesize node.hoVcpu / node.drVcpu (method 'table-lookup'). The LLM only emitted the tier STRING — the
 * number is computed here, preserving the determinism boundary. Any HALLUCINATED vision scalar for those
 * slots is dropped so it can't survive the merge; an existing authoritative binding (keyvalue/series) is
 * left to win and no synthetic value is added. Returns the new candidate pool. Unknown tier -> no change
 * (the signal stays missing -> the gate asks for the vCPU).
 */
function applyTierSynthesis(candidates: BindingResult[]): BindingResult[] {
  // Pick the highest-trust tier reading (consistent with mergeBindings) so two disagreeing sources
  // (e.g. a vision M80 vs an llm-text M60) resolve to the same value the surviving binding will show.
  const tier = candidates
    .filter((c) => c.signalId === 'node.atlasTier')
    .sort((a, b) => TRUST[b.method] - TRUST[a.method] || b.confidence - a.confidence)[0];
  if (!tier || typeof tier.value !== 'string') return candidates;
  const vcpu = tierToVcpu(tier.value);
  if (vcpu === undefined) return candidates;
  // Drop hallucinated vision scalars for the slots we are about to fill authoritatively.
  const out = candidates.filter((c) => !((c.signalId === 'node.hoVcpu' || c.signalId === 'node.drVcpu') && c.method === 'vision'));
  const hasAuthoritative = (id: string): boolean => out.some((c) => c.signalId === id && isAuthoritative(c.method));
  if (!hasAuthoritative('node.hoVcpu')) {
    out.push({ signalId: 'node.hoVcpu', value: vcpu, confidence: 1, method: 'table-lookup', evidence: tier.evidence, note: 'derived from the Atlas tier via the vCPU lookup table' });
  }
  if (!hasAuthoritative('node.drVcpu')) {
    out.push({ signalId: 'node.drVcpu', value: vcpu, confidence: 1, method: 'table-lookup', evidence: tier.evidence, note: 'assumed same tier as the home region — verify at the gate if the DR tier differs' });
  }
  return out;
}

export async function triage(
  bundle: EvidenceBundle,
  profile: SourceProfile,
  llm?: LLM,
  model = 'claude-opus-4-8',
  anonMap?: MapEntry[],
): Promise<{ result: TriageResult; usage: Usage }> {
  const schema = profile.signalSchema;
  let candidates: BindingResult[] = [];
  const inventory: PrimitiveClassification[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let qualContext: QualContext = emptyQualContext();
  const slugger = anonMap && anonMap.length > 0 ? makeSlugger(anonMap) : undefined;
  const addUsage = (u: Usage): void => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  };

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
      if (llm) {
        const r = await classifyText(llm, p, schema, model);
        got.push(...r.bindings);
        addUsage(r.usage);
        qualContext = mergeQualContexts(qualContext, r.qualContext);
      }
    } else if (p.kind === 'image') {
      role = 'chart';
      if (llm) {
        const r = await readArtifactImage(llm, p, schema, model, slugger);
        got.push(...r.bindings);
        addUsage(r.usage);
        qualContext = mergeQualContexts(qualContext, r.qualContext);
      }
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

  // Atlas tier -> vCPU (deterministic, engine table). Must run over the full candidate pool.
  candidates = applyTierSynthesis(candidates);

  // Surface a warning when any CPU-util panel role was assigned by the load/positional heuristic (D1).
  const heuristicRoleCount = candidates.filter((c) => c.signalId.startsWith('util.') && /heuristic/i.test(c.note ?? '')).length;
  const roleWarning =
    heuristicRoleCount > 0
      ? `${heuristicRoleCount} CPU-utilization panel(s) had no role label — primary/HA/DR were assigned by load. Verify the node topology at the gate.`
      : undefined;

  const bySignal = new Map<string, BindingResult[]>();
  for (const c of candidates) {
    const list = bySignal.get(c.signalId);
    if (list) list.push(c);
    else bySignal.set(c.signalId, [c]);
  }
  const bindings = [...bySignal.values()].map(mergeBindings);
  const result: TriageResult = { profileId: profile.id, inventory, bindings, qualContext, ...(roleWarning ? { roleWarning } : {}) };
  return { result, usage };
}

/** Assemble SizingInputs from required-signal bindings via engineSlot. Never invents — missing required => no inputs. */
export function toSizingInputs(
  bindings: BindingResult[],
  profile: SourceProfile,
): { inputs?: SizingInputs; dataCompressedGb?: number; missing: string[] } {
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
  return { inputs, dataCompressedGb: num('data.storageSizeGb'), missing: [] };
}
