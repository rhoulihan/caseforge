// Pure claims->evidence generator. A sizing claim's confidence is DERIVED from its backing
// signals' SufficiencyReport coverage (never fabricated); a cost/research claim carries an
// explicit declared source + confidence (downgraded one tier if it is a rolled-up figure).

import type { DocModel, ClaimInput, SizingBasis, SizingScenario, TcoSection } from './types';
import type { SignalCoverageItem } from '../classify/sufficiency-types';
import { claimConfidenceFromSignals, type ClaimConfidence } from '../classify/confidence';

const k = (n: number): string => `$${Math.round(n / 1000)}K`;
const apPct = (u: { avgPct: number; peakPct: number }): string => `${Math.round(u.avgPct * 100)}/${Math.round(u.peakPct * 100)}%`;

/**
 * Synthesize the authoritative sizing + TCO claims from the engine-computed numbers, so the claims→evidence
 * checklist always covers the headline figures even when the rep skipped cost research. Sizing claims carry
 * `dependsOnSignals` (confidence derived from the SufficiencyReport coverage); TCO totals carry a declared
 * source. These are MERGED with any caller-supplied (researched) cost claims in assembleDocModel, deduped by
 * id — so the set is stable across a refine round-trip (the regenerated sz-/tco- claims replace the prior ones).
 */
export function buildSizingClaims(m: { basis: SizingBasis; consumed: { peak: number }; scenarios: SizingScenario[]; tco: TcoSection }): ClaimInput[] {
  const { basis: b, consumed, scenarios, tco } = m;
  return [
    // Topology / sizing inputs — backed by the bound signals.
    { id: 'sz-shards', section: 'F', claim: 'Shard count (data-bearing replica sets)', value: b.shards, unit: 'shards', dependsOnSignals: ['cluster.shardCount'] },
    { id: 'sz-hovcpu', section: 'F', claim: 'vCPU per home-region data node', value: b.hoVcpu, unit: 'vCPU', dependsOnSignals: ['node.hoVcpu'] },
    { id: 'sz-drvcpu', section: 'F', claim: 'vCPU per DR-region data node', value: b.drVcpu, unit: 'vCPU', dependsOnSignals: ['node.drVcpu'] },
    { id: 'sz-util-primary', section: 'F', claim: 'System-CPU utilization — primary (avg/peak)', value: apPct(b.util.primary), unit: '%', dependsOnSignals: ['util.primary'] },
    { id: 'sz-util-hosec', section: 'F', claim: 'System-CPU utilization — HA secondary (avg/peak)', value: apPct(b.util.hoSec), unit: '%', dependsOnSignals: ['util.hoSec'] },
    { id: 'sz-util-dr', section: 'F', claim: 'System-CPU utilization — DR (avg/peak)', value: apPct(b.util.dr), unit: '%', dependsOnSignals: ['util.dr'] },
    // Compute sizing — derived from the inputs above.
    { id: 'sz-peak-ecpu', section: 'C', claim: 'Peak consumed compute (workload)', value: consumed.peak, unit: 'ECPU', derived: true, dependsOnSignals: ['util.primary', 'util.hoSec', 'util.dr', 'node.hoVcpu', 'cluster.shardCount'] },
    { id: 'sz-base-conservative', section: 'C', claim: 'Conservative provisioned base (Peak÷2)', value: scenarios[0]?.base ?? 0, unit: 'ECPU', derived: true, dependsOnSignals: ['util.primary', 'node.hoVcpu', 'cluster.shardCount'] },
    { id: 'sz-base-aggressive', section: 'C', claim: 'Aggressive provisioned base (Peak÷3)', value: scenarios[1]?.base ?? 0, unit: 'ECPU', derived: true, dependsOnSignals: ['util.primary', 'node.hoVcpu', 'cluster.shardCount'] },
    // TCO totals — engine-computed on the current-cost inputs.
    { id: 'tco-onprem', section: 'A', claim: 'Fully-loaded current (on-prem) cost', value: `${k(tco.onprem.total.central)}/yr`, unit: 'USD/yr', declaredSource: { label: 'Deterministic TCO model on the current-cost inputs', confidence: 'medium' } },
    { id: 'tco-adb-warm', section: 'A', claim: 'Oracle ADB + warm DR cost', value: `${k(tco.adbWarmAnnual.central)}/yr`, unit: 'USD/yr', declaredSource: { label: 'Oracle ADB rates (engine config)', confidence: 'high' } },
    { id: 'tco-adb-cold', section: 'A', claim: 'Oracle ADB + cold DR cost', value: `${k(tco.adbColdAnnual.central)}/yr`, unit: 'USD/yr', declaredSource: { label: 'Oracle ADB rates (engine config)', confidence: 'high' } },
    { id: 'tco-saving-warm', section: 'A', claim: 'Lower annual cost (warm DR)', value: `${tco.savingWarm.pct}%`, unit: '%', derived: true, declaredSource: { label: 'Derived: current − ADB warm', confidence: 'medium' } },
    { id: 'tco-net5-warm', section: 'A', claim: 'Five-year net saving (warm DR)', value: k(tco.fiveYear.net5Warm), unit: 'USD', derived: true, declaredSource: { label: 'Derived: 5-year streams', confidence: 'medium' } },
    { id: 'tco-payback', section: 'A', claim: 'Payback (warm DR)', value: tco.fiveYear.paybackYearWarm == null ? 'beyond 5 yrs' : `Year ${tco.fiveYear.paybackYearWarm}`, unit: 'year', derived: true, declaredSource: { label: 'Derived: cumulative 5-year streams', confidence: 'medium' } },
  ];
}

export interface ClaimRow {
  id: string;
  section: string;
  claim: string;
  value: string;
  unit: string;
  source: string;
  confidence: ClaimConfidence;
  derivation: string;
}

export interface ClaimsChecklist {
  companyName: string;
  verdictTier: string;
  rows: ClaimRow[];
  summary: { total: number; byConfidence: Record<ClaimConfidence, number>; lowestConfidence: string[] };
}

function downgrade(c: ClaimConfidence): ClaimConfidence {
  return c === 'high' ? 'medium' : 'low';
}

function resolve(ci: ClaimInput, byId: Map<string, SignalCoverageItem>): ClaimRow {
  let confidence: ClaimConfidence;
  let source: string;
  let derivation: string;
  if (ci.dependsOnSignals && ci.dependsOnSignals.length > 0) {
    const signals = ci.dependsOnSignals
      .map((id) => byId.get(id))
      .filter((c): c is SignalCoverageItem => c !== undefined);
    confidence = claimConfidenceFromSignals(signals, ci.derived ?? false);
    source = signals.map((s) => s.signalId).join(', ') || '(no coverage)';
    derivation = `Signal coverage: ${
      signals.map((s) => `${s.signalId} (${s.method ?? 'none'} ${s.effectiveConfidence.toFixed(2)})`).join('; ') || 'none found'
    }.`;
  } else if (ci.declaredSource) {
    confidence = ci.derived ? downgrade(ci.declaredSource.confidence) : ci.declaredSource.confidence;
    source = ci.declaredSource.label;
    derivation = `${ci.declaredSource.label}${ci.derived ? ' (rolled up — one tier lower)' : ''}.`;
  } else {
    confidence = 'low';
    source = '(unsourced)';
    derivation = 'No signal coverage or declared source.';
  }
  return { id: ci.id, section: ci.section, claim: ci.claim, value: String(ci.value), unit: ci.unit, source, confidence, derivation };
}

export function buildChecklist(docModel: DocModel): ClaimsChecklist {
  const byId = new Map(docModel.sufficiency.coverage.map((c) => [c.signalId, c]));
  const rows = docModel.claims.map((ci) => resolve(ci, byId));
  const byConfidence: Record<ClaimConfidence, number> = { high: 0, medium: 0, low: 0 };
  for (const r of rows) byConfidence[r.confidence]++;
  return {
    companyName: docModel.companyName,
    verdictTier: docModel.sufficiency.verdict.tier,
    rows,
    summary: { total: rows.length, byConfidence, lowestConfidence: rows.filter((r) => r.confidence !== 'high').map((r) => r.id) },
  };
}
