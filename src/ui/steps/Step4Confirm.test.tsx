// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Step4Confirm } from './Step4Confirm';
import { WizardProvider, useWizard } from '../WizardContext';
import type { EvidenceBundle, KeyValuePrimitive, TablePrimitive, FileReport } from '../../ingest/types';

// Heuristic-bindable evidence (keyvalue + table) → triage binds everything WITHOUT an LLM call.
const topology: KeyValuePrimitive = { kind: 'keyvalue', source: 'topology.txt', pairs: { shards: '3', 'cores per node': '32', 'dr cores': '16' } };
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

function Readout() {
  const { state } = useWizard();
  return <span data-testid="confirmed">{String(state.confirmed)}</span>;
}

function setup(anonBundle: EvidenceBundle) {
  return render(
    <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme', tokenBudget: 100_000 }, hasApiKey: true, anonBundle }}>
      <Step4Confirm />
      <Readout />
    </WizardProvider>,
  );
}

describe('Step4Confirm', () => {
  it('classifies the anonymized evidence, shows an engineering-grade verdict, and confirms', async () => {
    setup(full);
    await screen.findByText('ENGINEERING-GRADE');
    expect(screen.getByText(/all required signals are covered/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await waitFor(() => expect(screen.getByTestId('confirmed').textContent).toBe('true'));
    expect(screen.getByText(/click Next to generate/i)).toBeTruthy();
  });

  it('shows a BLOCKED verdict + gate items when a required signal is missing, and refuses to confirm', async () => {
    setup(topologyOnly);
    await screen.findByText('BLOCKED');
    // a gate item for the missing utilization signal is rendered
    expect(screen.getAllByText(/confirm a real measurement/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(/Confirm & continue/i));
    await screen.findByText(/still blocked/i);
    expect(screen.getByTestId('confirmed').textContent).toBe('false');
  });
});
