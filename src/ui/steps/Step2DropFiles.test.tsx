// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';

// Mock the lazy-imported parsers so the component test exercises drop handling + state, not pdfjs.
const { ingestAsync } = vi.hoisted(() => {
  const fakeBundle = {
    files: [
      { name: 'sizing.csv', type: 'csv', ok: true },
      // a genuinely unsupported file (docx/pptx now extract; legacy .doc does not)
      { name: 'legacy.doc', type: 'doc', ok: false, note: 'legacy Word (.doc) is not read — please re-save as .docx or export to PDF', errorCategory: 'unsupported_format' },
    ],
    primitives: [{ kind: 'table', source: 'sizing.csv', headers: ['x'], rows: [['1']] }],
  };
  return { ingestAsync: vi.fn(async () => fakeBundle) };
});
vi.mock('../../ingest/ingest', () => ({ ingestAsync }));
vi.mock('../../ingest/binary', () => ({ BINARY_EXTRACTORS: {} }));

import { Step2DropFiles } from './Step2DropFiles';
import { WizardProvider, useWizard } from '../WizardContext';
import { ErrorProvider } from '../ErrorContext';
import { ErrorReportDialog } from '../modals/ErrorReportDialog';

function Readout() {
  const { state } = useWizard();
  return (
    <>
      <span data-testid="prims">{state.bundle ? state.bundle.primitives.length : -1}</span>
      <span data-testid="map">{state.map.map((m) => `${m.phrase}=${m.slug}`).join('|')}</span>
    </>
  );
}

describe('Step2DropFiles', () => {
  it('ingests selected files locally, patches the bundle, and shows the per-file report', async () => {
    render(
      <ErrorProvider>
        <WizardProvider>
          <Step2DropFiles />
          <Readout />
        </WizardProvider>
      </ErrorProvider>,
    );
    const file = new File(['x,y\n1,2'], 'sizing.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });

    await waitFor(() => expect(ingestAsync).toHaveBeenCalledTimes(1));
    await screen.findByText(/evidence item\(s\) extracted/i);
    expect(screen.getByText(/sizing\.csv/)).toBeTruthy();
    expect(screen.getByText(/legacy\.doc/)).toBeTruthy(); // unparsed file is still reported (⚠)
    await waitFor(() => expect(screen.getByTestId('prims').textContent).toBe('1')); // bundle patched into state
  });

  it('add-files mode appends to the existing bundle and EXTENDS the map (existing slugs preserved)', async () => {
    ingestAsync.mockResolvedValueOnce({
      files: [{ name: 'extra.txt', type: 'text', ok: true }],
      primitives: [{ kind: 'text', source: 'extra.txt', text: 'New partner Globex Re signed on.' }],
    } as never);
    const existingBundle = { files: [{ name: 'a.csv', type: 'csv', ok: true }], primitives: [{ kind: 'text', source: 'a.csv', text: 'We use Acme Mutual.' }] };
    render(
      <ErrorProvider>
        <WizardProvider
          initial={{
            config: { provider: 'claude', companyName: 'Acme Mutual', tokenBudget: 100_000, discountPct: 0 },
            addFilesMode: true,
            bundle: existingBundle as never,
            detected: [{ phrase: 'Acme Mutual', type: 'org', occurrences: 1, confidence: 1 }],
            map: [{ phrase: 'Acme Mutual', slug: 'CF_ORG_01' }],
          }}
        >
          <Step2DropFiles />
          <Readout />
        </WizardProvider>
      </ErrorProvider>,
    );
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [new File(['x'], 'extra.txt')] } });
    await waitFor(() => expect(ingestAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('prims').textContent).toBe('2')); // 1 existing + 1 appended
    const map = screen.getByTestId('map').textContent ?? '';
    expect(map).toContain('Acme Mutual=CF_ORG_01'); // existing slug PRESERVED (not renumbered)
    expect(map).toContain('Globex Re='); // a new phrase from the added file was mapped
  });

  it('auto-opens the error-report dialog when a dropped file is skipped/unsupported', async () => {
    render(
      <ErrorProvider>
        <WizardProvider>
          <Step2DropFiles />
          <ErrorReportDialog />
        </WizardProvider>
      </ErrorProvider>,
    );
    const file = new File(['x,y\n1,2'], 'sizing.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } });
    // The mocked bundle includes notes.docx (ok:false) → the report dialog should appear automatically.
    await screen.findByRole('dialog');
    expect(screen.getByText(/Send an error report/i)).toBeTruthy();
    expect(screen.getAllByText(/unsupported file format/i).length).toBeGreaterThan(0);
  });
});
