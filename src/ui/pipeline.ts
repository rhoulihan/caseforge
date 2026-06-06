// Assembles a runPipeline RunConfig from the accumulated wizard state + researched/default costs.
// Keeps the wiring (which anonymized bundle, the REAL company name for the rendered docs, the cached
// triage, the budget limit, the ECPU/storage rates) in one testable place.

import type { RunConfig } from '../orchestrate';
import type { TcoInputs } from '../engine/types';
import type { ClaimInput } from '../render/types';
import type { TriageResult } from '../classify/types';
import type { BudgetCheckpoint } from '../orchestrate/budget';
import type { EcpuStorageRates } from '../render/builders';
import type { TcoProfile } from '../research/tco';
import type { WizardState } from './state';
import { MONGODB_PROFILE } from '../profile/mongodb';
import { createLLM } from '../provider';

const MODEL = 'claude-opus-4-8';
const ADB_RATES = { ecpuPerHr: 0.0807, storagePerGbMo: 0.1156 }; // Oracle ADB list rates

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

function numericBinding(triage: TriageResult | null, signalId: string): number | undefined {
  const b = triage?.bindings.find((x) => x.signalId === signalId);
  return b && typeof b.value === 'number' ? b.value : undefined;
}

/** On-disk (compressed) data size in GB from triage (the storage signal), else a conservative default. */
export function dataGbFromTriage(triage: TriageResult | null, fallback = 1000): number {
  return numericBinding(triage, 'data.storageSizeGb') ?? numericBinding(triage, 'data.logicalSizeGb') ?? fallback;
}

/** A TcoProfile for researchTcoCosts, built from the bound topology signals (+ defaults). */
export function tcoProfileFromState(state: WizardState): TcoProfile {
  return {
    dbType: 'mongodb',
    shards: numericBinding(state.triage, 'cluster.shardCount') ?? 1,
    hoVcpu: numericBinding(state.triage, 'node.hoVcpu') ?? 8,
    drVcpu: numericBinding(state.triage, 'node.drVcpu') ?? 0,
    dataCompressedGb: dataGbFromTriage(state.triage),
    drPosture: 'warm',
  };
}

export interface BuildConfigArgs {
  state: WizardState;
  apiKey: string;
  tcoInputs: TcoInputs;
  claims: ClaimInput[];
  preparedDate: string; // ISO yyyy-mm-dd
  onCheckpoint?: (cp: BudgetCheckpoint) => void;
}

export function buildRunConfig(a: BuildConfigArgs): RunConfig {
  const { state } = a;
  if (!state.anonBundle || !state.config || !state.triage) {
    throw new Error('cannot generate: missing anonymized bundle, setup, or classification');
  }
  const rates: EcpuStorageRates = { ...ADB_RATES, dataCompressedGb: dataGbFromTriage(state.triage) };
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
    triage: state.triage, // reuse the Step-4 triage — no second classify pass
    gateAnswers: state.gateAnswers,
    onCheckpoint: a.onCheckpoint,
  };
}
