// Qualitative deliverable context — the non-numeric material (customer concerns, objections, deadlines,
// positioning) that should SHAPE the deliverables' narrative without ever touching an authoritative number.
// It is extracted alongside signals (see classify/llm.ts) and flows triage -> buildProseContext -> prose.
// Items are SLUGGED (anonymized) by the time they live here; de-anonymization happens at render, like prose.

/** What kind of insight a context item is — drives how prose weaves it in (see orchestrate/prose.ts). */
export type QualContextCategory = 'concern' | 'objection' | 'timeline' | 'positioning';

export interface QualContextItem {
  text: string; // verbatim / near-verbatim statement (slugged — never a real name)
  source: string; // the primitive's source file, injected by the caller (the LLM never knows filenames)
  category: QualContextCategory;
}

export interface QualContext {
  items: QualContextItem[];
}

export function emptyQualContext(): QualContext {
  return { items: [] };
}

/**
 * Concatenate two contexts (new array; operands untouched). No dedup: different source documents may
 * legitimately raise the same concern, and that repetition is meaningful emphasis for the narrative.
 */
export function mergeQualContexts(a?: QualContext, b?: QualContext): QualContext {
  return { items: [...(a?.items ?? []), ...(b?.items ?? [])] };
}
