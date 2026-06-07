// MongoDB Atlas tier -> vCPU resolution. Pure, deterministic, no LLM: the LLM only READS the tier code
// ("M80") off an artifact; THIS does the lookup into ENGINE_CONFIG.atlasTierVcpu, so the authoritative
// vCPU count is computed in code (determinism boundary). An unknown tier returns undefined -> the caller
// leaves the signal unbound -> the §8.5 gate asks the rep for it. We never guess a vCPU for an unknown tier.

import { ENGINE_CONFIG, type EngineConfig } from '../engine/config';

/** vCPU/node for an Atlas tier code (case/whitespace-insensitive), or undefined if not in the table. */
export function tierToVcpu(tier: string, config: EngineConfig = ENGINE_CONFIG): number | undefined {
  const key = tier.trim().toUpperCase();
  const v = config.atlasTierVcpu[key];
  return typeof v === 'number' ? v : undefined;
}

/** The tier codes the default config knows — used to constrain the vision/text extraction prompts. */
export const KNOWN_TIERS: readonly string[] = Object.keys(ENGINE_CONFIG.atlasTierVcpu);
