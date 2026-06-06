// The assumptions gate (spec §8.5) — data-model + apply-answers (no UI; that is Plan 10). A rep
// answer becomes a binding: a CONFIRMED measurement is method 'manual' (cap 1.0); an unconfirmed
// answer to unblock is 'assumption-default' (capped to 0.5 by sufficiency). After merging, the
// SufficiencyReport is RE-RUN so the verdict tier reflects assumptions — an assumption-default
// required signal can never be engineering-grade.

import type { SourceProfile } from '../profile/types';
import type { SufficiencyReport } from '../classify/sufficiency-types';
import type { TriageResult, BindingResult, SignalValue } from '../classify/types';
import type { FileReport } from '../ingest/types';
import type { SizingInputs } from '../engine/types';
import { mergeBindings, toSizingInputs } from '../classify/triage';
import { buildSufficiencyReport } from '../classify/sufficiency';

export interface GateItem {
  signalId: string;
  label: string;
  currentStatus: string;
  effectiveConfidence: number;
  collectRequest: string;
  collectWhy: string;
  defaultable: boolean;
}

export interface GateData {
  profileId: string;
  items: GateItem[];
  verdict: 'satisfied' | 'open';
}

export interface GateAnswer {
  signalId: string;
  value: SignalValue;
  confirmed: boolean; // true = rep attests a real measurement; false = an assumption to unblock
}

export interface ApplyResult {
  triage: TriageResult;
  sufficiency: SufficiencyReport;
  inputs?: SizingInputs;
  blocked: boolean;
  reasons: string[];
}

/** Gate items = required signals that are missing, or partial below the engineering floor. */
export function buildGateData(sufficiency: SufficiencyReport, profile: SourceProfile): GateData {
  const items: GateItem[] = [];
  for (const cov of sufficiency.coverage) {
    if (cov.criticality !== 'required') continue;
    if (cov.status === 'missing' || (cov.status === 'partial' && cov.effectiveConfidence < profile.thresholds.engFloor)) {
      const spec = profile.signalSchema.signals.find((s) => s.id === cov.signalId);
      items.push({
        signalId: cov.signalId,
        label: cov.label,
        currentStatus: cov.status,
        effectiveConfidence: cov.effectiveConfidence,
        collectRequest: spec?.collectRequest ?? '',
        collectWhy: spec?.collectWhy ?? '',
        defaultable: spec?.defaultable ?? true,
      });
    }
  }
  return { profileId: sufficiency.profileId, items, verdict: items.length === 0 ? 'satisfied' : 'open' };
}

export function applyGateAnswers(
  triage: TriageResult,
  answers: GateAnswer[],
  files: FileReport[],
  profile: SourceProfile,
): ApplyResult {
  const newBindings: BindingResult[] = answers.map((a) => ({
    signalId: a.signalId,
    value: a.value,
    confidence: 1,
    method: a.confirmed ? 'manual' : 'assumption-default',
    evidence: [{ source: 'rep-gate-answer', primitiveKind: 'keyvalue' }],
    note: a.confirmed ? 'rep-confirmed measurement' : 'assumption to unblock',
  }));

  const bySignal = new Map<string, BindingResult[]>();
  for (const b of [...triage.bindings, ...newBindings]) {
    const list = bySignal.get(b.signalId);
    if (list) list.push(b);
    else bySignal.set(b.signalId, [b]);
  }
  const merged = [...bySignal.values()].map(mergeBindings);
  const newTriage: TriageResult = { ...triage, bindings: merged };
  // Re-run sufficiency so the verdict tier reflects the merged bindings (incl. assumption-default caps).
  const sufficiency = buildSufficiencyReport(newTriage, files, profile);
  const { inputs, missing } = toSizingInputs(merged, profile);
  if (missing.length > 0) {
    return { triage: newTriage, sufficiency, blocked: true, reasons: missing.map((id) => `${id} still missing`) };
  }
  return { triage: newTriage, sufficiency, inputs, blocked: false, reasons: [] };
}
