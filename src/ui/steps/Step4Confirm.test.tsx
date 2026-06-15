// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Step4Confirm } from './Step4Confirm';
import { WizardProvider, useWizard } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import type { TriageResult } from '../../classify/types';
import type { WizardState } from '../state';
import type { EvidenceBundle, KeyValuePrimitive, TablePrimitive, FileReport } from '../../ingest/types';

// Spy on the classify orchestrator's triage() so the back-nav test can assert it is NOT re-invoked
// when a cached triage is already in state. mergeBindings/toSizingInputs (used by applyGateAnswers in
// orchestrate/gate) keep their real implementations so the live verdict + confirm path stay genuine.
const { triageSpy } = vi.hoisted(() => ({ triageSpy: vi.fn() }));
vi.mock('../../classify/triage', async (importActual) => {
  const actual = await importActual<typeof import('../../classify/triage')>();
  // By default delegate to the real heuristic triage so the existing fresh-mount tests are unchanged;
  // the back-nav test asserts the spy is never called (cached triage is reused instead).
  triageSpy.mockImplementation((...args: Parameters<typeof actual.triage>) =>
    // Delegate to the real heuristic triage when invoked with a bundle+profile (the fresh-mount tests);
    // ignore stray no-arg invocations from test-runner cleanup hooks (they would otherwise reject).
    args[0] && args[1] ? actual.triage(...args) : Promise.resolve({ result: { profileId: '', inventory: [], bindings: [] }, usage: { inputTokens: 0, outputTokens: 0 } }),
  );
  return { ...actual, triage: triageSpy };
});

// Heuristic-bindable evidence (keyvalue + table) → triage binds everything WITHOUT an LLM call.
const topology: KeyValuePrimitive = { kind: 'keyvalue', source: 'topology.txt', pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16', 'storage size': '45800' } };
const utilTable: TablePrimitive = {
  kind: 'table',
  source: 'metrics.csv',
  headers: ['timestamp', 'System CPU', 'Secondary CPU', 'DR CPU'],
  rows: [
    ['2026-01-01T00:00Z', '4', '0', '1'],
    ['2026-01-01T01:00Z', '5', '1', '3'],
    ['2026-01-01T02:00Z', '45', '35', '20'],
  ],
};
const files: FileReport[] = [
  { name: 'topology.txt', type: 'text', ok: true },
  { name: 'metrics.csv', type: 'csv', ok: true },
];
const full: EvidenceBundle = { primitives: [topology, utilTable], files };
const topologyOnly: EvidenceBundle = { primitives: [topology], files: [files[0]!] };
const noStorageTopology: KeyValuePrimitive = { kind: 'keyvalue', source: 'topology.txt', pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16' } };
const utilNoStorage: EvidenceBundle = { primitives: [noStorageTopology, utilTable], files };

function Readout() {
  const { state } = useWizard();
  return (
    <>
      <span data-testid="confirmed">{String(state.confirmed)}</span>
      {/* test-only: gateAnswers serialized to the DOM for assertion; Readout is never rendered in production */}
      <span data-testid="answers">{JSON.stringify(state.gateAnswers)}</span>
    </>
  );
}

function setup(anonBundle: EvidenceBundle) {
  return render(
    <ErrorProvider>
      <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, anonBundle }}>
        <Step4Confirm />
        <Readout />
      </WizardProvider>
    </ErrorProvider>,
  );
}

/** Render Step 4 with arbitrary pre-seeded state (used for the back-nav / cached-triage case). */
function renderStep4(initial: Partial<WizardState>) {
  return render(
    <ErrorProvider>
      <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, anonBundle: full, ...initial }}>
        <Step4Confirm />
        <Readout />
      </WizardProvider>
    </ErrorProvider>,
  );
}

/** A fully-bound cached triage (discovered hoVcpu = 32) — the result a rep carries back on a back-nav. */
function cachedTriage(): TriageResult {
  const b = (signalId: string, value: TriageResult['bindings'][number]['value'], method: TriageResult['bindings'][number]['method']) =>
    ({ signalId, value, confidence: 1, method, evidence: [{ source: 'topology.txt', primitiveKind: 'keyvalue' as const }] });
  return {
    profileId: 'mongodb',
    inventory: [],
    qualContext: { items: [] },
    bindings: [
      b('cluster.shardCount', 3, 'keyvalue'),
      b('node.hoVcpu', 32, 'keyvalue'),
      b('node.drVcpu', 16, 'keyvalue'),
      b('data.storageSizeGb', 45_800, 'keyvalue'),
      b('util.primary', { avgPct: 0.18, peakPct: 0.45 }, 'numeric-series'),
      b('util.hoSec', { avgPct: 0.05, peakPct: 0.35 }, 'numeric-series'),
      b('util.dr', { avgPct: 0.02, peakPct: 0.2 }, 'numeric-series'),
    ],
  };
}

beforeEach(() => triageSpy.mockClear());

describe('Step4Confirm', () => {
  it('classifies the anonymized evidence, prefills every required metric row, and confirms', async () => {
    setup(full);
    await screen.findByText('ENGINEERING-GRADE');
    // every required signal renders as an editable row prefilled with the discovered value
    const shardInput = screen.getByTestId('metric-input-cluster.shardCount') as HTMLInputElement;
    expect(shardInput.value).toBe('3');
    const storageInput = screen.getByTestId('metric-input-data.storageSizeGb') as HTMLInputElement;
    expect(storageInput.value).toBe('45800');
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    expect(screen.getByText(/click Next to generate/i)).toBeTruthy();
  });

  it('shows a BLOCKED verdict + empty inputs on missing required rows, and refuses to confirm', async () => {
    setup(topologyOnly);
    await screen.findByText('BLOCKED');
    // the missing utilization signals render as required rows with empty avg/peak inputs + collect guidance
    const avgInputs = screen.getAllByPlaceholderText('avg %') as HTMLInputElement[];
    expect(avgInputs.length).toBeGreaterThan(0);
    expect(avgInputs.every((i) => i.value === '')).toBe(true);
    expect(screen.getByText(/Average AND peak System-CPU % on the primaries/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await screen.findByText(/still blocked/i);
    expect(screen.getByTestId('confirmed').textContent).toBe('false');
  });

  it('records a typed storage figure as a rep-entered gate answer (no confirmed field), then proceeds', async () => {
    setup(utilNoStorage);
    await screen.findByText('BLOCKED'); // storage missing -> blocked until entered
    const storageInput = (await screen.findByTestId('metric-input-data.storageSizeGb')) as HTMLInputElement;
    expect(storageInput.value).toBe(''); // missing signal -> no prefill
    fireEvent.input(storageInput, { target: { value: '45800' } });
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    const answers = JSON.parse(screen.getByTestId('answers').textContent!);
    const storage = answers.find((a: { signalId: string }) => a.signalId === 'data.storageSizeGb');
    expect(storage).toMatchObject({ value: 45800 }); // rep-entered gate answer (Policy B demotes tier)
    expect(storage).not.toHaveProperty('confirmed'); // confirmed flag dropped in uniform model
  });

  it('adjusting a discovered metric drops the verdict to Directional, and revert restores it', async () => {
    setup(full);
    await screen.findByText('ENGINEERING-GRADE');
    const input = screen.getByTestId('metric-input-cluster.shardCount');
    fireEvent.input(input, { target: { value: '5' } });
    await screen.findByText('DIRECTIONAL ESTIMATE');
    fireEvent.input(input, { target: { value: '' } }); // revert
    await screen.findByText('ENGINEERING-GRADE');
  });

  it('shows a collapsible Additional Metrics section', async () => {
    setup(full);
    await screen.findByText('ENGINEERING-GRADE');
    expect(screen.getByText(/Additional Metrics/i)).toBeTruthy();
  });

  it('un-confirms when a metric is edited after confirming, so the edit is not dropped from the run', async () => {
    setup(full);
    await screen.findByText('ENGINEERING-GRADE');
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    fireEvent.input(screen.getByTestId('metric-input-cluster.shardCount'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('false'));
  });

  it('the storage row has a compression toggle that emits a storageCompressionState gate answer', async () => {
    setup(full);
    await screen.findByText(/ENGINEERING-GRADE|DIRECTIONAL/);
    const toggle = screen.getByTestId('storage-compression-toggle');
    fireEvent.change(toggle, { target: { value: 'compressed' } });
    fireEvent.click(screen.getByText(/Confirm & continue/i)); // gateAnswers is patched on confirm
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    const answers = JSON.parse(screen.getByTestId('answers').textContent!);
    expect(answers.some((a: { signalId: string }) => a.signalId === 'data.storageCompressionState')).toBe(true);
    const comp = answers.find((a: { signalId: string }) => a.signalId === 'data.storageCompressionState');
    expect(comp).toMatchObject({ value: 'compressed' });
  });

  it('toggling storage compression to compressed and back round-trips the effective size (answer bound then reverted)', async () => {
    // The companion is recommended (not required), so it never changes the verdict TIER on its own; what it
    // changes is the EFFECTIVE on-disk GB the engine computes (uncompressed is divided by the Oracle factor,
    // compressed is used as-is). Binding then unbinding the companion lands the effective size back at baseline.
    setup(full);
    await screen.findByText('ENGINEERING-GRADE');
    const toggle = screen.getByTestId('storage-compression-toggle') as HTMLSelectElement;
    expect(toggle.value).toBe('uncompressed'); // default-when-unbound
    fireEvent.change(toggle, { target: { value: 'compressed' } });
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    let answers = JSON.parse(screen.getByTestId('answers').textContent!);
    expect(answers.find((a: { signalId: string }) => a.signalId === 'data.storageCompressionState')).toMatchObject({ value: 'compressed' });
    // back to the default -> the override is dropped, so the effective size returns to where it started
    fireEvent.change(toggle, { target: { value: 'uncompressed' } });
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    answers = JSON.parse(screen.getByTestId('answers').textContent!);
    expect(answers.find((a: { signalId: string }) => a.signalId === 'data.storageCompressionState')).toBeUndefined();
  });

  it('returning an edit to the discovered value also reverts (no answer recorded)', async () => {
    setup(full);
    await screen.findByText('ENGINEERING-GRADE');
    const input = screen.getByTestId('metric-input-cluster.shardCount');
    fireEvent.input(input, { target: { value: '5' } });
    await screen.findByText('DIRECTIONAL ESTIMATE');
    fireEvent.input(input, { target: { value: '3' } }); // back to discovered (3 in the full bundle)
    await screen.findByText('ENGINEERING-GRADE');
    const answers = JSON.parse(screen.getByTestId('answers').textContent!);
    expect(answers.find((a: { signalId: string }) => a.signalId === 'cluster.shardCount')).toBeUndefined();
  });

  it('re-seeds prior adjustments on remount and a re-confirm preserves them (no wipe on back-nav)', async () => {
    // Simulate a back-nav: triage already cached AND a prior gate answer the rep made (hoVcpu 32 -> 64),
    // confirmed earlier. The component must seed from gateAnswers, reuse the cached triage (no re-classify),
    // and a re-confirm without re-typing must NOT wipe the prior override.
    const triage = cachedTriage();
    renderStep4({ triage, gateAnswers: [{ signalId: 'node.hoVcpu', value: 64 }], confirmed: true });

    // (a) the seeded override displays in its row (discovered hoVcpu is 32; the seeded answer is 64).
    const hoVcpuInput = (await screen.findByTestId('metric-input-node.hoVcpu')) as HTMLInputElement;
    expect(hoVcpuInput.value).toBe('64');
    // (b) the cached triage was reused — triage() was NOT re-invoked on this mount.
    expect(triageSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Classifying the anonymized evidence/i)).toBeNull(); // no loading spinner

    // (c) re-confirming without touching anything keeps the prior override in gateAnswers (no wipe).
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    const answers = JSON.parse(screen.getByTestId('answers').textContent!);
    expect(answers).toEqual([{ signalId: 'node.hoVcpu', value: 64 }]);
  });
});
