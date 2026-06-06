// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';

const { generateProse } = vi.hoisted(() => ({ generateProse: vi.fn(async () => ({ prose: {}, usage: { inputTokens: 1, outputTokens: 1 } })) }));
vi.mock('../../orchestrate/prose', () => ({ generateProse }));
vi.mock('../../render', () => ({
  renderBusinessCase: () => ({ filename: 'business-case.html', html: '<h1>BC REGENERATED</h1>' }),
  renderSizingBrief: () => ({ filename: 'sizing-brief.html', html: '<h1>SB</h1>' }),
  renderTechnicalReview: () => ({ filename: 'technical-review.html', html: '<h1>TR</h1>' }),
  renderClaimsChecklist: () => ({ filename: 'claims.html', html: '<h1>CC</h1>' }),
}));

import { Step6Refine } from './Step6Refine';
import { WizardProvider } from '../WizardContext';
import type { DocModel } from '../../render/types';
import type { PipelineOutput } from '../../orchestrate';

const pipeline = {
  docModel: { sufficiency: { verdict: { tier: 'directional-estimate' } } } as unknown as DocModel,
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

function setup() {
  return render(
    <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000 }, hasApiKey: true, pipeline }}>
      <Step6Refine />
    </WizardProvider>,
  );
}

describe('Step6Refine', () => {
  it('previews the active deliverable and switches tabs', () => {
    setup();
    expect(screen.getByText('BC original')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Sizing Brief' }));
    expect(screen.getByText('SB original')).toBeTruthy();
  });

  it('regenerates prose with the instruction (numbers locked) and re-renders the preview', async () => {
    setup();
    fireEvent.input(screen.getByLabelText('Refine instruction'), { target: { value: 'tighten the exec summary' } });
    fireEvent.click(screen.getByText('Regenerate prose'));
    await waitFor(() => expect(generateProse).toHaveBeenCalled());
    expect((generateProse.mock.calls[0] as unknown[])[3]).toBe('tighten the exec summary'); // instruction passed through
    await screen.findByText('BC REGENERATED'); // preview updated from the re-render
  });
});
