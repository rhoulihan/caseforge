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
import { WizardProvider, useWizard } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import type { DocModel } from '../../render/types';
import type { PipelineOutput } from '../../orchestrate';
import type { EvidenceBundle } from '../../ingest/types';
import type { TriageResult } from '../../classify/types';
import type { LauncherClient } from '../../launcher/client';

// Launcher mock: anonymize slugs a real name (proves the refine instruction is anonymized before the LLM);
// saveArchive spies the save-on-refine.
const saveArchive = vi.fn(async () => undefined);
const mockLauncher = {
  anonymize: async (_m: unknown, text: string) => ({ text: text.replace(/Acme/g, 'CF_ORG_01'), count: 1 }),
  deanonymize: async (_m: unknown, text: string) => ({ text, count: 0 }),
  health: async () => true,
  saveArchive,
} as unknown as LauncherClient;
const map = [{ phrase: 'Acme', slug: 'CF_ORG_01' }];

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

const v1 = { id: '001', createdAt: 't0', trigger: 'initial' as const, discountPct: 0, docModel: pipeline.docModel!, rendered: pipeline.rendered };

function setup() {
  return render(
    <ErrorProvider>
      <WizardProvider
        launcher={mockLauncher}
        initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, anonBundle, triage, pipeline, caseId: 'acme-1', map, versions: [v1], refinementHistory: [] }}
      >
        <Step6Refine />
      </WizardProvider>
    </ErrorProvider>,
  );
}

describe('Step6Refine', () => {
  beforeEach(() => {
    runPipeline.mockClear();
    saveArchive.mockClear();
  });

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
    await waitFor(() => expect(saveArchive).toHaveBeenCalledTimes(1)); // save-on-refine (appends a version)
  });

  it('slug-anonymizes the refine instruction before the LLM (a real name never reaches it)', async () => {
    setup();
    fireEvent.input(screen.getByLabelText('Refine instruction'), { target: { value: "emphasize Acme's resilience" } });
    fireEvent.click(screen.getByText('Regenerate'));
    await waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    const instruction = runPipeline.mock.calls[0]![0].proseInstruction ?? '';
    expect(instruction).toContain('CF_ORG_01'); // anonymized
    expect(instruction).not.toContain('Acme'); // the real name never reached the LLM
  });

  it('blocks a refine whose instruction names someone NOT in the anonymization list (fail-closed)', async () => {
    setup();
    fireEvent.input(screen.getByLabelText('Refine instruction'), { target: { value: 'mention our partner Globex Corporation' } });
    fireEvent.click(screen.getByText('Regenerate'));
    await screen.findByText(/not in the anonymization list/i);
    expect(runPipeline).not.toHaveBeenCalled(); // never sent to the LLM
  });

  it('"Add more files" carries the note + flag and returns to Step 2', async () => {
    function Probe() {
      const { state } = useWizard();
      return <span data-testid="probe">{`${state.step}|${state.addFilesMode}|${state.pendingRefinement ?? ''}`}</span>;
    }
    render(
      <ErrorProvider>
        <WizardProvider launcher={mockLauncher} initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, anonBundle, triage, pipeline, caseId: 'acme-1', map, versions: [v1], refinementHistory: [] }}>
          <Step6Refine />
          <Probe />
        </WizardProvider>
      </ErrorProvider>,
    );
    fireEvent.input(screen.getByLabelText('Refine instruction'), { target: { value: 'tighten it' } });
    fireEvent.click(screen.getByText('+ Add more files'));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('2|true|tighten it')); // → Step 2, flag + note set
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('a case opened without a session key shows an inline key prompt and gates Regenerate until entered', async () => {
    render(
      <ErrorProvider>
        <WizardProvider launcher={mockLauncher} initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: false, anonBundle, triage, pipeline }}>
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
