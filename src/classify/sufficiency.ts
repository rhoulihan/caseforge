// The Data Intake & Sufficiency Report (spec §7, drives the §8.5 gate) — 100% pure arithmetic
// over the TriageResult classify produced + the file list. No LLM, no randomness, no Date.now:
// same input -> same report (mirrors src/engine/sizing + src/anon/mapping). Confidence is method-
// capped HERE (the cap policy lives on the profile), so vision-read util can never be called
// engineering-grade and a defaulted required signal can never masquerade as a measurement.

import type { SourceProfile, SignalSpec } from '../profile/types';
import type { FileReport } from '../ingest/types';
import type { BindingResult, TriageResult } from './types';
import type {
  SufficiencyReport,
  InventoryItem,
  SignalCoverageItem,
  OutputQualityVerdict,
  WhatToCollectItem,
  ResultTier,
} from './sufficiency-types';

function buildInventory(files: FileReport[], bindings: BindingResult[]): InventoryItem[] {
  const boundBySource = new Map<string, string[]>();
  for (const b of bindings) {
    for (const e of b.evidence) {
      const list = boundBySource.get(e.source) ?? [];
      if (!list.includes(b.signalId)) list.push(b.signalId);
      boundBySource.set(e.source, list);
    }
  }
  return files.map((f) => {
    const bound = boundBySource.get(f.name) ?? [];
    const role: InventoryItem['role'] = bound.length > 0 ? 'evidence' : f.ok ? 'noise' : 'unrecognized';
    return { name: f.name, detectedType: f.type, role, boundSignals: bound, note: f.note };
  });
}

function buildCoverage(profile: SourceProfile, bindings: BindingResult[]): SignalCoverageItem[] {
  const { methodCap, missingFloor, engFloor } = profile.thresholds;
  const by = new Map(bindings.map((b) => [b.signalId, b]));
  // Left-join over the SCHEMA so a never-attempted signal still produces a 'missing' row.
  return profile.signalSchema.signals.map((spec) => {
    const b = by.get(spec.id);
    const cap = b ? methodCap[b.method] : 0;
    const eff = b && b.value !== undefined ? Math.min(b.confidence, cap) : 0;
    let status: SignalCoverageItem['status'];
    if (!b || b.value === undefined || eff < missingFloor) status = 'missing';
    else if (eff >= engFloor) status = 'satisfied';
    else status = 'partial';
    let reason: string;
    if (!b || b.value === undefined) reason = 'no evidence found';
    else if (status === 'satisfied') reason = `${b.method} (confidence ${eff.toFixed(2)})`;
    else if (status === 'partial') reason = `${b.method} (confidence ${eff.toFixed(2)}) below the ${engFloor} engineering bar`;
    else reason = `effective confidence ${eff.toFixed(2)} below the ${missingFloor} floor`;
    return {
      signalId: spec.id,
      label: spec.label,
      criticality: spec.criticality,
      status,
      effectiveConfidence: eff,
      method: b?.method ?? null,
      value: b?.value ?? null,
      evidence: b?.evidence ?? [],
      reason,
    };
  });
}

function computeVerdict(
  coverage: SignalCoverageItem[],
  specById: Map<string, SignalSpec>,
  profile: SourceProfile,
): OutputQualityVerdict {
  const { engFloor, engMean } = profile.thresholds;
  const req = coverage.filter((c) => c.criticality === 'required');
  const missing = req.filter((c) => c.status === 'missing');
  const partial = req.filter((c) => c.status === 'partial');
  const satisfied = req.filter((c) => c.status === 'satisfied');
  const mean = req.length ? req.reduce((a, c) => a + c.effectiveConfidence, 0) / req.length : 0;
  const hasAssumed = req.some((c) => c.method === 'assumption-default');

  let tier: ResultTier;
  if (missing.length > 0) tier = 'blocked';
  else if (partial.length === 0 && req.every((c) => c.effectiveConfidence >= engFloor) && mean >= engMean && !hasAssumed)
    tier = 'engineering-grade';
  else tier = 'directional-estimate';

  const limiting = (tier === 'blocked' ? missing : req.filter((c) => c.effectiveConfidence < engFloor)).map((c) => c.signalId);
  const labelOf = (id: string) => specById.get(id)?.label ?? id;
  const first2 = limiting.slice(0, 2).map(labelOf).join(', ');

  let headline: string;
  if (tier === 'blocked') headline = `Blocked — ${missing.length} required signal(s) missing${first2 ? ': ' + first2 : ''}`;
  else if (tier === 'engineering-grade') headline = 'Engineering-grade — all required signals satisfied';
  else headline = `Directional estimate — collect ${first2} to reach an engineering-grade number`;

  let rationale = `${satisfied.length}/${req.length} required signals satisfied (mean confidence ${mean.toFixed(2)}).`;
  if (tier === 'directional-estimate' && limiting.length) rationale += ` Limited by: ${limiting.map(labelOf).join(', ')}.`;
  const missingTco = coverage.filter(
    (c) => c.criticality !== 'required' && specById.get(c.signalId)?.tcoCritical && c.status !== 'satisfied',
  );
  if (missingTco.length)
    rationale += ` Note: ${missingTco.map((c) => labelOf(c.signalId)).join(', ')} (a dominant cost driver) ${missingTco.length > 1 ? 'are' : 'is'} not yet evidenced — the cost case is not defensible until provided.`;

  return {
    tier,
    headline,
    requiredTotal: req.length,
    requiredSatisfied: satisfied.length,
    requiredPartial: partial.length,
    requiredMissing: missing.length,
    meanRequiredConfidence: mean,
    limitingSignals: limiting,
    rationale,
  };
}

function buildWhatToCollect(coverage: SignalCoverageItem[], specById: Map<string, SignalSpec>): WhatToCollectItem[] {
  const items: WhatToCollectItem[] = [];
  for (const c of coverage) {
    const spec = specById.get(c.signalId)!;
    const isRequired = spec.criticality === 'required';
    const isTcoRecommended = !isRequired && spec.tcoCritical === true;
    if (!isRequired && !isTcoRecommended) continue; // recommended/optional don't ask in v1 unless they gate a cost line
    if (c.status === 'satisfied') continue;
    const severity: WhatToCollectItem['severity'] = c.status === 'missing' && isRequired ? 'blocking' : 'upgrade';
    items.push({
      signalId: c.signalId,
      criticality: spec.criticality,
      severity,
      request: spec.collectRequest,
      why: spec.collectWhy,
      currentState: c.status === 'missing' ? 'missing' : 'low-confidence',
    });
  }
  const effOf = (id: string) => coverage.find((c) => c.signalId === id)!.effectiveConfidence;
  const sevRank = (s: WhatToCollectItem['severity']) => (s === 'blocking' ? 0 : 1);
  items.sort(
    (a, b) =>
      sevRank(a.severity) - sevRank(b.severity) ||
      effOf(a.signalId) - effOf(b.signalId) ||
      a.signalId.localeCompare(b.signalId),
  );
  return items;
}

/** Build the full Data Intake & Sufficiency Report from a triage result + the file list. Pure. */
export function buildSufficiencyReport(
  triage: TriageResult,
  files: FileReport[],
  profile: SourceProfile,
): SufficiencyReport {
  const specById = new Map(profile.signalSchema.signals.map((s) => [s.id, s]));
  const coverage = buildCoverage(profile, triage.bindings);
  return {
    profileId: profile.id,
    inventory: buildInventory(files, triage.bindings),
    coverage,
    verdict: computeVerdict(coverage, specById, profile),
    whatToCollect: buildWhatToCollect(coverage, specById),
  };
}
