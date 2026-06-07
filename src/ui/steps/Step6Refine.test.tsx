// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regenerate now recomputes via runPipeline (cached triage + current discount + prose instruction),
// not generateProse alone — so we mock the pipeline and assert what it's called with.
const { runPipeline } = vi.hoisted(() => ({
  runPipeline: vi.fn(async (cfg: { proseInstruction?: string; discountPct?: number }) => {
    void cfg; // recorded in mock.calls for assertions
    return {
      docModel: { sufficiency: { verdict: { tier: 'directional-estimate' } }, claims: [], preparedDate: '2026-06-05' },
      rendered: [
        { filename: 'business-case.html', html: '<h1>BC REGENERATED</h1>' },
        { filename: 'sizing-brief.html', html: '<h1>SB2</h1>' },
        { filename: 'technical-review.html', html: '<h1>TR2</h1>' },
        { filename: 'claims.html', html: '<h1>CC2</h1>' },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      budgetLog: [],
      gate: { items: [], blocked: false, reasons: [] },
    };
  }),
}));
vi.mock('../../orchestrate', () => ({ runPipeline }));

import { Step6Refine } from './Step6Refine';
import { WizardProvider } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import type { DocModel } from '../../render/types';
import type { PipelineOutput } from '../../orchestrate';
import type { EvidenceBundle } from '../../ingest/types';
import type { TriageResult } from '../../classify/types';

const pipeline = {
  docModel: { sufficiency: { verdict: { tier: 'directional-estimate' } }, claims: [], preparedDate: '2026-06-05' } as unknown as DocModel,
  rendered: [
    { filename: 'business-case.html', html: '<h1>BC original</h1>' },
    { filename: 'sizing-brief.html', html: '<h1>SB original</h1>' },
    { filename: 'technical-review.html', html: '<h1>TR original</h1>' },
    { filename: 'claims.html', html: '<h1>CC original</h1>' },
  ],
  usage: { inputTokens: 0, outputTokens: 0 },
  budgetLog: [],
  gate: { items: [], blocked: false, reasons: [] },
} as unknown as PipelineOutput;

// buildRunConfig (the REAL one) needs an anonBundle, config, and triage on the wizard state.
const anonBundle: EvidenceBundle = { files: [], primitives: [{ kind: 'text', source: 'a', text: 'x' }] };
const triage = { bindings: [] } as unknown as TriageResult;

function setup() {
  return render(
    <ErrorProvider>
      <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, anonBundle, triage, pipeline }}>
        <Step6Refine />
      </WizardProvider>
    </ErrorProvider>,
  );
}

describe('Step6Refine', () => {
  beforeEach(() => runPipeline.mockClear());

  it('previews the active deliverable and switches tabs', () => {
    setup();
    expect(screen.getByText('BC original')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Sizing Brief' }));
    expect(screen.getByText('SB original')).toBeTruthy();
  });

  it('regenerate recomputes via the pipeline with the current discount + instruction, then re-renders', async () => {
    setup();
    fireEvent.input(screen.getByLabelText('Customer discount percent'), { target: { value: '15' } });
    fireEvent.input(screen.getByLabelText('Refine instruction'), { target: { value: 'tighten the exec summary' } });
    fireEvent.click(screen.getByText('Regenerate'));
    await waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    const cfg = runPipeline.mock.calls[0]![0];
    expect(cfg.proseInstruction).toBe('tighten the exec summary'); // instruction forwarded to prose
    expect(cfg.discountPct).toBe(15); // current discount applied → numbers recompute, not frozen
    await screen.findByText('BC REGENERATED'); // preview updated from the recompute
  });

  it('a case opened without a session key shows an inline key prompt and gates Regenerate until entered', async () => {
    render(
      <ErrorProvider>
        <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: false, anonBundle, triage, pipeline }}>
          <Step6Refine />
        </WizardProvider>
      </ErrorProvider>,
    );
    const btn = () => screen.getByRole('button', { name: /Regenerate/i }) as HTMLButtonElement;
    expect(btn().disabled).toBe(true); // no key yet
    fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
    await waitFor(() => expect(btn().disabled).toBe(false)); // entering the key unblocks refine
    expect(runPipeline).not.toHaveBeenCalled();
  });
});
