// Token/cost budget for the pipeline. budgetGuard PROJECTS a call's cost before it runs (and can
// block it); recordUsage records the ACTUAL usage after; recordSkipped notes a stage that was not
// run. Cumulatives are monotonic. Surfaced to the rep via PipelineOutput.budgetLog.

import type { Usage } from '../provider';

export interface BudgetCheckpoint {
  stage: string;
  inputTokens: number;
  outputTokens: number;
  cumulativeTokens: number;
  cost: number;
  cumulativeCost: number;
  skipped?: boolean;
  reason?: string;
}

export interface BudgetLimit {
  tokens?: number;
  dollars?: number;
}

export interface BudgetRates {
  inputPer1k: number;
  outputPer1k: number;
}

export interface BudgetContext {
  model: string;
  rates: BudgetRates;
  limit?: BudgetLimit;
  checkpoints: BudgetCheckpoint[];
}

export function newBudget(model: string, rates: BudgetRates, limit?: BudgetLimit): BudgetContext {
  return { model, rates, limit, checkpoints: [] };
}

function costOf(b: BudgetContext, inTok: number, outTok: number): number {
  return (inTok * b.rates.inputPer1k + outTok * b.rates.outputPer1k) / 1000;
}

export function totals(b: BudgetContext): { tokens: number; cost: number } {
  const last = b.checkpoints[b.checkpoints.length - 1];
  return last ? { tokens: last.cumulativeTokens, cost: last.cumulativeCost } : { tokens: 0, cost: 0 };
}

/** Project the next call against the limit; {proceed:false,warning} if it would exceed tokens or dollars. */
export function budgetGuard(b: BudgetContext, _stage: string, estInput: number, estOutput: number): { proceed: boolean; warning?: string } {
  const cur = totals(b);
  const projTokens = cur.tokens + estInput + estOutput;
  const projCost = cur.cost + costOf(b, estInput, estOutput);
  if (b.limit?.tokens !== undefined && projTokens > b.limit.tokens) {
    return { proceed: false, warning: `Token budget would be exceeded: projected ${projTokens} > limit ${b.limit.tokens}` };
  }
  if (b.limit?.dollars !== undefined && projCost > b.limit.dollars) {
    return { proceed: false, warning: `Cost budget would be exceeded: projected $${projCost.toFixed(2)} > limit $${b.limit.dollars.toFixed(2)}` };
  }
  return { proceed: true };
}

export function recordUsage(b: BudgetContext, stage: string, usage: Usage): void {
  const cur = totals(b);
  const cost = costOf(b, usage.inputTokens, usage.outputTokens);
  b.checkpoints.push({
    stage,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cumulativeTokens: cur.tokens + usage.inputTokens + usage.outputTokens,
    cost,
    cumulativeCost: cur.cost + cost,
  });
}

export function recordSkipped(b: BudgetContext, stage: string, reason: string): void {
  const cur = totals(b);
  b.checkpoints.push({ stage, inputTokens: 0, outputTokens: 0, cumulativeTokens: cur.tokens, cost: 0, cumulativeCost: cur.cost, skipped: true, reason });
}
