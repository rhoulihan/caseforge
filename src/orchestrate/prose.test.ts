import { describe, it, expect } from 'vitest';
import { generateProse, buildProseContext, PROSE_SCHEMA, ProseValidationError } from './prose';
import { NORTHWIND_DOCMODEL } from '../render/fixtures/northwind-docmodel';
import type { LLM } from '../provider';

// DocModel is a structural subtype of Omit<DocModel,'prose'|'claims'>, so it can be passed directly.
const m = NORTHWIND_DOCMODEL;

function mockLLM(text: string, usage = { inputTokens: 2500, outputTokens: 1200 }): LLM {
  return {
    async complete() {
      return { text, usage, raw: {} };
    },
  };
}

/** Capturing mock — records the user-message content for prompt assertions. */
function capturingLLM(text: string): { llm: LLM; lastContent: () => string } {
  let content = '';
  return {
    lastContent: () => content,
    llm: {
      async complete(opts) {
        content = String(opts.messages[opts.messages.length - 1]?.content ?? '');
        return { text, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
      },
    },
  };
}

describe('generateProse', () => {
  it('returns the parsed ensemble + usage from a well-formed response', async () => {
    const llm = mockLLM(JSON.stringify(m.prose));
    const { prose, usage } = await generateProse(m, llm, 'claude-opus-4-8');
    expect(prose.businessCase.execSummary).toBe(m.prose.businessCase.execSummary);
    expect(prose.sizingBrief.workloadContext.length).toBeGreaterThan(0);
    expect(usage.inputTokens).toBe(2500);
  });

  it('throws ProseValidationError on a missing/empty field or non-JSON', async () => {
    const bad = structuredClone(m.prose);
    bad.businessCase.execSummary = '';
    await expect(generateProse(m, mockLLM(JSON.stringify(bad)), 'm')).rejects.toBeInstanceOf(ProseValidationError);
    await expect(generateProse(m, mockLLM('not json'), 'm')).rejects.toBeInstanceOf(ProseValidationError);
  });

  it('appends a refine instruction to the prompt (wording only) and keeps the figures', async () => {
    const cap = capturingLLM(JSON.stringify(m.prose));
    await generateProse(m, cap.llm, 'm', 'tighten the exec summary and emphasize DR');
    expect(cap.lastContent()).toContain('REFINEMENT REQUEST');
    expect(cap.lastContent()).toContain('tighten the exec summary');
    expect(cap.lastContent()).toContain('$450K'); // authoritative figures still present
  });

  it('omits the refinement section when no instruction is given', async () => {
    const cap = capturingLLM(JSON.stringify(m.prose));
    await generateProse(m, cap.llm, 'm');
    expect(cap.lastContent()).not.toContain('REFINEMENT REQUEST');
  });

  it('feeds topology facts and the authoritative figures into the prompt context', () => {
    const ctx = buildProseContext(m);
    expect(ctx).toContain('3 shards');
    expect(ctx).toContain('$450K');
    expect(ctx).toContain('$214K');
    expect(ctx).toContain('52%');
  });

  it('adds a discount note to the context only when a discount applies (so prose calls it "your price", not list)', () => {
    expect(buildProseContext(m)).not.toMatch(/customer discount/i); // 0% (default fixture) → no note
    const discounted = { ...m, discountPct: 25, listAdbAnnual: { warm: 213649, cold: 107746 } };
    const ctx = buildProseContext(discounted);
    expect(ctx).toMatch(/25% customer discount off list/i);
    expect(ctx).toMatch(/INCLUSIVE of this discount/i);
  });

  it('requires all 7+4+4 prose fields in the schema', () => {
    const s = PROSE_SCHEMA.schema as {
      properties: { businessCase: { required: string[] }; sizingBrief: { required: string[] }; technicalReview: { required: string[] } };
    };
    expect(s.properties.businessCase.required).toHaveLength(7);
    expect(s.properties.sizingBrief.required).toHaveLength(4);
    expect(s.properties.technicalReview.required).toHaveLength(4);
  });
});
