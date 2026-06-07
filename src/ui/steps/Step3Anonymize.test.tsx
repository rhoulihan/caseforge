// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dynamically-imported browser redaction module (real one needs tesseract WASM + canvas).
// scanImagesForText() uses recognizeWords (detection-time OCR); anonymizeAll() uses redactImageInBrowser.
const { redactImageInBrowser, recognizeWords } = vi.hoisted(() => ({
  redactImageInBrowser: vi.fn(
    async (
      ...args: [img: { bytes: Uint8Array; mime: string }, map: unknown, company: string, precomputed?: unknown]
    ): Promise<{ bytes: Uint8Array; mime: string; rectCount: number; meanConfidence: number; redacted: boolean; warning?: string }> => ({
      bytes: new Uint8Array([9, 9, 9]),
      mime: args[0].mime,
      rectCount: 2,
      meanConfidence: 88,
      redacted: true,
    }),
  ),
  // OCR returns a hostname that exists ONLY inside the image — it must surface as a reviewable mapping.
  recognizeWords: vi.fn(async () => ({
    words: 'Cluster host db.prod.acme.local p99 latency'.split(' ').map((text, i) => ({ text, bbox: { x0: i, y0: 0, x1: i + 1, y1: 1 }, confidence: 90, line: 0 })),
    meanConfidence: 90,
  })),
}));
vi.mock('../../redaction/browser', () => ({ redactImageInBrowser, recognizeWords }));

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

describe('Step3Anonymize — image redaction', () => {
  // A bundle (not just an anonBundle) is required: scanning OCRs the ORIGINAL image bytes.
  const imageBundle: EvidenceBundle = {
    files: [{ name: 'deck.pptx', type: 'pptx', ok: true }],
    primitives: [
      { kind: 'text', source: 'brief.txt', text: 'We engaged Acme Mutual for the migration.' },
      { kind: 'image', source: 'deck.pptx#image1.png', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    ],
  };

  function ReviewedReadout() {
    const { state } = useWizard();
    return <span data-testid="reviewed">{String(state.imagesReviewed)}</span>;
  }

  function setupImages() {
    return render(
      <ErrorProvider>
        <WizardProvider
          initial={{ config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle: imageBundle }}
          launcher={mockLauncher}
        >
          <Step3Anonymize />
          <ReviewedReadout />
        </WizardProvider>
      </ErrorProvider>,
    );
  }

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    redactImageInBrowser.mockClear();
    recognizeWords.mockClear();
  });

  it('gates anonymize until images are scanned for hidden text', async () => {
    setupImages();
    await screen.findByText('Acme Mutual'); // text detection ran on mount
    const anonBtn = screen.getByRole('button', { name: /Anonymize & continue/i }) as HTMLButtonElement;
    expect(anonBtn.disabled).toBe(true); // image present but not yet scanned → blocked
    expect(screen.getByText(/Scan the 1 image\(s\) below first/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Scan 1 image\(s\) for hidden text/i })).toBeTruthy();
  });

  it('OCRs images, folds hidden PII into the rep-approved map, then unblocks anonymize', async () => {
    setupImages();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Scan 1 image\(s\) for hidden text/i }));
    await waitFor(() => expect(recognizeWords).toHaveBeenCalledTimes(1));
    // The hostname that appears ONLY inside the image is now a reviewable mapping entry, badged to its source.
    await screen.findByText('db.prod.acme.local');
    expect(screen.getByText(/from\s+image1\.png/i)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /Anonymize & continue/i }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('redacts each image reusing the cached OCR, shows previews, and marks them reviewed', async () => {
    setupImages();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Scan 1 image\(s\) for hidden text/i }));
    await screen.findByText('db.prod.acme.local'); // scan finished
    fireEvent.click(screen.getByRole('button', { name: /Anonymize & continue/i }));
    await waitFor(() => expect(redactImageInBrowser).toHaveBeenCalledTimes(1));
    expect(redactImageInBrowser.mock.calls[0]?.[3]).toBeDefined(); // precomputed OCR words reused — no double scan
    await screen.findByText(/region\(s\) blacked out/i); // redacted preview caption (rectCount = 2)
    await waitFor(() => expect(screen.getByTestId('reviewed').textContent).toBe('true'));
  });
});

describe('Step3Anonymize — image failure & multi-image paths', () => {
  // Two images that SHARE a source — proves identity is keyed by index, not source.
  const twoImageBundle: EvidenceBundle = {
    files: [{ name: 'deck.pptx', type: 'pptx', ok: true }],
    primitives: [
      { kind: 'text', source: 'brief.txt', text: 'We engaged Acme Mutual.' },
      { kind: 'image', source: 'dup.png', mime: 'image/png', bytes: new Uint8Array([1]) },
      { kind: 'image', source: 'dup.png', mime: 'image/png', bytes: new Uint8Array([2]) },
    ],
  };

  function AnonImageCount() {
    const { state } = useWizard();
    return <span data-testid="anon-imgs">{state.anonBundle ? state.anonBundle.primitives.filter((p) => p.kind === 'image').length : -1}</span>;
  }

  function setupTwo() {
    return render(
      <ErrorProvider>
        <WizardProvider
          initial={{ config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 0 }, hasApiKey: true, bundle: twoImageBundle }}
          launcher={mockLauncher}
        >
          <Step3Anonymize />
          <AnonImageCount />
        </WizardProvider>
      </ErrorProvider>,
    );
  }

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    redactImageInBrowser.mockClear();
    recognizeWords.mockClear();
  });

  it('one image failing OCR does not block the rest: the failure is surfaced and anonymize still unblocks', async () => {
    recognizeWords.mockRejectedValueOnce(new Error('worker boom')); // first image's OCR throws
    setupTwo();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Scan 2 image\(s\) for hidden text/i }));
    await waitFor(() => expect(recognizeWords).toHaveBeenCalledTimes(2)); // both attempted
    await screen.findByText(/1 of 2 image\(s\) could not be read/i); // honest failure message, not a false success
    await screen.findByText('db.prod.acme.local'); // the image that DID scan still folded its text in
    expect((screen.getByRole('button', { name: /Anonymize & continue/i }) as HTMLButtonElement).disabled).toBe(false); // gate still satisfied
  });

  it('renders the per-image warning when redaction returns one', async () => {
    redactImageInBrowser.mockResolvedValueOnce({ bytes: new Uint8Array([9]), mime: 'image/png', rectCount: 0, meanConfidence: 40, redacted: false, warning: 'low confidence — eyeball this' });
    setupTwo();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Scan 2 image\(s\) for hidden text/i }));
    await screen.findByText('db.prod.acme.local');
    fireEvent.click(screen.getByRole('button', { name: /Anonymize & continue/i }));
    await screen.findByText(/low confidence — eyeball this/i); // warning surfaced on the preview card
  });

  it('excluding one of two same-source images drops only that image from the bundle (index-keyed)', async () => {
    setupTwo();
    await screen.findByText('Acme Mutual');
    fireEvent.click(screen.getByRole('button', { name: /Scan 2 image\(s\) for hidden text/i }));
    await screen.findByText('db.prod.acme.local');
    fireEvent.click(screen.getByRole('button', { name: /Anonymize & continue/i }));
    await waitFor(() => expect(screen.getByTestId('anon-imgs').textContent).toBe('2')); // both images in the bundle
    const sendBoxes = screen.getAllByLabelText(/send this image to the AI/i);
    expect(sendBoxes).toHaveLength(2);
    fireEvent.click(sendBoxes[0]!); // exclude the first image only
    await waitFor(() => expect(screen.getByTestId('anon-imgs').textContent).toBe('1')); // exactly one dropped, not both
  });
});
