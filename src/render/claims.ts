// Pure claims->evidence generator. A sizing claim's confidence is DERIVED from its backing
// signals' SufficiencyReport coverage (never fabricated); a cost/research claim carries an
// explicit declared source + confidence (downgraded one tier if it is a rolled-up figure).

import type { DocModel, ClaimInput } from './types';
import type { SignalCoverageItem } from '../classify/sufficiency-types';
import { claimConfidenceFromSignals, type ClaimConfidence } from '../classify/confidence';

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
