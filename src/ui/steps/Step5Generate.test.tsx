// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';

// Mock the pipeline + research so the component test exercises wiring + the live ticker, not the LLM.
const { runPipeline } = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock('../../orchestrate', () => ({ runPipeline }));
vi.mock('../../research/tco', () => ({ researchTcoCosts: vi.fn(), sourcesToClaims: vi.fn(() => []) }));

import { Step5Generate } from './Step5Generate';
import { WizardProvider, useWizard } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import type { TriageResult } from '../../classify/types';
import type { EvidenceBundle } from '../../ingest/types';
import type { LauncherClient } from '../../launcher/client';

const anonBundle: EvidenceBundle = { files: [], primitives: [{ kind: 'text', source: 'a', text: 'CF_ORG_01' }] };
const triage = { profileId: 'mongodb', inventory: [], bindings: [] } as unknown as TriageResult;

function Readout() {
  const { state } = useWizard();
  return <span data-testid="gen">{state.pipeline?.docModel ? 'done' : 'pending'}</span>;
}

function setup() {
  return render(
    <ErrorProvider>
      <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle: anonBundle, anonBundle, triage }}>
        <Step5Generate />
        <Readout />
      </WizardProvider>
    </ErrorProvider>,
  );
}

describe('Step5Generate', () => {
  it('runs the pipeline, drives the live cost ticker, and stores the result', async () => {
    runPipeline.mockImplementation(async (cfg: { onCheckpoint?: (c: unknown) => void }) => {
      cfg.onCheckpoint?.({ stage: 'classify', inputTokens: 0, outputTokens: 0, cumulativeTokens: 0, cost: 0, cumulativeCost: 0, skipped: true, reason: 'reused' });
      cfg.onCheckpoint?.({ stage: 'generate', inputTokens: 3000, outputTokens: 1500, cumulativeTokens: 4500, cost: 0.05, cumulativeCost: 0.05 });
      return {
        docModel: { sufficiency: { verdict: { tier: 'directional-estimate' } } },
        rendered: [{ filename: 'business-case.html', html: '<x/>' }],
        usage: { inputTokens: 3000, outputTokens: 1500 },
        budgetLog: [],
        gate: { items: [], blocked: false, reasons: [] },
      };
    });

    setup();
    fireEvent.click(screen.getByText(/Generate deliverables/i));

    await waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    await screen.findByText(/1 deliverable\(s\) generated/i);
    expect(screen.getByText(/classify — reused/i)).toBeTruthy(); // ticker checkpoint
    expect(screen.getByText(/generate — 4500 tok/i)).toBeTruthy();
    expect(screen.getByText(/spent/i).textContent).toContain('$0.05');
    expect(screen.getByTestId('gen').textContent).toBe('done');

    // the pipeline received the cached triage + anonymized bundle (no re-classify, no real text)
    const cfg = runPipeline.mock.calls[0]![0] as { triage: unknown; bundle: EvidenceBundle; companyName: string };
    expect(cfg.triage).toBe(triage);
    expect(cfg.bundle).toBe(anonBundle);
    expect(cfg.companyName).toBe('Acme');
  });

  it('archives the case on a successful generate (save-on-generate, best-effort)', async () => {
    runPipeline.mockImplementation(async () => ({
      docModel: { sufficiency: { verdict: { tier: 'directional-estimate' } }, companyName: 'Acme', discountPct: 0 },
      rendered: [{ filename: 'business-case-acme.html', html: '<x/>' }],
      usage: { inputTokens: 0, outputTokens: 0 },
      budgetLog: [],
      gate: { items: [], blocked: false, reasons: [] },
    }));
    const saveArchive = vi.fn(async () => undefined);
    const launcher = { health: async () => true, saveArchive } as unknown as LauncherClient;
    render(
      <ErrorProvider>
        <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle: anonBundle, anonBundle, triage }} launcher={launcher}>
          <Step5Generate />
        </WizardProvider>
      </ErrorProvider>,
    );
    fireEvent.click(screen.getByText(/Generate deliverables/i));
    await waitFor(() => expect(saveArchive).toHaveBeenCalledTimes(1));
    const [caseId, bytes] = saveArchive.mock.calls[0]! as unknown as [string, Uint8Array];
    expect(caseId).toMatch(/^acme-/); // slug(company) + timestamp
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('surfaces a visible warning (no silent loss) when the archive save fails', async () => {
    runPipeline.mockImplementation(async () => ({
      docModel: { sufficiency: { verdict: { tier: 'directional-estimate' } }, companyName: 'Acme', discountPct: 0 },
      rendered: [{ filename: 'business-case-acme.html', html: '<x/>' }],
      usage: { inputTokens: 0, outputTokens: 0 },
      budgetLog: [],
      gate: { items: [], blocked: false, reasons: [] },
    }));
    const launcher = { health: async () => true, saveArchive: vi.fn(async () => { throw new Error('archive exceeds 200 MiB'); }) } as unknown as LauncherClient;
    render(
      <ErrorProvider>
        <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle: anonBundle, anonBundle, triage }} launcher={launcher}>
          <Step5Generate />
        </WizardProvider>
      </ErrorProvider>,
    );
    fireEvent.click(screen.getByText(/Generate deliverables/i));
    await screen.findByText(/could not be saved/i); // visible, not silent
    expect(screen.getByText(/1 deliverable\(s\) generated/i)).toBeTruthy(); // deliverables NOT lost
  });

  it('an add-files generate applies the carried refine instruction and clears the flag', async () => {
    runPipeline.mockClear(); // prior tests in this file also call runPipeline — count only this test's call
    runPipeline.mockImplementation(async (cfg: { proseInstruction?: string }) => {
      void cfg;
      return {
        docModel: { sufficiency: { verdict: { tier: 'directional-estimate' } }, companyName: 'Acme', discountPct: 0 },
        rendered: [{ filename: 'business-case-acme.html', html: '<x/>' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        budgetLog: [],
        gate: { items: [], blocked: false, reasons: [] },
      };
    });
    const launcher = {
      health: async () => true,
      saveArchive: async () => undefined,
      anonymize: async (_m: unknown, text: string) => ({ text, count: 0 }), // no real names in "be concise"
    } as unknown as LauncherClient;
    function Probe() {
      const { state } = useWizard();
      return <span data-testid="mode">{String(!!state.addFilesMode)}</span>;
    }
    render(
      <ErrorProvider>
        <WizardProvider
          launcher={launcher}
          initial={{
            config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 },
            hasApiKey: true,
            bundle: anonBundle,
            anonBundle,
            triage,
            caseId: 'acme-1',
            map: [{ phrase: 'Acme', slug: 'CF_ORG_01' }],
            versions: [{ id: '001', createdAt: 't0', trigger: 'initial', discountPct: 0, docModel: {} as never, rendered: [] }],
            addFilesMode: true,
            pendingRefinement: 'be concise',
          }}
        >
          <Step5Generate />
          <Probe />
        </WizardProvider>
      </ErrorProvider>,
    );
    fireEvent.click(screen.getByText(/Generate deliverables/i));
    await waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    expect((runPipeline.mock.calls[0]![0] as { proseInstruction?: string }).proseInstruction).toBe('be concise'); // carried note applied
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('false')); // add-files flag cleared
  });
});
