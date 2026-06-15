// The assumptions gate (spec §8.5) — data-model + apply-answers (no UI; that is Plan 10). A rep
// answer becomes a binding: every gate answer is a rep-entered override bound as method 'manual'
// (confidence 1.0) with evidence source 'rep-gate-answer'. After merging, the SufficiencyReport is
// RE-RUN so the verdict tier reflects the updated bindings — and under Policy B any rep-entered
// gate answer (rep-gate-answer evidence) demotes the verdict to directional.

import type { SourceProfile, SignalValueKind, Criticality, DerivationMethod } from '../profile/types';
import type { SufficiencyReport, SignalCoverageItem } from '../classify/sufficiency-types';
import type { TriageResult, BindingResult, SignalValue } from '../classify/types';
import type { FileReport } from '../ingest/types';
import type { SizingInputs, StorageBasis } from '../engine/types';
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
  value: SignalValue; // a rep-entered value (a fill or an override); always demotes the tier (Policy B)
}

export interface ApplyResult {
  triage: TriageResult;
  sufficiency: SufficiencyReport;
  inputs?: SizingInputs;
  dataCompressedGb?: number;
  storageBasis?: StorageBasis;
  blocked: boolean;
  reasons: string[];
}

/** Gate items = required signals that are missing, or partial below the engineering floor.
 *  The Step-4 UI renders buildMetricsForm instead; this remains the headless pipeline's
 *  post-answer gap report (PipelineOutput.gate — see runPipeline). */
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
    method: 'manual', // trust 7 -> wins mergeBindings over any artifact-read value
    evidence: [{ source: 'rep-gate-answer', primitiveKind: 'keyvalue' }],
    note: 'rep-entered at the gate',
  }));

  const bySignal = new Map<string, BindingResult[]>();
  for (const b of [...triage.bindings, ...newBindings]) {
    const list = bySignal.get(b.signalId);
    if (list) list.push(b);
    else bySignal.set(b.signalId, [b]);
  }
  const merged = [...bySignal.values()].map(mergeBindings);
  const newTriage: TriageResult = { ...triage, bindings: merged };
  // Re-run sufficiency so the verdict tier reflects the merged bindings (incl. any rep-entered evidence from this call).
  const sufficiency = buildSufficiencyReport(newTriage, files, profile);
  const { inputs, dataCompressedGb, storageBasis, missing } = toSizingInputs(merged, profile);
  if (missing.length > 0) {
    return { triage: newTriage, sufficiency, blocked: true, reasons: missing.map((id) => `${id} still missing`) };
  }
  return { triage: newTriage, sufficiency, inputs, dataCompressedGb, storageBasis, blocked: false, reasons: [] };
}

export interface MetricRow {
  signalId: string;
  label: string;
  valueKind: SignalValueKind; // 'scalar' | 'avgPeak' | 'enum'
  criticality: Criticality;
  value: SignalValue | null;
  method: DerivationMethod | null;
  status: SignalCoverageItem['status'];
  effectiveConfidence: number;
  repEntered: boolean;
  collectRequest: string;
  collectWhy: string;
}

export interface MetricsForm {
  required: MetricRow[];
  additional: MetricRow[];
}

/** One editable row per signal for the Step-4 metrics table: every REQUIRED signal, plus the
 *  recommended set as "Additional Metrics" (tcoCritical cost drivers first). The storage compression
 *  companion renders inline on the storage row, never as its own row. */
export function buildMetricsForm(sufficiency: SufficiencyReport, profile: SourceProfile): MetricsForm {
  const specById = new Map(profile.signalSchema.signals.map((s) => [s.id, s]));
  const row = (c: SignalCoverageItem): MetricRow => {
    const spec = specById.get(c.signalId)!;
    return {
      signalId: c.signalId,
      label: c.label,
      valueKind: spec.valueKind,
      criticality: c.criticality,
      value: c.value,
      method: c.method,
      status: c.status,
      effectiveConfidence: c.effectiveConfidence,
      repEntered: c.repEntered,
      collectRequest: spec.collectRequest,
      collectWhy: spec.collectWhy,
    };
  };
  const COMPANION = 'data.storageCompressionState'; // rendered inline on the storage row (see Step4Confirm)
  const required = sufficiency.coverage.filter((c) => c.criticality === 'required').map(row);
  const additional = sufficiency.coverage
    .filter((c) => c.criticality === 'recommended' && c.signalId !== COMPANION)
    .map(row)
    .sort((a, b) =>
      Number(!!specById.get(b.signalId)?.tcoCritical) - Number(!!specById.get(a.signalId)?.tcoCritical) ||
      a.label.localeCompare(b.label));
  return { required, additional };
}
