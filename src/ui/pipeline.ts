// Assembles a runPipeline RunConfig from the accumulated wizard state + researched/default costs.
// Keeps the wiring (which anonymized bundle, the REAL company name for the rendered docs, the cached
// triage, the budget limit, the ECPU/storage rates) in one testable place.

import type { RunConfig } from '../orchestrate';
import type { TcoInputs } from '../engine/types';
import type { ClaimInput } from '../render/types';
import type { TriageResult } from '../classify/types';
import type { BudgetCheckpoint } from '../orchestrate/budget';
import type { EcpuStorageRates } from '../render/builders';
import { DR_POSTURES } from '../research/tco';
import type { TcoProfile, DrPostureInput } from '../research/tco';
import type { WizardState } from './state';
import { MONGODB_PROFILE } from '../profile/mongodb';
import { ENGINE_CONFIG } from '../engine/config';
import { createLLM } from '../provider';
import { applyGateAnswers } from '../orchestrate/gate';

const MODEL = 'claude-opus-4-8';
// Oracle ADB list rates — sourced from the central engine config (edit there when Oracle revises pricing).
const ADB_RATES = { ecpuPerHr: ENGINE_CONFIG.adb.ecpuPerHr, storagePerGbMo: ENGINE_CONFIG.adb.storagePerGbMo };

// Generic v1 fallback used only when the rep skips web-search cost research (labelled "default,
// not researched" in the UI). Research produces workload-appropriate figures.
export const DEFAULT_TCO_INPUTS: TcoInputs = {
  onpremComponents: {
    license: { low: 100_000, central: 200_000, high: 400_000 },
    hardware: { low: 30_000, central: 60_000, high: 120_000 },
    storage: { low: 5_000, central: 20_000, high: 90_000 },
    facility: { low: 25_000, central: 50_000, high: 100_000 },
    labor: { low: 30_000, central: 70_000, high: 140_000 },
    backup: { low: 5_000, central: 10_000, high: 20_000 },
  },
  adbPrimary: { low: 70_000, central: 90_000, high: 120_000 },
  coldDrAdd: { low: 15_000, central: 25_000, high: 40_000 },
  warmDrAdd: { low: 110_000, central: 130_000, high: 150_000 },
  migrationPs: { low: 75_000, central: 150_000, high: 300_000 },
};

function enumBinding(triage: TriageResult | null, signalId: string): string | undefined {
  const b = triage?.bindings.find((x) => x.signalId === signalId);
  return b && typeof b.value === 'string' ? b.value : undefined;
}

/** A TcoProfile for researchTcoCosts, built from the POST-GATE merged bindings (rep gate answers
 *  included). Every topology/storage value is rep/file-derived — there is NO fabricated fallback. */
export function tcoProfileFromState(state: WizardState): TcoProfile {
  if (!state.anonBundle) throw new Error('cost research needs an uploaded + anonymized bundle');
  if (!state.triage) throw new Error('cost research needs a completed classification (run Step 4 first)');
  const merged = applyGateAnswers(state.triage, state.gateAnswers, state.anonBundle.files, MONGODB_PROFILE);
  if (!merged.inputs || merged.dataCompressedGb === undefined) {
    throw new Error('cost research needs the gate satisfied (topology + storage)');
  }
  const tri = merged.triage;
  const posture = enumBinding(tri, 'dr.posture');
  return {
    dbType: 'mongodb',
    shards: merged.inputs.shards,
    hoVcpu: merged.inputs.hoVcpu,
    drVcpu: merged.inputs.drVcpu,
    dataCompressedGb: merged.dataCompressedGb,
    ...(posture !== undefined && (DR_POSTURES as readonly string[]).includes(posture)
      ? { drPosture: posture as DrPostureInput }
      : {}),
  };
}

export interface BuildConfigArgs {
  state: WizardState;
  apiKey: string;
  tcoInputs: TcoInputs;
  claims: ClaimInput[];
  preparedDate: string; // ISO yyyy-mm-dd
  proseInstruction?: string; // set on a Refine regenerate (wording/emphasis only)
  onCheckpoint?: (cp: BudgetCheckpoint) => void;
}

export function buildRunConfig(a: BuildConfigArgs): RunConfig {
  const { state } = a;
  if (!state.anonBundle || !state.config || !state.triage) {
    throw new Error('cannot generate: missing anonymized bundle, setup, or classification');
  }
  const rates: EcpuStorageRates = { ...ADB_RATES };
  return {
    bundle: state.anonBundle, // anonymized — the LLM only ever sees slugs
    profile: MONGODB_PROFILE,
    companyName: state.config.companyName, // REAL name for the rep-facing docs (never sent to the LLM)
    targetPlatform: 'Oracle Autonomous Database',
    preparedDate: a.preparedDate,
    tcoInputs: a.tcoInputs,
    rates,
    assumptions: [],
    claims: a.claims,
    llm: createLLM(state.config.provider, { apiKey: a.apiKey }),
    model: MODEL,
    budgetLimit: { tokens: state.config.tokenBudget },
    triage: state.triage, // reuse the Step-4 triage — no second classify pass (carries qualContext too)
    classifyUsage: state.classifyUsage, // so the reused-triage path still counts the classify cost
    gateAnswers: state.gateAnswers,
    discountPct: state.config.discountPct, // current customer discount → recomputed every regenerate
    proseInstruction: a.proseInstruction,
    onCheckpoint: a.onCheckpoint,
  };
}
