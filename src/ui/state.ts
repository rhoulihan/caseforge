// The shared wizard state + pure navigation logic. State is a plain data type; step-advance
// validity is a pure function (unit-tested without a DOM). The API key is NOT stored here — it
// lives in session memory only (set in Setup), so this carries just a `hasApiKey` flag.

import type { EvidenceBundle } from '../ingest/types';
import type { TcoInputs } from '../engine/types';
import type { MapEntry } from '../anon/mapping';
import type { DetectedPhrase } from '../anon/detect';
import type { TriageResult } from '../classify/types';
import type { GateAnswer } from '../orchestrate/gate';
import type { PipelineOutput } from '../orchestrate';

export type WizardStepId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Provider = 'claude' | 'openai';

export interface WizardConfig {
  provider: Provider;
  companyName: string;
  tokenBudget: number;
  discountPct: number; // customer discount on the proposed solution (0–100, default 0)
}

export interface WizardState {
  step: WizardStepId;
  // 1 · Setup (apiKey held in session memory, not here)
  config: WizardConfig | null;
  hasApiKey: boolean;
  // 2 · Drop files
  bundle: EvidenceBundle | null;
  // 3 · Anonymize
  detected: DetectedPhrase[];
  map: MapEntry[];
  anonBundle: EvidenceBundle | null; // bundle with text primitives replaced by slugs (what triage/LLM sees)
  imagesScanned: boolean; // images OCR'd + their text folded into the candidate list (or none present)
  imagesReviewed: boolean; // images OCR-redacted + reviewed by the rep (or none present)
  // 4 · Confirm
  triage: TriageResult | null;
  gateAnswers: GateAnswer[];
  confirmed: boolean;
  // 5 · Generate
  tcoInputs: TcoInputs | null; // the cost inputs used to generate (persisted so Refine can recompute)
  pipeline: PipelineOutput | null;
  // 6 · Refine
  previewReady: boolean;
}

export const STEPS: { id: WizardStepId; key: string; title: string }[] = [
  { id: 1, key: 'setup', title: 'Setup' },
  { id: 2, key: 'files', title: 'Drop files' },
  { id: 3, key: 'anonymize', title: 'Anonymize' },
  { id: 4, key: 'confirm', title: 'Confirm' },
  { id: 5, key: 'generate', title: 'Generate' },
  { id: 6, key: 'refine', title: 'Refine' },
  { id: 7, key: 'export', title: 'Export' },
];

export function initialWizardState(): WizardState {
  return {
    step: 1,
    config: null,
    hasApiKey: false,
    bundle: null,
    detected: [],
    map: [],
    anonBundle: null,
    imagesScanned: false,
    imagesReviewed: false,
    triage: null,
    gateAnswers: [],
    confirmed: false,
    tcoInputs: null,
    pipeline: null,
    previewReady: false,
  };
}

/** Whether each step is satisfied enough to advance FROM it. Pure — drives stepper + Next gating. */
export function stepValidity(s: WizardState): Record<WizardStepId, boolean> {
  const setupOk = !!s.config && s.hasApiKey && s.config.companyName.trim().length > 0;
  const filesOk = !!s.bundle && s.bundle.primitives.length > 0;
  // Images must be OCR-redacted + reviewed before they can reach vision (or there are none).
  const anonHasImages = !!s.anonBundle?.primitives.some((p) => p.kind === 'image');
  const anonOk = !!s.anonBundle && (!anonHasImages || s.imagesReviewed);
  return {
    1: setupOk,
    2: setupOk && filesOk,
    3: setupOk && filesOk && anonOk,
    4: setupOk && filesOk && anonOk && s.confirmed,
    5: !!s.pipeline?.docModel,
    6: !!s.pipeline?.docModel, // refine is optional once generated
    7: true, // terminal
  };
}

/** The highest step the user may navigate to: prior steps must all be advance-valid. */
export function maxReachableStep(s: WizardState): WizardStepId {
  const v = stepValidity(s);
  let reachable: WizardStepId = 1;
  for (const { id } of STEPS) {
    if (id === 1 || v[(id - 1) as WizardStepId]) reachable = id;
    else break;
  }
  return reachable;
}
