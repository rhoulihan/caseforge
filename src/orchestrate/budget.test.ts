import { describe, it, expect } from 'vitest';
import { newBudget, budgetGuard, recordUsage, recordSkipped, totals } from './budget';

const rates = { inputPer1k: 3, outputPer1k: 15 };

describe('budget', () => {
  it('records usage and accumulates cumulative tokens and cost monotonically', () => {
    const b = newBudget('claude-opus-4-8', rates);
    recordUsage(b, 'triage', { inputTokens: 100, outputTokens: 150 });
    recordUsage(b, 'generate', { inputTokens: 2500, outputTokens: 1200 });
    expect(b.checkpoints).toHaveLength(2);
    expect(b.checkpoints[0]!.cost).toBeCloseTo((100 * 3 + 150 * 15) / 1000, 10); // 2.55
    expect(totals(b).tokens).toBe(100 + 150 + 2500 + 1200);
    expect(totals(b).cost).toBeCloseTo(2.55 + (2500 * 3 + 1200 * 15) / 1000, 10); // + 25.5
    expect(b.checkpoints[1]!.cumulativeCost).toBeGreaterThan(b.checkpoints[0]!.cumulativeCost);
  });

  it('budgetGuard blocks when the projected total exceeds a token limit', () => {
    const b = newBudget('m', rates, { tokens: 1000 });
    recordUsage(b, 'triage', { inputTokens: 100, outputTokens: 150 });
    expect(budgetGuard(b, 'generate', 2500, 1200).proceed).toBe(false);
    expect(budgetGuard(b, 'small', 100, 100).proceed).toBe(true);
  });

  it('budgetGuard blocks when the projected total exceeds a dollar limit', () => {
    const b = newBudget('m', rates, { dollars: 10 });
    const g = budgetGuard(b, 'generate', 2500, 1200); // projected cost 25.5 > 10
    expect(g.proceed).toBe(false);
    expect(g.warning).toContain('Cost budget');
  });

  it('recordSkipped appends a skipped checkpoint without changing cumulatives', () => {
    const b = newBudget('m', rates, { tokens: 1000 });
    recordUsage(b, 'triage', { inputTokens: 100, outputTokens: 150 });
    recordSkipped(b, 'generate', 'budget exceeded');
    expect(b.checkpoints[1]!.skipped).toBe(true);
    expect(totals(b).tokens).toBe(250);
  });
});
