// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle }} launcher={mockLauncher}>
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
    await screen.findByText(/will never reach the AI/i);
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

describe('Step3Anonymize — images sent as-is (no scrubbing)', () => {
  const imageBundle: EvidenceBundle = {
    files: [{ name: 'deck.pptx', type: 'pptx', ok: true }],
    primitives: [
      { kind: 'text', source: 'brief.txt', text: 'We engaged Acme Mutual for the migration.' },
      { kind: 'image', source: 'deck.pptx#image1.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    ],
  };

  function AckReadout() {
    const { state } = useWizard();
    return <span data-testid="ack">{`${state.imageReviewKeys.length}/${state.imageAcknowledgedIds.length}`}</span>;
  }

  function setupImages() {
    return render(
      <ErrorProvider>
        <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle: imageBundle }} launcher={mockLauncher}>
          <Step3Anonymize />
          <AckReadout />
        </WizardProvider>
      </ErrorProvider>,
    );
  }

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
  });

  it('shows the responsibility warning and does NOT gate anonymize on any scan', async () => {
    setupImages();
    await screen.findByText('Acme Mutual');
    expect(screen.getByText(/scrub text inside images/i)).toBeTruthy(); // rep-responsibility warning
    expect((screen.getByRole('button', { name: /Anonymize & continue/i }) as HTMLButtonElement).disabled).toBe(false); // no scan gate
  });

  it('anonymizes text and surfaces each image preview as-is for review', async () => {
    setupImages();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Anonymize & continue/i }));
    await screen.findByAltText(/preview of deck.pptx#image1.png/i); // the image is shown unmodified
    expect(screen.getByTestId('ack').textContent).toBe('1/0'); // one image to review, none acknowledged yet
  });

  it('requires acknowledging each image to be sent before continuing (D2)', async () => {
    setupImages();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Anonymize & continue/i }));
    await screen.findByAltText(/preview of deck/i);
    expect(screen.getByText(/0 of 1 image\(s\) acknowledged/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/acknowledge deck/i));
    await waitFor(() => expect(screen.getByTestId('ack').textContent).toBe('1/1'));
    await screen.findByText(/All 1 image\(s\) to be sent have been reviewed/i);
  });
});

describe('Step3Anonymize — exclusion (index-keyed, same-source safe)', () => {
  // Two images that SHARE a source — proves identity is keyed by index, not source.
  const twoImageBundle: EvidenceBundle = {
    files: [{ name: 'deck.pptx', type: 'pptx', ok: true }],
    primitives: [
      { kind: 'text', source: 'brief.txt', text: 'We engaged Acme Mutual.' },
      { kind: 'image', source: 'dup.png', mime: 'image/png', bytes: new Uint8Array([1]) },
      { kind: 'image', source: 'dup.png', mime: 'image/png', bytes: new Uint8Array([2]) },
    ],
  };

  function Probe() {
    const { state } = useWizard();
    const imgs = state.anonBundle ? state.anonBundle.primitives.filter((p) => p.kind === 'image').length : -1;
    return <span data-testid="probe">{`${imgs}|${state.imageReviewKeys.length}`}</span>;
  }

  function setupTwo() {
    return render(
      <ErrorProvider>
        <WizardProvider initial={{ config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle: twoImageBundle }} launcher={mockLauncher}>
          <Step3Anonymize />
          <Probe />
        </WizardProvider>
      </ErrorProvider>,
    );
  }

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
  });

  it('excluding one of two same-source images drops only that image from the bundle AND the ack gate', async () => {
    setupTwo();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Anonymize & continue/i }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('2|2')); // both images sent + both need ack
    const sendBoxes = screen.getAllByLabelText(/send this image to the AI/i);
    expect(sendBoxes).toHaveLength(2);
    fireEvent.click(sendBoxes[0]!); // exclude the first image only
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('1|1')); // exactly one dropped from both
  });
});
