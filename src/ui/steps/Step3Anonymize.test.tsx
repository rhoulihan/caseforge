// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Step3Anonymize } from './Step3Anonymize';
import { WizardProvider, useWizard } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import type { LauncherClient } from '../../launcher/client';
import type { EvidenceBundle } from '../../ingest/types';

// Fake launcher: replaces the literal company phrase with its slug (stands in for the Go endpoint).
const mockLauncher = {
  async anonymize(_map: unknown, text: string) {
    return { text: text.replace(/Acme Mutual/g, 'CF_ORG_01'), count: 1 };
  },
  async deanonymize(_map: unknown, text: string) {
    return { text, count: 0 };
  },
  async health() {
    return true;
  },
} as unknown as LauncherClient;

const bundle: EvidenceBundle = {
  files: [{ name: 'brief.txt', type: 'text', ok: true }],
  primitives: [{ kind: 'text', source: 'brief.txt', text: 'We engaged Acme Mutual for the migration.' }],
};

function Readout() {
  const { state } = useWizard();
  const t = state.anonBundle?.primitives.find((p) => p.kind === 'text');
  return <span data-testid="anon">{t && t.kind === 'text' ? t.text : 'none'}</span>;
}

function setup() {
  return render(
    <ErrorProvider>
      <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000 }, hasApiKey: true, bundle }} launcher={mockLauncher}>
        <Step3Anonymize />
        <Readout />
      </WizardProvider>
    </ErrorProvider>,
  );
}

describe('Step3Anonymize', () => {
  it('detects the company phrase locally and lists it in the map', async () => {
    setup();
    await screen.findByText('Acme Mutual'); // detected on mount
    expect(screen.getByText('CF_ORG_01')).toBeTruthy(); // suggested slug
  });

  it('anonymizes text primitives through the launcher (real text → slug)', async () => {
    setup();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByText(/Anonymize & continue/i));
    await waitFor(() => expect(screen.getByTestId('anon').textContent).toContain('CF_ORG_01'));
    expect(screen.getByTestId('anon').textContent).not.toContain('Acme Mutual'); // real phrase gone
    await screen.findByText(/real text will never reach the AI/i);
  });

  it('lets the rep remove a false positive and add a missed phrase', async () => {
    setup();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByLabelText('Remove Acme Mutual'));
    await waitFor(() => expect(screen.queryByText('Acme Mutual')).toBeNull());
    fireEvent.input(screen.getByLabelText('Add phrase'), { target: { value: 'Project Atlas' } });
    fireEvent.click(screen.getByText('Add', { selector: 'button' }));
    expect(screen.getByText('Project Atlas')).toBeTruthy();
  });
});
