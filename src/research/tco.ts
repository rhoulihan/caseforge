// Web-search cost research: produces a TcoInputs (current market figures) + sourcing + confidence
// to feed the pure TCO engine. It NEVER computes TCO — the engine does. Researched figures are
// sourced INPUTS capped at the llm-text confidence tier (0.75), so sourcesToClaims() can never mark
// a researched cost 'high' confidence: it must pass the rep's confirm-assumptions gate (Plan 10l)
// before being treated as authoritative. This is a CALLER pre-step; runPipeline is untouched.

import { ProviderError } from '../provider';
import type { LLM, Usage, JsonSchema, CompleteResult } from '../provider';
import type { TcoInputs, Range } from '../engine/types';
import type { ClaimInput } from '../render/types';
import type { ClaimConfidence } from '../classify/confidence';
import { budgetGuard, recordUsage, recordSkipped, type BudgetContext } from '../orchestrate/budget';

export const DB_TYPES = ['mongodb', 'postgresql', 'mysql'] as const;
export type DbType = (typeof DB_TYPES)[number];
export const LICENSE_MODELS = ['enterprise', 'community', 'premium'] as const;
export type LicenseModel = (typeof LICENSE_MODELS)[number];
export const DR_POSTURES = ['none', 'cold', 'warm'] as const;
export type DrPostureInput = (typeof DR_POSTURES)[number];

export interface TcoProfile {
  dbType: DbType;
  shards: number;
  hoVcpu: number;
  drVcpu: number;
  dataCompressedGb: number;
  licenseModel?: LicenseModel;
  drPosture?: DrPostureInput;
}

export const ONPREM_COMPONENTS = ['license', 'hardware', 'storage', 'facility', 'labor', 'backup'] as const;
export const CLOUD_COMPONENTS = ['adbPrimary', 'coldDrAdd', 'warmDrAdd', 'migrationPs'] as const;
export const ALL_COMPONENTS = [...ONPREM_COMPONENTS, ...CLOUD_COMPONENTS] as const;
export type CostComponent = (typeof ALL_COMPONENTS)[number];

export type SourceQuality = 'published' | 'synthesized' | 'training-cutoff';

export interface CostSourceRow {
  component: CostComponent;
  source: string;
  url: string;
  asOfDate: string; // YYYY-MM-DD
  sourceQuality: SourceQuality;
}

export interface TcoResearchResult {
  inputs: TcoInputs;
  sourcing: CostSourceRow[];
  confidence: number; // 0..0.75 (capped at the llm-text tier)
  usage: Usage;
  warnings: string[];
}

export class TcoResearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TcoResearchValidationError';
  }
}

const STALE_MS = 180 * 24 * 60 * 60 * 1000;

export function validateTcoProfile(p: TcoProfile): void {
  if (!DB_TYPES.includes(p.dbType)) throw new TcoResearchValidationError(`invalid dbType: ${String(p.dbType)}`);
  const positive: Array<[string, number]> = [
    ['shards', p.shards],
    ['hoVcpu', p.hoVcpu],
    ['dataCompressedGb', p.dataCompressedGb],
  ];
  for (const [k, v] of positive) {
    if (!Number.isFinite(v) || v <= 0) throw new TcoResearchValidationError(`${k} must be a positive number (got ${String(v)})`);
  }
  if (!Number.isFinite(p.drVcpu) || p.drVcpu < 0) throw new TcoResearchValidationError(`drVcpu must be a number ≥ 0 (got ${String(p.drVcpu)})`);
  if (p.licenseModel !== undefined && !LICENSE_MODELS.includes(p.licenseModel)) {
    throw new TcoResearchValidationError(`invalid licenseModel: ${String(p.licenseModel)}`);
  }
  if (p.drPosture !== undefined && !DR_POSTURES.includes(p.drPosture)) throw new TcoResearchValidationError(`invalid drPosture: ${String(p.drPosture)}`);
}

const RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['low', 'central', 'high'],
  properties: { low: { type: 'number' }, central: { type: 'number' }, high: { type: 'number' } },
};

const ONPREM_PROPS: Record<string, unknown> = {};
for (const c of ONPREM_COMPONENTS) ONPREM_PROPS[c] = RANGE_SCHEMA;

export const TCO_RESEARCH_SCHEMA: JsonSchema = {
  name: 'tco_cost_research',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['onpremComponents', 'adbPrimary', 'coldDrAdd', 'warmDrAdd', 'migrationPs', 'sources'],
    properties: {
      onpremComponents: {
        type: 'object',
        additionalProperties: false,
        required: [...ONPREM_COMPONENTS],
        properties: ONPREM_PROPS,
      },
      adbPrimary: RANGE_SCHEMA,
      coldDrAdd: RANGE_SCHEMA,
      warmDrAdd: RANGE_SCHEMA,
      migrationPs: RANGE_SCHEMA,
      sources: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['component', 'source', 'url', 'asOfDate', 'sourceQuality'],
          properties: {
            component: { type: 'string', enum: [...ALL_COMPONENTS] },
            source: { type: 'string' },
            url: { type: 'string' },
            asOfDate: { type: 'string' },
            sourceQuality: { type: 'string', enum: ['published', 'synthesized', 'training-cutoff'] },
          },
        },
      },
    },
  },
};

/** Strict YYYY-MM-DD parse with real-calendar validation (rejects 2026-13-01, 2026-02-30). */
function parseIsoDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.getTime();
}

/** Pass 1+2: validate the three numbers, normalize a point-estimate to a ±20% spread, then check order. */
function normalizeRange(name: string, raw: unknown): Range {
  if (typeof raw !== 'object' || raw === null) throw new TcoResearchValidationError(`${name}: missing range`);
  const r = raw as Record<string, unknown>;
  const nums: Record<'low' | 'central' | 'high', number> = { low: 0, central: 0, high: 0 };
  for (const k of ['low', 'central', 'high'] as const) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new TcoResearchValidationError(`${name}.${k}: must be a finite number ≥ 0 (got ${String(v)})`);
    }
    nums[k] = v;
  }
  let { low, high } = nums;
  const { central } = nums;
  // Expand ONLY a genuine point-estimate: central already inside a tight [low,high] band. Requiring
  // low ≤ central ≤ high here means a corrupt range (central outside the band) is NOT silently
  // "fixed" — it falls through to the monotonic check below and is rejected.
  if (central > 0 && low <= central && central <= high && high - low < 0.1 * central) {
    low = Math.round(central * 0.8);
    high = Math.round(central * 1.2);
  }
  if (!(low <= central && central <= high)) {
    throw new TcoResearchValidationError(`${name}: range not monotonic (low ${low} ≤ central ${central} ≤ high ${high})`);
  }
  return { low, central, high };
}

function validateSources(raw: unknown): CostSourceRow[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new TcoResearchValidationError('sources: at least one required');
  const out: CostSourceRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = (raw[i] ?? {}) as Record<string, unknown>;
    const component = s.component;
    if (typeof component !== 'string' || !(ALL_COMPONENTS as readonly string[]).includes(component)) {
      throw new TcoResearchValidationError(`sources[${i}].component invalid: ${String(component)}`);
    }
    const quality = s.sourceQuality;
    if (quality !== 'published' && quality !== 'synthesized' && quality !== 'training-cutoff') {
      throw new TcoResearchValidationError(`sources[${i}].sourceQuality invalid: ${String(quality)}`);
    }
    const source = typeof s.source === 'string' ? s.source.trim() : '';
    if (source === '') throw new TcoResearchValidationError(`sources[${i}].source is empty`);
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    if (url === '' && quality !== 'training-cutoff') {
      throw new TcoResearchValidationError(`sources[${i}].url is required for a ${quality} source`);
    }
    const asOfDate = typeof s.asOfDate === 'string' ? s.asOfDate : '';
    if (parseIsoDate(asOfDate) === null) throw new TcoResearchValidationError(`sources[${i}].asOfDate invalid (want YYYY-MM-DD): ${asOfDate}`);
    out.push({ component: component as CostComponent, source, url, asOfDate, sourceQuality: quality });
  }
  return out;
}

/** Structural validation + range normalization. Staleness/confidence is computed separately. */
export function normalizeAndValidate(parsed: unknown): { inputs: TcoInputs; sources: CostSourceRow[] } {
  if (typeof parsed !== 'object' || parsed === null) throw new TcoResearchValidationError('response is not an object');
  const p = parsed as Record<string, unknown>;
  if (typeof p.onpremComponents !== 'object' || p.onpremComponents === null) {
    throw new TcoResearchValidationError('onpremComponents missing');
  }
  const opObj = p.onpremComponents as Record<string, unknown>;
  const onpremComponents: Record<string, Range> = {};
  for (const c of ONPREM_COMPONENTS) onpremComponents[c] = normalizeRange(`onpremComponents.${c}`, opObj[c]);
  const inputs: TcoInputs = {
    onpremComponents,
    adbPrimary: normalizeRange('adbPrimary', p.adbPrimary),
    coldDrAdd: normalizeRange('coldDrAdd', p.coldDrAdd),
    warmDrAdd: normalizeRange('warmDrAdd', p.warmDrAdd),
    migrationPs: normalizeRange('migrationPs', p.migrationPs),
  };
  return { inputs, sources: validateSources(p.sources) };
}

const QUALITY_BASE: Record<SourceQuality, number> = { published: 0.75, synthesized: 0.65, 'training-cutoff': 0.5 };

/** Weakest-link confidence over sources, capped at the llm-text tier (0.75). */
function computeConfidence(sources: CostSourceRow[], now: number, webSearchUsed: boolean): { confidence: number; warnings: string[] } {
  const warnings: string[] = [];
  let min = 0.75;
  let anyStale = false;
  for (const s of sources) {
    let c = QUALITY_BASE[s.sourceQuality];
    const ts = parseIsoDate(s.asOfDate);
    if (s.sourceQuality !== 'training-cutoff' && ts !== null && ts < now - STALE_MS) {
      c = Math.min(c, 0.6);
      anyStale = true;
    }
    min = Math.min(min, c);
  }
  let confidence = Math.min(min, 0.75);
  const allTrainingCutoff = sources.every((s) => s.sourceQuality === 'training-cutoff');
  const anyWeb = sources.some((s) => s.sourceQuality !== 'training-cutoff');
  if (allTrainingCutoff || (webSearchUsed && !anyWeb)) {
    confidence = Math.min(confidence, 0.5);
    warnings.push('all cost sources are training-cutoff (no live web results); confidence capped at 0.5');
  } else if (anyStale) {
    warnings.push('one or more cost sources are stale (>180 days); confidence capped at 0.6');
  }
  return { confidence, warnings };
}

function buildResearchPrompt(profile: TcoProfile): string {
  const lic = profile.licenseModel ? `${profile.licenseModel} ` : '';
  const drLine = profile.drPosture
    ? `, DR posture "${profile.drPosture}"`
    : ', evaluate both warm-standby and cold (backup-based) DR';
  return [
    `Research CURRENT market cost figures to compare a ${lic}${profile.dbType} on-premises deployment against Oracle Autonomous Database (ADB).`,
    `Workload topology: ${profile.shards} shard(s), ${profile.hoVcpu} primary vCPU, ${profile.drVcpu} DR vCPU, ${profile.dataCompressedGb} GB compressed data${drLine}.`,
    '',
    'Return JSON matching the schema. Provide a low/central/high range in whole USD for EACH of:',
    '- onpremComponents: license, hardware, storage, facility, labor, backup (annual USD/yr).',
    '- adbPrimary (annual USD/yr), coldDrAdd (annual USD/yr), warmDrAdd (annual USD/yr), migrationPs (one-time USD).',
    '',
    'For every figure, cite at least one source in "sources". Set sourceQuality="published" for vendor/analyst list pricing (include the URL), "synthesized" for a triangulated estimate (include the best URL), or "training-cutoff" if you did NOT retrieve it from the web (url may be empty). Always include asOfDate as YYYY-MM-DD. Do not output NaN, Infinity, null, or negative numbers.',
  ].join('\n');
}

const SYSTEM =
  'You are a meticulous IT cost-research analyst. Research current market pricing using web search when available and return ONLY JSON matching the provided schema. Never invent a URL: if a figure comes from training data rather than a retrieved page, mark its source sourceQuality="training-cutoff".';

const EST_INPUT = 2500;
const EST_OUTPUT = 1200;

export async function researchTcoCosts(
  llm: LLM,
  model: string,
  profile: TcoProfile,
  opts: { now?: number; budget?: BudgetContext } = {},
): Promise<TcoResearchResult> {
  validateTcoProfile(profile);
  const now = opts.now ?? Date.now();
  const prompt = buildResearchPrompt(profile);
  const messages = [{ role: 'user' as const, content: prompt }];

  if (opts.budget) {
    const g = budgetGuard(opts.budget, 'research', EST_INPUT, EST_OUTPUT);
    if (!g.proceed) {
      recordSkipped(opts.budget, 'research', g.warning ?? 'budget exceeded');
      throw new TcoResearchValidationError(g.warning ?? 'cost research skipped: budget exceeded');
    }
  }

  let res: CompleteResult;
  let usedFallback = false;
  let fallbackNote: string | undefined;
  try {
    res = await llm.complete({ model, system: SYSTEM, messages, webSearch: true, jsonSchema: TCO_RESEARCH_SCHEMA });
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    // Transient failures (rate-limit / 5xx incl. 529 "overloaded") were already backed off by the
    // provider's withRetry; retrying knowledge-only would just hit the same overload and silently
    // degrade quality. Surface a clear, actionable message instead — the rep can retry or generate
    // with default cost estimates (research is optional).
    if (err.retryable) {
      throw new TcoResearchValidationError(
        `the AI provider is temporarily overloaded (status ${err.status ?? '529'}) — wait a moment and try Research again, or click Generate to use default cost estimates`,
      );
    }
    // Non-transient (e.g. web_search not supported on this key / invalid_request): fall back to a
    // knowledge-only pass (no web search). A JSON/logic error is NOT caught here (it surfaces below).
    if (opts.budget) {
      const g = budgetGuard(opts.budget, 'research-retry', EST_INPUT, EST_OUTPUT);
      if (!g.proceed) {
        recordSkipped(opts.budget, 'research-retry', g.warning ?? 'budget exceeded');
        throw new TcoResearchValidationError(`web-search research failed (${err.message}) and retry would exceed budget`);
      }
    }
    usedFallback = true;
    fallbackNote = `web search unavailable (${err.message}); retried with training-cutoff knowledge only`;
    try {
      res = await llm.complete({ model, system: SYSTEM, messages, jsonSchema: TCO_RESEARCH_SCHEMA });
    } catch (retryErr) {
      // The knowledge-only retry also failed — record the skip (keep the budget log honest) and
      // surface a typed error rather than leaking a raw ProviderError.
      if (opts.budget) recordSkipped(opts.budget, 'research-retry', (retryErr as Error).message);
      throw new TcoResearchValidationError(`cost research failed on retry: ${(retryErr as Error).message}`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    throw new TcoResearchValidationError(`response was not valid JSON: ${(e as Error).message}`);
  }
  const { inputs, sources: parsedSources } = normalizeAndValidate(parsed);
  // Knowledge-only fallback: no web search ran, so every source is training-cutoff regardless of
  // what the model claimed (a "published" claim with a URL would be a hallucination here).
  const sources = usedFallback
    ? parsedSources.map((s) => ({ ...s, sourceQuality: 'training-cutoff' as const }))
    : parsedSources;
  const { confidence, warnings } = computeConfidence(sources, now, !usedFallback);
  const allWarnings = fallbackNote ? [fallbackNote, ...warnings] : warnings;

  if (opts.budget) recordUsage(opts.budget, usedFallback ? 'research-retry' : 'research', res.usage);
  return { inputs, sourcing: sources, confidence, usage: res.usage, warnings: allWarnings };
}

function toTier(c: number): ClaimConfidence {
  return c >= 0.85 ? 'high' : c >= 0.6 ? 'medium' : 'low';
}

const COMPONENT_META: Record<CostComponent, { claim: string; unit: string }> = {
  license: { claim: 'On-prem license cost (researched)', unit: 'USD/yr' },
  hardware: { claim: 'On-prem hardware cost (researched)', unit: 'USD/yr' },
  storage: { claim: 'On-prem storage cost (researched)', unit: 'USD/yr' },
  facility: { claim: 'On-prem facility cost (researched)', unit: 'USD/yr' },
  labor: { claim: 'On-prem labor cost (researched)', unit: 'USD/yr' },
  backup: { claim: 'On-prem backup cost (researched)', unit: 'USD/yr' },
  adbPrimary: { claim: 'ADB primary annual cost (researched)', unit: 'USD/yr' },
  coldDrAdd: { claim: 'Cold-DR incremental cost (researched)', unit: 'USD/yr' },
  warmDrAdd: { claim: 'Warm-DR incremental cost (researched)', unit: 'USD/yr' },
  migrationPs: { claim: 'Migration professional services (researched)', unit: 'USD' },
};

function centralOf(inputs: TcoInputs, c: CostComponent): number {
  switch (c) {
    case 'adbPrimary':
      return inputs.adbPrimary.central;
    case 'coldDrAdd':
      return inputs.coldDrAdd.central;
    case 'warmDrAdd':
      return inputs.warmDrAdd.central;
    case 'migrationPs':
      return inputs.migrationPs.central;
    default:
      return inputs.onpremComponents[c]!.central;
  }
}

/**
 * One ClaimInput per cost component, citing its first source. Confidence is the research confidence
 * mapped to a tier — capped at 0.75 it is at most 'medium', NEVER 'high': a researched cost cannot
 * render as authoritative until the rep confirms it at the gate (Plan 10l). Returns a fresh array.
 */
export function sourcesToClaims(result: TcoResearchResult): ClaimInput[] {
  // Clamp at the llm-text tier unconditionally, so even a struct built outside researchTcoCosts can
  // never yield a 'high'-confidence researched claim (the determinism boundary holds by construction).
  const tier = toTier(Math.min(result.confidence, 0.75));
  const firstByComponent = new Map<CostComponent, CostSourceRow>();
  for (const s of result.sourcing) if (!firstByComponent.has(s.component)) firstByComponent.set(s.component, s);
  return ALL_COMPONENTS.map((c) => {
    const meta = COMPONENT_META[c];
    const src = firstByComponent.get(c);
    const label = src
      ? src.sourceQuality === 'training-cutoff'
        ? `${src.source} (training-cutoff, as of ${src.asOfDate})`
        : `${src.source} — ${src.url} (as of ${src.asOfDate})`
      : 'web-search cost research';
    return {
      id: `research:${c}`,
      section: 'D' as const,
      claim: meta.claim,
      value: centralOf(result.inputs, c),
      unit: meta.unit,
      declaredSource: { label, confidence: tier },
    };
  });
}
