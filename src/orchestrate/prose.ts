// The analyze/generate step: one LLM call that fills the DocModel's required prose. The LLM is fed
// the topology facts + the EXACT engine figures and writes narrative only — the authoritative
// numbers are rendered from the DocModel, so prose can never override them. Output is structured
// (jsonSchema) and every field is validated non-empty.

import type { LLM, Usage, JsonSchema } from '../provider';
import type { DocModel, BusinessCaseProse, SizingBriefProse, TechnicalReviewProse } from '../render/types';
import type { QualContext, QualContextItem, QualContextCategory } from '../classify/qual-context';

export interface ProseEnsemble {
  businessCase: BusinessCaseProse;
  sizingBrief: SizingBriefProse;
  technicalReview: TechnicalReviewProse;
}

export class ProseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProseValidationError';
  }
}

const STR = { type: 'string', minLength: 1 };

export const PROSE_SCHEMA: JsonSchema = {
  name: 'doc_prose_ensemble',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['businessCase', 'sizingBrief', 'technicalReview'],
    properties: {
      businessCase: {
        type: 'object',
        additionalProperties: false,
        required: ['execSummary', 'fullyLoadedComparison', 'migrationPath', 'drContext', 'keyAssumptions', 'pullQuote', 'nextSteps'],
        properties: { execSummary: STR, fullyLoadedComparison: STR, migrationPath: STR, drContext: STR, keyAssumptions: STR, pullQuote: STR, nextSteps: STR },
      },
      sizingBrief: {
        type: 'object',
        additionalProperties: false,
        required: ['workloadContext', 'provisioningApproach', 'sufficiencyStatement', 'followUps'],
        properties: { workloadContext: STR, provisioningApproach: STR, sufficiencyStatement: STR, followUps: STR },
      },
      technicalReview: {
        type: 'object',
        additionalProperties: false,
        required: ['technicalNotes', 'riskAndMitigation', 'dataModelDecision', 'performanceValidation'],
        properties: { technicalNotes: STR, riskAndMitigation: STR, dataModelDecision: STR, performanceValidation: STR },
      },
    },
  },
};

const k = (n: number): string => `$${Math.round(n / 1000)}K`;

// Bound the qualitative context that reaches the prompt: at most 20 items, each truncated, so a noisy
// extraction can't blow up the token count. Items are already slugged (de-anonymized at render).
const QC_MAX_ITEMS = 20;
const QC_MAX_CHARS = 200;

function qualContextSection(qc: QualContext): string[] {
  const items = qc.items.slice(0, QC_MAX_ITEMS);
  if (items.length === 0) return [];
  const groups: [string, QualContextCategory][] = [
    ['CONCERNS', 'concern'],
    ['OBJECTIONS', 'objection'],
    ['TIMELINE', 'timeline'],
    ['POSITIONING', 'positioning'],
  ];
  const line = (i: QualContextItem): string => `- ${i.text.slice(0, QC_MAX_CHARS)}${i.source ? ` [from ${i.source}]` : ''}`;
  const lines: string[] = ['', 'CUSTOMER CONTEXT (the customer’s own words — weave in naturally; address each concern/objection and honor the timeline; never quote verbatim):'];
  for (const [label, cat] of groups) {
    const g = items.filter((i) => i.category === cat);
    if (g.length) lines.push(`${label}:`, ...g.map(line));
  }
  return lines;
}

/** The slugs-only context: topology facts + the exact engine figures (the LLM must use, not invent),
 *  plus any qualitative customer context (concerns/objections/timeline/positioning) to shape the prose. */
export function buildProseContext(d: Omit<DocModel, 'prose' | 'claims'>, qualContext?: QualContext): string {
  const b = d.sizing.basis;
  const t = d.tco;
  return [
    'WORKLOAD (topology facts):',
    `- Cluster: ${b.shards} shards, ${b.hoVcpu} vCPU per home node, ${b.drVcpu} vCPU per DR node.`,
    `- Primary System-CPU: avg ${Math.round(b.util.primary.avgPct * 100)}% / peak ${Math.round(b.util.primary.peakPct * 100)}%; avg-to-peak ratio ${d.sizing.consumed.ratio}x.`,
    `- On-disk (compressed) data: ${(d.sizing.dataCompressedGb / 1000).toFixed(1)} TB${
      d.sizing.storageCompressed
        ? ''
        : ` (effective; from a ${(d.sizing.storageRawGb / 1000).toFixed(1)} TB uncompressed estimate at an assumed ${d.sizing.storageCompressionRatio}x Oracle compression factor)`
    }.`,
    '',
    'AUTHORITATIVE FIGURES (already computed — reference these, do not invent others):',
    ...(d.discountPct > 0
      ? [
          `- NOTE: the Oracle figures already include a ${d.discountPct}% customer discount off list${d.listAdbAnnual ? ` (ADB + warm DR list ${k(d.listAdbAnnual.warm)}/yr → your price ${k(t.adbWarmAnnual.central)}/yr)` : ''}; the on-prem baseline is undiscounted. Present the savings as INCLUSIVE of this discount — never call the discounted price "list" or "standard" pricing.`,
        ]
      : []),
    `- On-prem fully-loaded: ${k(t.onprem.total.central)}/yr.`,
    `- Oracle ADB + warm DR: ${k(t.adbWarmAnnual.central)}/yr (${t.savingWarm.pct}% lower).`,
    `- Oracle ADB + cold DR: ${k(t.adbColdAnnual.central)}/yr.`,
    `- 5-year net saving (warm): ${k(t.fiveYear.net5Warm)}; payback ~Year ${t.fiveYear.paybackYearWarm}.`,
    `- Conservative base ${d.sizing.scenarios[0]?.base} ECPU; aggressive base ${d.sizing.scenarios[1]?.base} ECPU.`,
    '',
    `SUFFICIENCY: ${d.sufficiency.verdict.tier} — ${d.sufficiency.verdict.headline}.`,
    'ASSUMPTIONS:',
    ...b.assumptions.map((a) => `- ${a}`),
    ...(qualContext ? qualContextSection(qualContext) : []),
  ].join('\n');
}

const FIELDS: Record<keyof ProseEnsemble, string[]> = {
  businessCase: ['execSummary', 'fullyLoadedComparison', 'migrationPath', 'drContext', 'keyAssumptions', 'pullQuote', 'nextSteps'],
  sizingBrief: ['workloadContext', 'provisioningApproach', 'sufficiencyStatement', 'followUps'],
  technicalReview: ['technicalNotes', 'riskAndMitigation', 'dataModelDecision', 'performanceValidation'],
};

function validateEnsemble(e: unknown): ProseEnsemble {
  const o = e as Record<string, Record<string, unknown> | undefined>;
  for (const doc of Object.keys(FIELDS) as (keyof ProseEnsemble)[]) {
    const section = o?.[doc];
    if (!section || typeof section !== 'object') throw new ProseValidationError(`prose missing section: ${doc}`);
    for (const f of FIELDS[doc]) {
      const v = section[f];
      if (typeof v !== 'string' || v.trim().length === 0) throw new ProseValidationError(`prose field ${doc}.${f} is missing or empty`);
    }
  }
  return o as unknown as ProseEnsemble;
}

export async function generateProse(
  docModel: Omit<DocModel, 'prose' | 'claims'>,
  llm: LLM,
  model: string,
  instruction?: string,
  qualContext?: QualContext,
): Promise<{ prose: ProseEnsemble; usage: Usage }> {
  const system =
    'You are a senior solutions engineer writing three documents (business case, sizing brief, technical review) for a database migration. Write narrative prose only. The authoritative numbers are already computed and given below — reference the figures provided and do NOT invent different ones. Every field is required and must be a non-empty string. Reply as JSON matching the schema.\n' +
    'When a CUSTOMER CONTEXT section is present, tailor the deliverables to it: open businessCase.execSummary with the customer’s top concern and let businessCase.nextSteps honor any stated timeline; rebut each objection with the engine figures in businessCase.fullyLoadedComparison; name each concern and give the Oracle mitigation in technicalReview.riskAndMitigation; reflect the positioning in sizingBrief.workloadContext. Synthesize naturally — never quote the context verbatim. If no CUSTOMER CONTEXT is present, write general-purpose professional prose and invent no concerns.';
  const context = buildProseContext(docModel, qualContext);
  // A refine instruction adjusts WORDING/emphasis only; the figures above stay authoritative.
  const content = instruction
    ? `${context}\n\nREFINEMENT REQUEST (adjust wording/emphasis only — keep every figure exactly as given): ${instruction}`
    : context;
  const res = await llm.complete({
    model,
    system,
    messages: [{ role: 'user', content }],
    jsonSchema: PROSE_SCHEMA,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new ProseValidationError('prose response was not valid JSON');
  }
  return { prose: validateEnsemble(parsed), usage: res.usage };
}
