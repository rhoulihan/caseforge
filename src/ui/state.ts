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
import type { DocModel, RenderedDoc } from '../render/types';

export type WizardStepId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Provider = 'claude' | 'openai';

/** One generated content package — every generate/refine appends one; never overwritten (archive versioning). */
export interface ArchiveVersion {
  id: string; // zero-padded sequence, e.g. '001'
  createdAt: string; // ISO 8601
  trigger: 'initial' | 'refine' | 'add-files';
  discountPct: number;
  docModel: DocModel;
  rendered: RenderedDoc[];
}

/** One refinement the rep applied — the raw text (local) + the slug-anonymized form actually sent to the LLM. */
export interface RefinementEntry {
  ts: string; // ISO 8601
  instruction: string; // raw text the rep typed (local only)
  slugged: string; // anonymized form sent to the LLM
  versionId: string; // the version this refinement produced
}

export interface WizardConfig {
  provider: Provider;
  companyName: string;
  tokenBudget: number;
  discountPct: number; // customer discount on the proposed solution (0–100, default 0)
}

export interface WizardState {
  step: WizardStepId;
  // Archive identity — null for a new (unsaved) case; set on first save / when opened from an archive.
  caseId: string | null;
  caseCreatedAt: string | null; // original archive creation time, preserved across re-saves (null = new)
  // 1 · Setup (apiKey held in session memory, not here)
  config: WizardConfig | null;
  hasApiKey: boolean;
  // 2 · Drop files
  bundle: EvidenceBundle | null;
  rawFiles: { name: string; bytes: Uint8Array }[]; // the original uploaded files (for the archive's sources/)
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
  // 6 · Refine — content-package history + the refinement log (archive versioning / continuity)
  versions: ArchiveVersion[]; // every generate/refine appends one; the last is the current (= pipeline)
  refinementHistory: RefinementEntry[];
  previewReady: boolean;
  // Transient add-files navigation (NOT serialized): set when returning Step 6 → Step 2 to add files.
  addFilesMode?: boolean;
  pendingRefinement?: string; // the instruction the rep had typed in Step 6, applied at the add-files generate
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
    caseId: null,
    caseCreatedAt: null,
    config: null,
    hasApiKey: false,
    bundle: null,
    rawFiles: [],
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
    versions: [],
    refinementHistory: [],
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
