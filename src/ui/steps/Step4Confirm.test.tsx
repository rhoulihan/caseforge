// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Step4Confirm } from './Step4Confirm';
import { WizardProvider, useWizard } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import type { EvidenceBundle, KeyValuePrimitive, TablePrimitive, FileReport } from '../../ingest/types';

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
});
