// The headless, stateless orchestrator: runPipeline(config) -> PipelineOutput. Sequences the
// proven pieces — triage → sufficiency/gate → size → generate prose (LLM) → assemble → render —
// accumulating cost in a budget. Determinism boundary holds: every authoritative number is
// engine-computed; the LLM only fills prose. Resumability/persistence/UI/anonymization are Plan 10.

import type { EvidenceBundle } from '../ingest/types';
import type { SourceProfile } from '../profile/types';
import type { TcoInputs } from '../engine/types';
import type { LLM, Usage } from '../provider';
import type { DocModel, RenderedDoc, ClaimInput } from '../render/types';
import { triage } from '../classify/triage';
import type { TriageResult } from '../classify/types';
import { buildGateData, applyGateAnswers, type GateAnswer, type GateItem } from './gate';
import { assembleDocModel, type EcpuStorageRates } from '../render/builders';
import { generateProse } from './prose';
import {
  newBudget,
  budgetGuard,
  recordUsage,
  recordSkipped,
  type BudgetCheckpoint,
  type BudgetLimit,
  type BudgetRates,
} from './budget';
import { renderBusinessCase, renderSizingBrief, renderTechnicalReview, renderClaimsChecklist } from '../render';

export interface RunConfig {
  bundle: EvidenceBundle;
  profile: SourceProfile;
  companyName: string;
  targetPlatform: string;
  preparedDate: string;
  tcoInputs: TcoInputs;
  rates: EcpuStorageRates;
  assumptions: string[];
  claims: ClaimInput[];
  llm?: LLM;
  model?: string;
  budgetRates?: BudgetRates;
  budgetLimit?: BudgetLimit;
  gateAnswers?: GateAnswer[];
  /** Precomputed triage (e.g. the UI ran it to show the sufficiency/gate) — skips re-running triage here. */
  triage?: TriageResult;
  /** Customer discount on the proposed solution (0 = none). Applied to the TCO before the math. */
  discountPct?: number;
  /** Refinement instruction forwarded to prose generation (wording/emphasis only; figures stay engine-locked). */
  proseInstruction?: string;
  /** Invoked after each budget checkpoint is recorded, for a live cost ticker. */
  onCheckpoint?: (checkpoint: BudgetCheckpoint) => void;
}

export interface PipelineOutput {
  docModel?: DocModel;
  rendered: RenderedDoc[];
  usage: Usage;
  budgetLog: BudgetCheckpoint[];
  gate: { items: GateItem[]; blocked: boolean; reasons: string[] };
  error?: string;
}

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_RATES: BudgetRates = { inputPer1k: 0.005, outputPer1k: 0.025 }; // Opus 4.8 list ($5/$25 per 1M)
const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

// Placeholder prose used only to assemble the numeric model for the prose-generation CONTEXT;
// it is discarded — the generated prose replaces it in the final DocModel before any render.
const TBD = 'TBD';
const PLACEHOLDER_PROSE: DocModel['prose'] = {
  businessCase: { execSummary: TBD, fullyLoadedComparison: TBD, migrationPath: TBD, drContext: TBD, keyAssumptions: TBD, pullQuote: TBD, nextSteps: TBD },
  sizingBrief: { workloadContext: TBD, provisioningApproach: TBD, sufficiencyStatement: TBD, followUps: TBD },
  technicalReview: { technicalNotes: TBD, riskAndMitigation: TBD, dataModelDecision: TBD, performanceValidation: TBD },
};

export async function runPipeline(config: RunConfig): Promise<PipelineOutput> {
  const model = config.model ?? DEFAULT_MODEL;
  const budget = newBudget(model, config.budgetRates ?? DEFAULT_RATES, config.budgetLimit);
  const base: { rendered: RenderedDoc[]; usage: Usage } = { rendered: [], usage: ZERO_USAGE };
  const log = (): BudgetCheckpoint[] => [...budget.checkpoints]; // snapshot, never the live array
  const clear = { items: [] as GateItem[], blocked: false, reasons: [] as string[] };
  // Push the just-recorded checkpoint to the live ticker (no-op if none was recorded).
  const fireCheckpoint = (): void => {
    const last = budget.checkpoints[budget.checkpoints.length - 1];
    if (last) config.onCheckpoint?.(last);
  };

  // 1. Classify (LLM optional — heuristics-only when no llm). Reuse a caller-precomputed triage if
  //    given (e.g. the UI ran it for the sufficiency/gate) to avoid a second LLM-classify pass.
  //    triage now returns its LLM usage, but wiring it into the budget is deferred to PR-D
  //    (RunConfig.classifyUsage); record a visibility checkpoint either way for now.
  const tri = config.triage ?? (await triage(config.bundle, config.profile, config.llm, model)).result;
  if (config.triage) {
    recordSkipped(budget, 'classify', 'classify reused from caller (not re-run; LLM usage counted by caller)');
    fireCheckpoint();
  } else if (config.llm) {
    recordSkipped(budget, 'classify', 'classify LLM usage is returned by triage but not yet counted here (wired in PR-D)');
    fireCheckpoint();
  }

  // 2. Apply gate answers (builds + re-runs sufficiency + toSizingInputs). Block if a required signal is unmet.
  const applied = applyGateAnswers(tri, config.gateAnswers ?? [], config.bundle.files, config.profile);
  if (applied.blocked || !applied.inputs) {
    const gate = buildGateData(applied.sufficiency, config.profile); // post-answer gaps (not the pre-answer set)
    const reasons = applied.reasons.length > 0 ? applied.reasons : gate.items.map((i) => `${i.signalId} ${i.currentStatus}`);
    return { ...base, budgetLog: log(), gate: { items: gate.items, blocked: true, reasons } };
  }

  // 3. Prose generation requires an LLM + budget headroom.
  if (!config.llm) {
    return { ...base, budgetLog: log(), gate: clear, error: 'no LLM provided — prose generation requires a provider' };
  }
  const guard = budgetGuard(budget, 'generate', 3000, 1500);
  if (!guard.proceed) {
    recordSkipped(budget, 'generate', guard.warning ?? 'budget exceeded');
    fireCheckpoint();
    return { ...base, budgetLog: log(), gate: clear, error: guard.warning };
  }

  // Assemble the numeric model (engine numbers) to feed the prose context, then fill the prose.
  const numericModel = assembleDocModel({
    companyName: config.companyName,
    targetPlatform: config.targetPlatform,
    preparedDate: config.preparedDate,
    documentStatus: 'preliminary',
    sizingInputs: applied.inputs,
    assumptions: config.assumptions,
    rates: config.rates,
    tcoInputs: config.tcoInputs,
    discountPct: config.discountPct,
    sufficiency: applied.sufficiency,
    prose: PLACEHOLDER_PROSE,
    claims: config.claims,
  });
  const { prose, usage } = await generateProse(numericModel, config.llm, model, config.proseInstruction);
  recordUsage(budget, 'generate', usage);
  fireCheckpoint();

  // 4. Final DocModel + render the deliverables + claims checklist.
  const docModel: DocModel = { ...numericModel, prose };
  const rendered = [
    renderBusinessCase(docModel),
    renderSizingBrief(docModel),
    renderTechnicalReview(docModel),
    renderClaimsChecklist(docModel),
  ];

  return { docModel, rendered, usage, budgetLog: log(), gate: clear };
}
